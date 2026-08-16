'use strict';

// Off-device unit tests for the store's pure surfaces (L1-P2).
//
// These import the SHIPPED modules directly under Node — the same files the
// APK carries — rather than a copy. That is only possible because the modules
// are import-safe off the browser: no top-level `window`, no top-level fetch,
// no side effect at load. That property is itself asserted below, because it is
// what lets any of this be tested without an emulator.
//
// What is NOT here: anything that needs the bridge. Those claims belong to the
// Android instrumented tests, and pretending to cover them with a fake bridge
// would prove the fake, not the plugin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const STORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'store');

// TWO PIECES OF PLUMBING, both load-bearing, both about Node rather than about
// the store:
//
//   1. Playwright compiles these CommonJS specs and rewrites a literal
//      `import()` into `require()`. Building the importer through `new Function`
//      keeps a real dynamic import in the compiled output.
//   2. Node decides whether a `.js` file is ESM from the nearest package.json,
//      and app/package.json cannot say `"type": "module"` without breaking every
//      CommonJS spec in this directory. A marker file inside app/m/ is not an
//      option either: everything under m/ SHIPS. So the store is copied
//      BYTE-FOR-BYTE into a temp directory that carries the marker, and the
//      copy is verified against the originals before anything is imported. The
//      browser needs none of this — it reads the MIME type off the response.
const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;

// THE COPY PRESERVES THE MOUNT'S DIRECTORY LAYOUT, and since DIA-P1 it has to.
//
// Until that packet every store module imported only its siblings, so a FLAT
// copy of store/ was faithful. store/transfer.js imports `../transfer/config.js`
// — the transfer knobs live in their own surface, beside the handoff page that
// shares them — and a flat copy turned that into a module resolution failure
// that reads as "boot.js is not import-safe off the browser". The layout is
// therefore reproduced rather than flattened: the marker package.json sits at
// the temp root and each directory is copied under its own name, so every
// relative specifier resolves exactly as it does in the mount.
const COPIED_DIRS = ['store', 'transfer'];

test.beforeAll(() => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-store-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    for (const dir of COPIED_DIRS) {
        const from = path.join(APP_ROOT, 'm', MOUNT.dir, dir);
        const to = path.join(loadRoot, dir);
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
            const source = path.join(from, name);
            if (!fs.statSync(source).isFile()) continue;
            fs.copyFileSync(source, path.join(to, name));
            expect(
                fs.readFileSync(path.join(to, name)).equals(fs.readFileSync(source)),
                `${dir}/${name} was not copied verbatim — these tests would be testing a different file`
            ).toBeTruthy();
        }
    }
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

// Names stay bare ('config.js') at the call sites: they mean the STORE's module,
// which is what every existing caller in this file intends.
const load = (name) => dynamicImport(pathToFileURL(path.join(loadRoot, 'store', name)).href);

test.describe('the store modules are inert until called', () => {
    test('importing every module on a platform with no Capacitor changes nothing', async () => {
        expect(typeof globalThis.window).toBe('undefined');
        for (const name of ['config.js', 'errors.js', 'bridge.js', 'store.js', 'journal.js', 'boot.js']) {
            await expect(load(name), `${name} is not import-safe off the browser`).resolves
                .toBeTruthy();
        }
    });

    test('isNativeStore() is false without an injected bridge', async () => {
        const { isNativeStore } = await load('bridge.js');
        expect(isNativeStore()).toBe(false);
    });

    test('boot returns a stated reason on the web instead of a side effect', async () => {
        const { initNativeStore, storeHandle } = await load('boot.js');
        expect(await initNativeStore()).toEqual({ opened: false, reason: 'not-native' });
        expect(storeHandle()).toBe(null);
    });

    test('every bridge call refuses rather than half-working off-device', async () => {
        const { callPlugin } = await load('bridge.js');
        await expect(callPlugin('query', {})).rejects.toThrow(/unavailable/i);
    });

    test('a method outside the allowlist is refused before it reaches the bridge', async () => {
        const { callPlugin } = await load('bridge.js');
        await expect(callPlugin('exportToJson', {})).rejects.toThrow(/allowlist/i);
    });
});

