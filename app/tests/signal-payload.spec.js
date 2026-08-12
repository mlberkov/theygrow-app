'use strict';

// No signal payload can carry family text (L1-P4).
//
// WHAT THIS PACKET IS ACTUALLY DOING, said here because the handoff called it a
// deferred lint and it is not one: there was no client-side signal surface to
// lint. `emitted_now` existed only in api/theygrow_api/signals.py, which belongs
// to the server side this milestone does not touch, and the only telemetry in
// app/ is the GA4 shim inlined in index.html. So L1-P4 CREATES the surface, and
// this file is the guard that ships with it.
//
// The guard has two halves, and the structural half is the load-bearing one:
//
//   runtime   emitSignal() refuses any value that is not a number, a boolean,
//             null, or a member of that field's declared closed code list. There
//             is no code path that accepts a free string, so a payload cannot
//             carry family text even if a caller tries.
//   source    every emitSignal() call site in the shipped surface names a
//             declared kind with literal keys, and no value expression reaches
//             for an identifier that holds family text.
//
// AND ONE MORE THING THIS FILE PINS. The surface's only sink is the device
// console. Giving it a network leg is an owner decision on the escalation list
// (PDR-027 §2 — egress), so the absence of one is asserted rather than assumed.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { shippedPaths, expandShippedFiles } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SIGNALS_JS = path.join(APP_ROOT, 'm', 'v1', 'core', 'signals.js');

const dynamicImport = new Function('specifier', 'return import(specifier)');

// Every shipped JavaScript module, so the scan cannot miss an emitter by living
// in a directory nobody thought to list.
const SHIPPED_JS = expandShippedFiles(
    shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
    APP_ROOT
).filter((urlPath) => urlPath.endsWith('.js'));

