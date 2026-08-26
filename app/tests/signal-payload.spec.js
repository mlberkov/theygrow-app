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
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { shippedPaths, expandShippedFiles, currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const SIGNALS_JS = path.join(APP_ROOT, 'm', MOUNT.dir, 'core', 'signals.js');

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;

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

// The taxonomy OF THE GENERATION A MODULE BELONGS TO, keyed by mount directory.
//
// PPR-P2, AND THE SAME LESSON export-contour.spec.js LEARNED AT DIA-P2: a frozen
// generation is not a second declaration, and it is not a vote on the current
// one either. This scan walks EVERY shipped .js, which is right — an emitter is
// an emitter wherever it lives — but it used to check all of them against the
// RUNNING mount's taxonomy. That held only while the taxonomy could grow and
// never shrink. PPR-P2 removes `history.handoff` with the transfer mechanism it
// described, and /m/v4/surfaces/import.js — deleted from the product at L3-P2,
// still on disk at its frozen generation and still shipped — went red for a
// declaration that was correct when those bytes were published. A guard that
// makes a frozen generation veto the current one has stopped being about the
// property it names.
//
// So each module is read against the taxonomy of its OWN generation. The running
// mount is still checked against the running taxonomy, which is the leg that
// matters; the frozen ones are still checked, against what they were written to.
const taxonomies = new Map();

const taxonomyFor = (urlPath) => {
    const generation = /^\/m\/(v\d+)\//.exec(urlPath);
    if (!generation) {
        throw new Error(`${urlPath}: a shipped module outside the mount emits a signal`);
    }
    const loaded = taxonomies.get(generation[1]);
    if (!loaded) {
        throw new Error(`${urlPath}: no taxonomy was loaded for ${generation[1]}`);
    }
    return loaded;
};

test.beforeAll(async () => {
    // Node decides ESM-or-CommonJS from the nearest package.json, and
    // app/package.json cannot say "type":"module" without breaking every
    // CommonJS spec in this directory — while a marker file inside app/m/ is not
    // an option either, because everything under m/ SHIPS. So the shipped module
    // is copied BYTE-FOR-BYTE into a temp directory that carries the marker, and
    // the copy is verified against the original before it is imported. Same
    // trap, same answer, as app/tests/store-unit.spec.js documents at length.
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-signals-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    const copy = path.join(loadRoot, 'signals.js');
    fs.copyFileSync(SIGNALS_JS, copy);
    expect(
        fs.readFileSync(copy).equals(fs.readFileSync(SIGNALS_JS)),
        'signals.js was not copied verbatim — this spec would test a different file'
    ).toBeTruthy();
    signals = await dynamicImport(pathToFileURL(copy).href);

    // Every generation that ships an emitter, loaded the same verified-copy way.
    const generations = new Set(
        SHIPPED_JS.map((urlPath) => /^\/m\/(v\d+)\//.exec(urlPath))
            .filter(Boolean)
            .map((m) => m[1])
    );
    expect(generations.size, 'the ship list carries no mount generation at all').toBeGreaterThan(0);
    expect(generations.has(MOUNT.dir), 'the running generation is not shipped').toBe(true);
    for (const dir of generations) {
        const original = path.join(APP_ROOT, 'm', dir, 'core', 'signals.js');
        if (!fs.existsSync(original)) continue;
        const target = path.join(loadRoot, `signals-${dir}.js`);
        fs.copyFileSync(original, target);
        expect(
            fs.readFileSync(target).equals(fs.readFileSync(original)),
            `m/${dir}/core/signals.js was not copied verbatim — this spec would test a different file`
        ).toBeTruthy();
        taxonomies.set(dir, await dynamicImport(pathToFileURL(target).href));
    }
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
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

    // SPLIT IN TWO AT L3-P2 (FIU-DL-002), BECAUSE THE TAXONOMY GAINED A SECOND
    // STATE AND ONE COUNT CANNOT CARRY BOTH. `emittedNow` was true for all nine
    // kinds until that packet; the transfer offer's removal left
    // `history.handoff` and `history.import` DECLARED with no producer, and the
    // honest flag for that is false. `emitSignal` refuses a kind flagged false,
    // by design — so this leg asserts the two halves separately rather than
    // being relaxed into a range, which would have stopped noticing a kind that
    // silently became unemittable for the WRONG reason.
    //
    // PPR-P2 REMOVES `history.handoff` OUTRIGHT, and the remaining declared-not-
    // emitted kind is `history.import` alone. A kind flagged false is a kind
    // waiting for its emitter to come back; the handoff's cannot, because the
    // mechanism it described is retired, and a taxonomy entry for a thing that
    // does not exist is a false statement in a machine-readable surface.
    test('anti-vacuity: every EMITTED kind is emittable with its own declared codes', async () => {
        const { emitSignal, SIGNAL_TAXONOMY } = signals;
        const emittedKinds = Object.entries(SIGNAL_TAXONOMY).filter(
            ([, descriptor]) => descriptor.emittedNow
        );
        expect(
            emittedKinds.length,
            'a taxonomy with nothing emitted would pass this leg vacuously'
        ).toBeGreaterThan(0);
        let accepted = 0;
        for (const [kind, descriptor] of emittedKinds) {
            const payload = {};
            for (const field of descriptor.fields) {
                const codes = signals.SIGNAL_CODES[field];
                payload[field] = codes ? codes[0] : (descriptor.boolean?.includes(field) ? true : 1);
            }
            if (emitSignal(kind, payload, { sink: () => {} })) accepted += 1;
        }
        expect(accepted, 'every emitted kind must be emittable with its own declared codes').toBe(
            emittedKinds.length
        );
    });

    test('a kind declared but NOT emitted is refused, with its own declared codes', async () => {
        // The other half, and it is the enforcement rather than a note: a kind
        // whose emitter was removed must not keep emitting from somewhere else.
        // A perfectly-formed payload is used deliberately — the refusal has to
        // come from the flag and from nothing else.
        const { emitSignal, SIGNAL_TAXONOMY, signalRefusals } = signals;
        const declaredOnly = Object.entries(SIGNAL_TAXONOMY).filter(
            ([, descriptor]) => !descriptor.emittedNow
        );
        for (const [kind, descriptor] of declaredOnly) {
            const payload = {};
            for (const field of descriptor.fields) {
                const codes = signals.SIGNAL_CODES[field];
                payload[field] = codes ? codes[0] : (descriptor.boolean?.includes(field) ? true : 1);
            }
            const before = signalRefusals();
            expect(
                emitSignal(kind, payload, { sink: () => {} }),
                `${kind} is flagged emittedNow: false and was emitted anyway`
            ).toBe(false);
            expect(signalRefusals(), 'the refusal was swallowed rather than counted').toBe(
                before + 1
            );
        }
    });
});

test.describe('every emitter in the shipped surface is provably payload-safe', () => {
    // WHY THIS IS NOT A REGEX. It was, and the regex failed OPEN — which a
    // mutation test caught while this packet was being written. `[^)]*?` stops
    // at the first close paren, so a violating call site like
    //
    //     emitSignal('write.refused', { reason: getCurrentProfile().name })
    //
    // was captured only as far as `getCurrentProfile(`, and the family-text scan
    // below never saw `.name` at all. A guard that cannot see the very shape a
    // violation would take is worse than no guard, because it reports green.
    //
    // So the arguments are extracted by balancing parens, and — the part that
    // makes the scan SOUND rather than merely better — a payload containing a
    // call is refused outright. Compute the value into a local const first. That
    // is what every emitter already does, and it leaves nothing for a nested
    // paren to hide behind.
    const extractArgument = (source, open) => {
        let depth = 0;
        for (let at = open; at < source.length; at += 1) {
            if (source[at] === '(') depth += 1;
            else if (source[at] === ')') {
                depth -= 1;
                if (depth === 0) return source.slice(open + 1, at);
            }
        }
        throw new Error('an emitSignal( call is never closed; this scan cannot read it');
    };

    const callSites = () => {
        const found = [];
        for (const urlPath of SHIPPED_JS) {
            if (urlPath.endsWith('/core/signals.js')) continue;
            const source = sourceOf(urlPath);
            let at = source.indexOf('emitSignal(');
            while (at !== -1) {
                // Skip the import statement, which names the function without
                // calling it.
                const open = at + 'emitSignal'.length;
                found.push({ urlPath, argument: extractArgument(source, open) });
                at = source.indexOf('emitSignal(', open);
            }
        }
        return found;
    };

    test('no payload computes its value inline, so nothing can hide behind a paren', () => {
        for (const { urlPath, argument } of callSites()) {
            const payload = argument.slice(argument.indexOf(',') + 1);
            expect(
                payload,
                `${urlPath}: a signal payload contains a call. Compute it into a local`
                    + ' const first — an inline call is where family text gets in unseen.'
            ).not.toContain('(');
        }
    });

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
        // Anti-vacuity for the per-generation lookup: the running mount's
        // taxonomy must be one of the loaded ones and must be non-empty, or
        // "declared" below could be an empty list that contains nothing and
        // fails loudly, or a stale one that contains everything.
        expect(
            Object.keys(taxonomyFor(`${MOUNT.prefix}core/signals.js`).SIGNAL_TAXONOMY).length,
            'the running generation loaded an empty taxonomy'
        ).toBeGreaterThan(0);

        for (const { urlPath, argument } of callSites()) {
            const declared = Object.keys(taxonomyFor(urlPath).SIGNAL_TAXONOMY);
            const kind = argument.match(/^'([^']+)'/);
            expect(kind, `${urlPath}: emitSignal is called with a non-literal kind`).not.toBe(null);
            expect(
                declared,
                `${urlPath}: "${kind[1]}" is not in the taxonomy of the generation it ships in`
            ).toContain(kind[1]);
        }
    });

    test('every payload key is a literal, and declared for that kind', () => {
        for (const { urlPath, argument } of callSites()) {
            const { SIGNAL_TAXONOMY } = taxonomyFor(urlPath);
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

    // Kept at UIP-P1 rather than retired with the shim it names. Analytics left
    // the web showcase entirely, so `trackEvent` exists nowhere in the tree and
    // this leg cannot fail today — which is the point of a drift gate, not an
    // argument against one: what it guards is a signal being handed to whatever
    // measurement surface a later packet introduces, and the cheapest moment to
    // catch that is the packet that introduces it. The name says "shim" because
    // that is what the destination was called; the property is about the source.
    test('no emitter routes a signal into a measurement call', () => {
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