test.describe('failures are classified, not stringly-typed', () => {
    test('a full disk is recognisable as itself', async () => {
        const { classifyStoreFailure } = await load('errors.js');
        for (const message of [
            'Execute: database or disk is full',
            'Run: SQLITE_FULL: disk is full',
        ]) {
            const error = classifyStoreFailure(message, 'execute');
            expect(error.name).toBe('StoreDiskFullError');
            expect(error.method).toBe('execute');
            expect(error.message, 'the raw engine message must survive for the RUNBOOK').toBe(
                message
            );
        }
    });

    test('corruption and everything else stay distinguishable', async () => {
        const { classifyStoreFailure } = await load('errors.js');
        expect(classifyStoreFailure('database disk image is malformed').name).toBe(
            'StoreCorruptError'
        );
        expect(classifyStoreFailure('no such table: journal_entry').name).toBe('StoreError');
        expect(classifyStoreFailure(new Error('SQLITE_FULL')).name).toBe('StoreDiskFullError');
    });
});

test.describe('backward propagation is derived, never authored (slot 7)', () => {
    const observed = (skillId, assertionId, propagation) => ({
        child_id: 'c-1',
        skill_id: skillId,
        state: 'skill_observed',
        visibility_class: 'child_shared',
        asserted_by: 'p-1',
        effective_from_date: '2026-02-01',
        prerequisite_propagation: propagation,
        assertion_id: assertionId,
    });

    test('an implied prerequisite is marked derived and carries no author', async () => {
        const { applyPrerequisitePropagation } = await load('journal.js');
        const rows = [observed('walk', 'j-1', 'implies_prerequisites')];
        const out = applyPrerequisitePropagation(rows, (skill) =>
            skill === 'walk' ? ['stand', 'crawl'] : []
        );

        expect(out).toHaveLength(3);
        const implied = out.filter((row) => row.derived);
        expect(implied.map((row) => row.skill_id).sort()).toEqual(['crawl', 'stand']);
        for (const row of implied) {
            expect(row.asserted_by, 'an implied mark must never be attributed to a person').toBe(
                null
            );
            expect(row.assertion_id).toBe(null);
            expect(row.derived_from).toBe('j-1');
        }
        expect(out.find((row) => row.skill_id === 'walk').derived).toBe(false);
    });

    test('propagation off means nothing is implied', async () => {
        const { applyPrerequisitePropagation } = await load('journal.js');
        const out = applyPrerequisitePropagation([observed('walk', 'j-1', 'none')], () => [
            'stand',
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].derived).toBe(false);
    });

    test('an authored mark is never replaced by a derived one', async () => {
        const { applyPrerequisitePropagation } = await load('journal.js');
        const rows = [
            observed('walk', 'j-1', 'implies_prerequisites'),
            { ...observed('stand', 'j-2', 'none'), state: 'skill_revoked' },
        ];
        const out = applyPrerequisitePropagation(rows, () => ['stand']);
        const stand = out.filter((row) => row.skill_id === 'stand');
        expect(stand).toHaveLength(1);
        expect(stand[0].state, 'the parent said revoked; propagation must not overrule it').toBe(
            'skill_revoked'
        );
        expect(stand[0].derived).toBe(false);
    });

    test('a revoked mark implies nothing', async () => {
        const { applyPrerequisitePropagation } = await load('journal.js');
        const rows = [
            { ...observed('walk', 'j-1', 'implies_prerequisites'), state: 'skill_revoked' },
        ];
        const out = applyPrerequisitePropagation(rows, () => ['stand']);
        expect(out).toHaveLength(1);
    });
});

test.describe('the declared knobs are the only ones', () => {
    test('every knob carries changed_in provenance', async () => {
        const source = fs.readFileSync(path.join(STORE_DIR, 'config.js'), 'utf8');
        const block = /STORE_CONFIG = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(source);
        expect(block).not.toBeNull();
        const knobs = Array.from(block[1].matchAll(/^\s{4}([a-zA-Z]+):/gm)).map((m) => m[1]);
        expect(knobs.length).toBeGreaterThan(5);
        const provenance = (block[1].match(/changed_in:/g) ?? []).length;
        expect(
            provenance,
            'every knob group in the config surface needs changed_in provenance (ADR-013)'
        ).toBeGreaterThanOrEqual(7);
    });

    test('the config surface is frozen at runtime', async () => {
        const { STORE_CONFIG, ALLOWED_PLUGIN_METHODS } = await load('config.js');
        expect(Object.isFrozen(STORE_CONFIG)).toBe(true);
        expect(Object.isFrozen(ALLOWED_PLUGIN_METHODS)).toBe(true);
    });
});
