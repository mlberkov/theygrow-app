// Test driver: builds MATCH expressions with the SHIPPED builder (DIA-P4).
//
// Dev/CI only. It is not in app/Dockerfile's COPY list, so it reaches neither
// delivery channel — the same posture as everything else under app/tests/.
//
// WHY A DRIVER AT ALL. app/tests/schema/test_diary_search.py asserts what a
// parent's typed query MATCHES against the real frozen DDL. To do that it needs
// the FTS5 expression the app would have sent, and there are exactly two ways to
// get one: re-type the rule in Python, or run the shipped code. A re-typed rule
// is a copy, and the copy is what drifts — the argument harness.py's
// js_string_constant() already makes about SQL, applied to the one piece of the
// query that is computed rather than constant.
//
// THE COPY IS NOT AN INDIRECTION, it is the same plumbing
// app/tests/export/build-artifact.mjs documents: Node decides whether a .js file
// is ESM from the nearest package.json, app/package.json cannot say
// "type": "module" without breaking every CommonJS spec beside it, and a marker
// file inside app/m/ would SHIP. So the store modules are copied byte-for-byte
// into a temp directory carrying the marker, and every copy is verified against
// its original before anything is imported.
//
// Nothing here tokenises, folds, truncates or quotes anything. A driver that did
// would be a second implementation, and the suite would be proving the driver.
//
// Usage: node diary-match.mjs '["сел", "растут"]'  ->  {"сел": "(\"сел\"* …)", …}
// The queries arrive as one JSON array on argv and the expressions leave as one
// JSON object on stdout, so nothing about shell quoting can change a term.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..', '..');

/**
 * The module mount the shipped SHELL references, e.g. "v6".
 *
 * Derived, never written down, and failing CLOSED on anything but exactly one
 * version — the same rule as its three twins (app/tests/support/ship-list.js,
 * app/tests/schema/harness.py, app/tests/export/build-artifact.mjs). A mount bump
 * is copy-forward, so a literal here would keep driving bytes no device runs.
 */
function currentMount() {
    const shell = readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
    const versions = new Set(Array.from(shell.matchAll(/\/m\/(v\d+)\//g)).map((m) => m[1]));
    if (versions.size !== 1) {
        throw new Error(
            `app/index.html references ${versions.size} mount versions (${[...versions]
                .sort()
                .join(', ')}) — a bump is half-applied`
        );
    }
    return [...versions][0];
}

const STORE_DIR = path.join(APP_ROOT, 'm', currentMount(), 'store');

const [, , queriesJson] = process.argv;
if (!queriesJson) {
    throw new Error('usage: diary-match.mjs <json array of queries>');
}
const queries = JSON.parse(queriesJson);
if (!Array.isArray(queries)) {
    throw new Error('the argument must be a JSON array of query strings');
}

const loadRoot = mkdtempSync(path.join(os.tmpdir(), 'theygrow-search-'));
try {
    writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    // The whole store/ directory, because records.js imports config.js,
    // bridge.js, errors.js and store.js and they import each other. Only the
    // files: schema/ holds the DDL, which this driver never reads.
    for (const name of readdirSync(STORE_DIR)) {
        const from = path.join(STORE_DIR, name);
        if (!statSync(from).isFile()) continue;
        const to = path.join(loadRoot, name);
        cpSync(from, to);
        if (!readFileSync(to).equals(readFileSync(from))) {
            throw new Error(`${name} was not copied verbatim — this would build a different query`);
        }
    }

    // Importing records.js pulls bridge.js and store.js with it. Neither does
    // anything on import: bridge.js reads `window` behind a typeof guard and
    // store.js only declares functions, so under node both are inert. That is
    // the same property LSC-P1-INV-001 asserts about the web channel.
    const { buildDiaryMatch } = await import(
        pathToFileURL(path.join(loadRoot, 'records.js')).href
    );

    const built = {};
    for (const typed of queries) {
        built[typed] = buildDiaryMatch(typed);
    }
    process.stdout.write(JSON.stringify(built));
} finally {
    rmSync(loadRoot, { recursive: true, force: true });
}
