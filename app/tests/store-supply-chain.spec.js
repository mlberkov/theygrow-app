'use strict';

// Supply-chain and wrapper-boundary guard for the native store (L1-P2).
//
// The app holds unrecoverable data about children; one compromised SQLite
// plugin nullifies the whole local-first posture. Three claims are pinned here,
// each of which would otherwise rot silently:
//
//   1. NOTHING FROM node_modules SHIPS. The CRDT libraries are test-only, and
//      the store calls the native plugin through the INJECTED bridge, so no npm
//      code enters either web root. This is also what keeps the production web
//      path buildless (LSC-DL-002).
//   2. THE WRAPPER STAYS REPLACEABLE. Only the methods on the declared allowlist
//      are called — none of the plugin's opinionated machinery (JSON
//      import/export, its own upgrade versioning, sync tables) is load-bearing.
//   3. THE PIN IS EXACT. Version and lockfile agree, and nothing floats.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
    shippedPaths,
    expandShippedFiles,
    moduleSpecifiers,
    currentMount,
} = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const NATIVE_ROOT = path.join(REPO_ROOT, 'native');

const SHIPPED = expandShippedFiles(
    shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
    APP_ROOT
);

const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const STORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'store');
const STORE_SOURCES = fs
    .readdirSync(STORE_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(STORE_DIR, name), 'utf8') }));

// Banned outright from SHIPPED files: a mention of either package name in a
// shipped byte means library code reached the runtime or the storage format.
const TEST_ONLY_PACKAGES = ['@automerge/automerge', 'loro-crdt'];