const sourceOf = (urlPath) =>
    fs.readFileSync(path.join(APP_ROOT, urlPath.replace(/^\//, '')), 'utf8');

// Identifiers that hold, or plausibly hold, something a family wrote or something
// that names a child. A signal value must never be derived from one of these.
const FAMILY_TEXT = [
    'name',
    'title',
    'body',
    'text',
    'quote',
    'birthdate',
    'value',
    'profile',
    'child',
    'skill',
    'message',
    'note',
];

let signals = null;

test.beforeAll(async () => {
    // The shipped module is import-safe off the browser by the same rule the
    // store modules follow, so it is loaded directly rather than copied.
    signals = await dynamicImport(pathToFileURL(SIGNALS_JS).href);
});

test.describe('the taxonomy is declared, closed and frozen', () => {
    test('every kind declares its fields, its stage and whether it is emitted now', async () => {
        const { SIGNAL_TAXONOMY } = signals;
        const kinds = Object.keys(SIGNAL_TAXONOMY);
        expect(kinds.length, 'a taxonomy with no kinds would pass every test below').toBeGreaterThan(
            0
        );
        for (const kind of kinds) {
            const descriptor = SIGNAL_TAXONOMY[kind];
            expect(Array.isArray(descriptor.fields), `${kind} declares no fields`).toBe(true);
            expect(descriptor.fields.length, `${kind} declares an empty field list`).toBeGreaterThan(
                0
            );
            expect(typeof descriptor.producingStage).toBe('string');
            expect(typeof descriptor.emittedNow).toBe('boolean');
            expect(Object.isFrozen(descriptor), `${kind} is mutable`).toBe(true);
        }
        expect(Object.isFrozen(SIGNAL_TAXONOMY)).toBe(true);
    });

    test('every knob and every kind carries its changed_in provenance (ADR-013)', async () => {
        const source = fs.readFileSync(SIGNALS_JS, 'utf8');
        const declared = Object.keys(signals.SIGNAL_TAXONOMY).length;
        expect(
            (source.match(/changed_in:/g) ?? []).length,
            'one provenance marker per declared kind, at least'
        ).toBeGreaterThanOrEqual(declared);
    });

    test('every field is covered by a closed code list or is a number or a boolean', async () => {
        const { SIGNAL_TAXONOMY, SIGNAL_CODES } = signals;
        for (const [kind, descriptor] of Object.entries(SIGNAL_TAXONOMY)) {
            for (const field of descriptor.fields) {
                const coded = Object.prototype.hasOwnProperty.call(SIGNAL_CODES, field);
                const numeric = /_(ms|count|version)$/.test(field) || descriptor.numeric?.includes(field);
                const boolean = descriptor.boolean?.includes(field);
                expect(
                    coded || numeric || boolean,
                    `${kind}.${field} is neither coded nor declared numeric/boolean, so nothing`
                        + ' constrains what a caller can put in it'
                ).toBe(true);
            }
        }
        expect(Object.isFrozen(SIGNAL_CODES)).toBe(true);
    });
});

test.describe('the payload guard refuses what it cannot prove safe', () => {
    const refusalCases = [
        ['an undeclared kind', 'store.exploded', { outcome: 'opened' }],
        ['an undeclared field', 'store.open', { child_name: 1 }],
        ['a free-text string', 'store.open', { outcome: 'Мия залезла на диван' }],
        ['a nested object', 'store.open', { outcome: { code: 'opened' } }],
        ['an array', 'store.open', { outcome: ['opened'] }],
        ['an undefined value', 'store.open', { outcome: undefined }],
        ['a function', 'store.open', { outcome: () => 'opened' }],
    ];

    for (const [label, kind, payload] of refusalCases) {
        test(`${label} is refused and nothing is emitted`, async () => {
            const { emitSignal, signalRefusals } = signals;
            const before = signalRefusals();
            const emitted = emitSignal(kind, payload, { sink: () => {
                throw new Error('a refused signal reached the sink');
            } });
            expect(emitted, `${label} was accepted`).toBe(false);
            expect(signalRefusals(), 'a refusal is counted rather than swallowed silently').toBe(
                before + 1
            );
        });
    }

    test('a declared kind with declared, coded values is emitted', async () => {
        const { emitSignal } = signals;
        const seen = [];
        expect(
            emitSignal('store.open', { outcome: 'opened', open_ms: 42 }, { sink: (line) => seen.push(line) })
        ).toBe(true);
        expect(seen).toHaveLength(1);
        expect(String(seen[0])).toContain('store.open');
    });

    test('emitSignal never throws outward — a telemetry bug must not take the write path down', async () => {
        const { emitSignal } = signals;
        expect(() => emitSignal('store.open', { outcome: 'опять всё сломалось' })).not.toThrow();
        expect(() =>
            emitSignal('store.open', { outcome: 'opened' }, {
                sink: () => {
                    throw new Error('the console is gone');
                },
            })
        ).not.toThrow();
    });

    test('anti-vacuity: the guard is not simply refusing everything', async () => {
        const { emitSignal, SIGNAL_TAXONOMY } = signals;
        let accepted = 0;
        for (const [kind, descriptor] of Object.entries(SIGNAL_TAXONOMY)) {
            const payload = {};
            for (const field of descriptor.fields) {
                const codes = signals.SIGNAL_CODES[field];
                payload[field] = codes ? codes[0] : (descriptor.boolean?.includes(field) ? true : 1);
            }
            if (emitSignal(kind, payload, { sink: () => {} })) accepted += 1;
        }
        expect(accepted, 'every declared kind must be emittable with its own declared codes').toBe(
            Object.keys(SIGNAL_TAXONOMY).length
        );
    });
});

test.describe('every emitter in the shipped surface is provably payload-safe', () => {
    const CALL = /emitSignal\(\s*([^)]*?)\s*\)/gs;

    const callSites = () => {
        const found = [];
        for (const urlPath of SHIPPED_JS) {
            const source = sourceOf(urlPath);
            if (urlPath.endsWith('/core/signals.js')) continue;
            for (const match of source.matchAll(CALL)) {
                found.push({ urlPath, argument: match[1] });
            }
        }
        return found;
    };

    test('the scan reaches the shipped surface at all', () => {
        expect(SHIPPED_JS.length, 'the ship list found no JavaScript').toBeGreaterThan(10);
        expect(
            SHIPPED_JS.some((p) => p.endsWith('/core/signals.js')),
            'the taxonomy module itself must be shipped, or nothing can emit'
        ).toBe(true);
        expect(callSites().length, 'a declared surface with no emitter is a dead surface').toBeGreaterThan(
            0
        );
    });

    test('every call names a declared kind with a string literal', () => {
        const declared = Object.keys(signals.SIGNAL_TAXONOMY);
        for (const { urlPath, argument } of callSites()) {
            const kind = argument.match(/^'([^']+)'/);
            expect(kind, `${urlPath}: emitSignal is called with a non-literal kind`).not.toBe(null);
            expect(declared, `${urlPath}: "${kind[1]}" is not in the taxonomy`).toContain(kind[1]);
        }
    });

    test('every payload key is a literal, and declared for that kind', () => {
        const { SIGNAL_TAXONOMY } = signals;
        for (const { urlPath, argument } of callSites()) {
            const kind = argument.match(/^'([^']+)'/)[1];
            const payload = argument.slice(argument.indexOf(',') + 1).trim();
            if (!payload.startsWith('{')) {
                throw new Error(`${urlPath}: the payload for "${kind}" is not an object literal`);
            }
            for (const [, key] of payload.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
                expect(
                    SIGNAL_TAXONOMY[kind].fields,
                    `${urlPath}: "${key}" is not declared for ${kind}`
                ).toContain(key);
            }
        }
    });

    test('no payload value is derived from something that holds family text', () => {
        for (const { urlPath, argument } of callSites()) {
            const payload = argument.slice(argument.indexOf(',') + 1);
            // Only the value halves — a declared FIELD may legitimately be named
            // `name` one day; a VALUE may never come from one.
            const values = [...payload.matchAll(/:\s*([^,}]+)/g)].map((m) => m[1]);
            for (const value of values) {
                for (const identifier of FAMILY_TEXT) {
                    expect(
                        value.toLowerCase(),
                        `${urlPath}: a signal value reads from "${identifier}"`
                    ).not.toMatch(new RegExp(`\\b${identifier}\\b`));
                }
            }
        }
    });
});

test.describe('the surface has no network leg, and gaining one is an owner decision', () => {
    test('nothing in the taxonomy module can reach the network', () => {
        const source = fs.readFileSync(SIGNALS_JS, 'utf8');
        for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'gtag', 'trackEvent']) {
            expect(source, `the signal surface reaches for ${forbidden}`).not.toContain(forbidden);
        }
    });

    test('the module says so in its own docstring, so a later packet cannot add one quietly', () => {
        const source = fs.readFileSync(SIGNALS_JS, 'utf8');
        const header = source.slice(0, source.indexOf('export'));
        expect(header).toMatch(/console/i);
        expect(header, 'the escalation is named where the next author will read it').toMatch(
            /owner decision|escalation|PDR-027/i
        );
    });

    test('no emitter routes a signal into the analytics shim', () => {
        for (const urlPath of SHIPPED_JS) {
            const source = sourceOf(urlPath);
            if (!source.includes('emitSignal')) continue;
            const lines = source.split('\n').filter((line) => line.includes('emitSignal'));
            for (const line of lines) {
                expect(line, `${urlPath}: a signal is being handed to analytics`).not.toContain(
                    'trackEvent'
                );
            }
        }
    });
});
