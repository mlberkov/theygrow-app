// Test driver: builds the artifact with the SHIPPED builder (L1-P3).
//
// Dev/CI only. It is not in app/Dockerfile's COPY list, so it reaches neither
// delivery channel — the same posture as everything else under app/tests/.
//
// Its whole job is to be thin. It reads a read-out produced by
// app/tests/export/harness.py against a real SQLite database carrying the real
// frozen DDL, hands it to app/m/v1/export/build.js untouched, and writes the
// bytes out. Nothing here renders, orders, encodes or defaults anything: a
// driver that did would be a second implementation, and the suite would be
// proving the driver rather than the artifact.
//
// THE COPY IS NOT AN INDIRECTION, it is the same plumbing app/tests/
// store-unit.spec.js documents: Node decides whether a .js file is ESM from the
// nearest package.json, app/package.json cannot say "type": "module" without
// breaking every CommonJS spec beside it, and a marker file inside app/m/ would
// SHIP. So the export modules are copied byte-for-byte into a temp directory
// carrying the marker, and every copy is verified against its original before
// anything is imported. The browser needs none of this — it reads the MIME type
// off the response.
//
// declaration.json is read off disk rather than fetched, because there is no
// origin under `node`. It is the same file the app fetches at runtime and the
// same bytes the harness drives its queries from.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(HERE, '..', '..', 'm', 'v1', 'export');
const DECLARATION = path.join(EXPORT_DIR, 'declaration.json');

const [, , payloadPath, outPath] = process.argv;
if (!payloadPath || !outPath) {
    throw new Error('usage: build-artifact.mjs <readout.json> <out.zip>');
}

const loadRoot = mkdtempSync(path.join(os.tmpdir(), 'theygrow-export-'));
try {
    writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    for (const name of readdirSync(EXPORT_DIR)) {
        const from = path.join(EXPORT_DIR, name);
        if (!statSync(from).isFile()) continue;
        const to = path.join(loadRoot, name);
        cpSync(from, to);
        if (!readFileSync(to).equals(readFileSync(from))) {
            throw new Error(`${name} was not copied verbatim — this would build a different file`);
        }
    }

    const { buildArtifact } = await import(pathToFileURL(path.join(loadRoot, 'build.js')).href);

    const declaration = JSON.parse(await readFile(DECLARATION, 'utf8'));
    const payload = JSON.parse(await readFile(payloadPath, 'utf8'));

    // The two vendored binaries are read off disk here for the same reason the
    // declaration is: there is no origin under `node`. They are the same bytes
    // the app fetches from its own web root at runtime.
    const assets = {
        font: new Uint8Array(await readFile(path.join(EXPORT_DIR, 'assets', 'PTSans-Regular.ttf'))),
        icc: new Uint8Array(await readFile(path.join(EXPORT_DIR, 'assets', 'sRGB-v2-micro.icc'))),
    };

    await writeFile(
        outPath,
        buildArtifact({
            declaration,
            readout: payload.readout,
            manifest: { ...payload.manifest, assets },
        })
    );
} finally {
    rmSync(loadRoot, { recursive: true, force: true });
}