test.describe('nothing from node_modules reaches the shipped asset set', () => {
    test('the store modules and the DDL are actually shipped', () => {
        // Anti-vacuity: the scans below prove nothing if the store never ships.
        expect(SHIPPED).toContain(`${MOUNT.prefix}store/store.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}store/journal.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}store/bridge.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}store/schema/001-core.sql`);
    });

    for (const pkg of TEST_ONLY_PACKAGES) {
        test(`no shipped file mentions "${pkg}"`, () => {
            const offenders = SHIPPED.filter((urlPath) => {
                const onDisk = path.join(APP_ROOT, urlPath.replace(/^\//, ''));
                if (/\.(png|jpg|ico|woff2?)$/i.test(urlPath)) return false;
                return fs.readFileSync(onDisk, 'utf8').includes(pkg);
            });
            expect(
                offenders,
                `"${pkg}" must appear in tests only — never in the runtime or the storage format`
            ).toEqual([]);
        });
    }

    test('the store reaches the plugin through the injected bridge, not an import', () => {
        // Prose may mention the npm tree; an IMPORT may not name it, and no
        // specifier may be bare. Both forms would need a bundler to resolve,
        // which is the thing this packet declines to introduce (LSC-DL-002).
        for (const { name, source } of STORE_SOURCES) {
            const specifiers = Array.from(
                source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)
            ).map((m) => m[1]);
            for (const specifier of specifiers) {
                expect(
                    specifier.startsWith('./') || specifier.startsWith('../'),
                    `${name} imports the bare specifier "${specifier}" — buildless delivery `
                        + 'has no import map, so this could only work behind a bundler'
                ).toBeTruthy();
                expect(specifier).not.toContain('node_modules');
            }
        }
    });

    test('no shipped module anywhere resolves outside the versioned mount', () => {
        // Uses the suite's own fail-closed specifier parser rather than a fresh
        // regex: a scan of PROSE cannot be trusted here (an apostrophe in a
        // comment pairs with the next quote and reports a phantom), which is the
        // same trap documented in tests/storage-seam.spec.js.
        let scanned = 0;
        for (const urlPath of SHIPPED) {
            if (!urlPath.endsWith('.js')) continue;
            scanned += 1;
            const source = fs.readFileSync(path.join(APP_ROOT, urlPath.replace(/^\//, '')), 'utf8');
            for (const specifier of moduleSpecifiers(source, urlPath)) {
                expect(
                    specifier.startsWith('./') || specifier.startsWith('../'),
                    `${urlPath} imports "${specifier}"`
                ).toBeTruthy();
                expect(specifier).not.toContain('node_modules');
            }
        }
        expect(scanned, 'the module scan reached no files').toBeGreaterThan(10);
    });
});

test.describe('the wrapper stays replaceable', () => {
    test('every plugin method called is on the declared allowlist', () => {
        const config = fs.readFileSync(path.join(STORE_DIR, 'config.js'), 'utf8');
        const block = /ALLOWED_PLUGIN_METHODS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(config);
        expect(block, 'config.js declares no ALLOWED_PLUGIN_METHODS').not.toBeNull();
        const allowed = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));
        expect(allowed.size).toBeGreaterThan(5);

        const called = new Set();
        for (const { source } of STORE_SOURCES) {
            for (const match of source.matchAll(/callPlugin\(\s*'([^']+)'/g)) {
                called.add(match[1]);
            }
        }
        expect(called.size, 'no plugin call sites found — the scan would be vacuous').toBeGreaterThan(
            3
        );
        for (const method of called) {
            expect(allowed.has(method), `"${method}" is called but not on the allowlist`).toBeTruthy();
        }
    });

    test('the allowlist is an exact set, so it cannot grow quietly', () => {
        // The leg above is one-directional: it stops a CALL SITE reaching past
        // the list, and says nothing about the list itself growing. DIA-DL-007
        // added three methods to it on a bounded-capability argument — none of
        // beginTransaction / commitTransaction / rollbackTransaction can address
        // a path, enumerate anything or delete anything; they control a
        // transaction on a database the app has already opened. That argument
        // was made once, in front of the owner. This leg is what stops it
        // becoming a standing precedent for adding a fourth without one: the set
        // is pinned here, and widening it means editing this list on purpose.
        const config = fs.readFileSync(path.join(STORE_DIR, 'config.js'), 'utf8');
        const block = /ALLOWED_PLUGIN_METHODS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(config);
        expect(block, 'config.js declares no ALLOWED_PLUGIN_METHODS').not.toBeNull();
        const allowed = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);

        expect(allowed.slice().sort()).toEqual(
            [
                'beginTransaction',
                'close',
                'closeConnection',
                'commitTransaction',
                'createConnection',
                'echo',
                'execute',
                'executeSet',
                'isSecretStored',
                'open',
                'query',
                'rollbackTransaction',
                'run',
                'setEncryptionSecret',
            ].sort()
        );
        expect(new Set(allowed).size, 'the allowlist names a method twice').toBe(allowed.length);
    });

    test('no call site reaches the plugin machinery this app must not depend on', () => {
        // Its JSON import/export is not our export contour (P3); its upgrade
        // versioning is not our migration ledger (slot 14); its sync tables
        // would put `last_modified`/`sql_deleted` in our schema and silently turn
        // DELETE into soft-delete.
        const forbidden = [
            'importFromJson',
            'exportToJson',
            'addUpgradeStatement',
            'createSyncTable',
            'setSyncDate',
            'copyFromAssets',
            'getFromHTTPRequest',
        ];
        for (const { name, source } of STORE_SOURCES) {
            for (const method of forbidden) {
                expect(source.includes(method), `${name} reaches for ${method}`).toBeFalsy();
            }
        }
    });
});

test.describe('the native dependency is pinned exactly', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'package-lock.json'), 'utf8'));

    test('the SQLite plugin is declared at an exact version', () => {
        const declared = manifest.dependencies['@capacitor-community/sqlite'];
        expect(declared, 'the SQLite plugin is not declared').toBeTruthy();
        expect(
            /^\d+\.\d+\.\d+$/.test(declared),
            `"${declared}" floats — a range lets the engine under the family history change`
        ).toBeTruthy();
    });

    test('every declared dependency is pinned, not ranged', () => {
        const all = { ...manifest.dependencies, ...manifest.devDependencies };
        for (const [name, range] of Object.entries(all)) {
            expect(/^\d+\.\d+\.\d+$/.test(range), `${name} is declared as "${range}"`).toBeTruthy();
        }
    });

    test('the lockfile resolves the plugin to the declared version with an integrity hash', () => {
        const entry = lock.packages['node_modules/@capacitor-community/sqlite'];
        expect(entry, 'the plugin is missing from the lockfile').toBeTruthy();
        expect(entry.version).toBe(manifest.dependencies['@capacitor-community/sqlite']);
        expect(entry.integrity).toMatch(/^sha\d+-/);
    });

    test('the CRDT libraries are dev-only and never a runtime dependency', () => {
        const appManifest = JSON.parse(
            fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')
        );
        expect(appManifest.dependencies ?? {}).toEqual({});
        for (const pkg of ['@automerge/automerge', 'loro-crdt']) {
            expect(appManifest.devDependencies[pkg], `${pkg} must be a devDependency`).toMatch(
                /^\d+\.\d+\.\d+$/
            );
        }
        expect(manifest.dependencies['@automerge/automerge']).toBeUndefined();
        expect(manifest.dependencies['loro-crdt']).toBeUndefined();
    });
});

// This one needs the Capacitor toolchain on disk, which exists on a developer
// machine and in the `android` CI job but NOT in the parity container (that runs
// `npm ci` in app/ only). It is skipped rather than dropped because the drift it
// catches — the wrapper changing how it splits SQL — would otherwise be found by
// a broken DDL on a family's phone.
test.describe('the wrapper still splits SQL the way the DDL is written for', () => {
    const splitterPath = path.join(
        NATIVE_ROOT,
        'node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor',
        'community/database/sqlite/SQLite/UtilsSQLite.java'
    );

    test('getStatementsArray still splits on ";\\n" and re-joins only a bare END', () => {
        test.skip(
            !fs.existsSync(splitterPath),
            'native/node_modules is present only where the Capacitor toolchain is installed'
        );
        const source = fs.readFileSync(splitterPath, 'utf8');
        expect(source).toContain('stmts.split(";\\n")');
        expect(source).toContain('lArray.contains("END")');
        expect(
            source,
            'the wrapper no longer uppercases `end;` blindly — re-check the DDL formatting rules'
        ).toContain('statements.replace("end;", "END;")');
    });
});
