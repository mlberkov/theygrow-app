'use strict';

// Off-device unit run of the transfer drain (DIA-P1).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It imports the SHIPPED store/transfer.js
// — the same file the APK carries — and drives it against a FAKE Capacitor. So
// it proves the JavaScript half: that a staged transfer is read across in chunks
// no larger than the declared size, that the pieces reassemble into exactly the
// bytes that were staged, that no bridge call carries a payload, and that a
// short, long or altered transfer is REFUSED with a declared code rather than
// handed to the importer.
//
// IT PROVES NOTHING ABOUT THE PLUGIN. Not that the intent-filter delivers, not
// that stageFromIntent decodes, not that a refusal refuses, not that the Intent
// stays out of the WebView. A fake would prove the fake. Those claims belong to
// native/android/.../HistoryTransferTest.java in `android-instrumented`, which
// runs on pull_request and workflow_dispatch only — so at the time this file is
// written they are IMPLEMENTED AND UNOBSERVED, and a green run here is not
// evidence about any of them.
//
// It exists for the same reason app/tests/export-sink-unit.spec.js does: the
// property "the bytes that arrive are the bytes that left" is the one a chunked
// transfer can silently get wrong, and it is cheap enough to check on every push.
// Same plumbing as store-unit.spec.js, and for the same two Node reasons.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let seam = null;
let format = null;
let TRANSFER_CONFIG = null;

// The mount layout is reproduced rather than flattened, for the reason
// store-unit.spec.js records: store/transfer.js imports ../transfer/config.js.
test.beforeAll(async () => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-drain-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    for (const dir of ['store', 'transfer']) {
        const from = path.join(APP_ROOT, 'm', MOUNT.dir, dir);
        const to = path.join(loadRoot, dir);
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
            const source = path.join(from, name);
            if (!fs.statSync(source).isFile()) continue;
            fs.copyFileSync(source, path.join(to, name));
            expect(
                fs.readFileSync(path.join(to, name)).equals(fs.readFileSync(source)),
                `${dir}/${name} was not copied verbatim — this test would test a different file`
            ).toBeTruthy();
        }
    }
    seam = await dynamicImport(pathToFileURL(path.join(loadRoot, 'store', 'transfer.js')).href);
    format = await dynamicImport(pathToFileURL(path.join(loadRoot, 'transfer', 'format.js')).href);
    ({ TRANSFER_CONFIG } = await dynamicImport(
        pathToFileURL(path.join(loadRoot, 'transfer', 'config.js')).href
    ));
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

const PROFILE = {
    id: 'profile_parity_0001',
    name: 'Тестовый профиль',
    birthdate: '2024-09-15',
    completedSkills: ['GM_001', 'GM_002', 'GM_003'],
};

function toBase64(bytes) {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 1) binary += String.fromCharCode(bytes[at]);
    return Buffer.from(binary, 'binary').toString('base64');
}

/**
 * A fake plugin holding `bytes`, recording every call it is handed.
 *
 * `corrupt` lets a test alter what comes back WITHOUT altering what the fake
 * declares — which is exactly the shape a truncating or duplicating transport
 * takes, and the only shape the digest check exists to catch.
 */
function createFakeTransfer(bytes, { corrupt = null } = {}) {
    const calls = [];
    const bridge = {
        isNativePlatform: () => true,
        nativePromise: async (plugin, method, options) => {
            calls.push({ plugin, method, options });
            if (method === 'readChunk') {
                const { offset, length } = options;
                let slice = bytes.subarray(offset, offset + length);
                if (corrupt) slice = corrupt(slice, offset);
                return {
                    base64: toBase64(slice),
                    offset,
                    bytes: slice.length,
                    done: offset + slice.length >= bytes.length,
                };
            }
            return {};
        },
    };
    return { bridge, calls };
}

async function withBridge(bridge, fn) {
    // Restoring is not tidiness: store-unit.spec.js asserts the store modules
    // are import-safe with NO window at all, and Playwright reuses a worker
    // across spec files. A leaked global would red that in a file that never
    // mentioned it.
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previous = globalThis.window;
    globalThis.window = { Capacitor: bridge };
    try {
        return await fn();
    } finally {
        if (had) globalThis.window = previous;
        else delete globalThis.window;
    }
}

async function stage(profiles = [PROFILE]) {
    const envelope = format.buildEnvelope(profiles);
    const bytes = format.envelopeBytes(envelope);
    return { envelope, bytes, sha256: await format.digestHex(bytes) };
}

test.describe('the drain reassembles exactly what was staged', () => {
    test('a small transfer arrives whole, in one chunk', async () => {
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes);
        const drained = await withBridge(fake.bridge, () =>
            seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 })
        );

        expect(drained.bytes).toBe(bytes.length);
        expect(drained.chunks).toBe(1);
        expect(drained.profiles).toEqual([PROFILE]);
    });

    test('a transfer larger than the chunk size arrives in bounded pieces', async () => {
        // THE FIXTURE SIZE IS THE POINT, and it is the lesson XPT-P1 paid for:
        // every test of the export sink used a few hundred bytes, so the size of
        // the fixture WAS the defect's hiding place. This one is deliberately
        // several chunks long, built from skill-id-shaped padding in the field
        // the envelope actually carries.
        const stride = TRANSFER_CONFIG.transferChunkBytes;
        const skills = [];
        while (skills.length * 12 < stride * 3) {
            skills.push(`XX_${String(skills.length).padStart(6, '0')}`);
        }
        const big = { ...PROFILE, completedSkills: skills };
        const { bytes, sha256 } = await stage([big]);
        expect(bytes.length, 'the fixture is not larger than one chunk').toBeGreaterThan(stride);

        const fake = createFakeTransfer(bytes);
        const drained = await withBridge(fake.bridge, () =>
            seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 })
        );

        expect(drained.chunks).toBeGreaterThan(1);
        expect(drained.profiles[0].completedSkills).toEqual(skills);

        // NO CALL ASKS FOR MORE THAN THE DECLARED CHUNK. The plugin refuses a
        // longer one, so a drain that asked would simply fail on a device — but
        // the reason the bound exists is that a bridge RESPONSE crosses the same
        // binder transaction an argument does, and that is what this asserts.
        const reads = fake.calls.filter((call) => call.method === 'readChunk');
        expect(reads.length).toBe(drained.chunks);
        for (const call of reads) {
            expect(call.options.length).toBeLessThanOrEqual(stride);
        }
    });

    test('no call to the plugin carries a payload', async () => {
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes);
        await withBridge(fake.bridge, () =>
            seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 })
        );

        for (const call of fake.calls) {
            const keys = Object.keys(call.options ?? {});
            expect(
                keys.sort(),
                'a drain call carries something other than a reference and a range'
            ).toEqual(['length', 'offset', 'transferId']);
        }
    });

    test('every method called is on the declared allowlist', async () => {
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes);
        await withBridge(fake.bridge, () =>
            seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 })
        );
        const { ALLOWED_TRANSFER_METHODS } = await dynamicImport(
            pathToFileURL(path.join(loadRoot, 'transfer', 'config.js')).href
        );
        for (const call of fake.calls) {
            expect(ALLOWED_TRANSFER_METHODS).toContain(call.method);
        }
    });
});

test.describe('the drain refuses rather than importing something wrong', () => {
    test('a transfer that arrives short is refused as size_mismatch', async () => {
        // A browser that shortened the URI is the real case. Here the fake
        // declares the full length and returns less — the transport lying about
        // itself, which is what the two-number comparison exists for.
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes.subarray(0, bytes.length - 20));
        let thrown = null;
        await withBridge(fake.bridge, async () => {
            try {
                await seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 });
            } catch (error) {
                thrown = error;
            }
        });
        expect(thrown, 'a short transfer was accepted').not.toBeNull();
        expect(thrown.reason).toBe('size_mismatch');
    });

    test('a transfer altered in flight is refused as checksum_mismatch', async () => {
        // Whole by count and not the bytes that were sent — the case the length
        // check cannot see and the digest can.
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes, {
            corrupt: (slice, offset) => {
                if (offset !== 0) return slice;
                const altered = Uint8Array.from(slice);
                altered[altered.length - 1] ^= 0x01;
                return altered;
            },
        });
        let thrown = null;
        await withBridge(fake.bridge, async () => {
            try {
                await seam.drainTransfer({ transferId: 't1', totalBytes: bytes.length, sha256 });
            } catch (error) {
                thrown = error;
            }
        });
        expect(thrown, 'an altered transfer was accepted').not.toBeNull();
        expect(thrown.reason).toBe('checksum_mismatch');
        expect(
            thrown.message,
            'the refusal names a digest; a digest of a family history is a stable'
                + ' identifier for that history and does not belong in a message'
        ).not.toMatch(/[0-9a-f]{64}/);
    });

    test('a refusal never reaches the importer with a partial list', async () => {
        // The property that matters most: the journal is append-only, so what it
        // is handed cannot be corrected. A refusal must produce NOTHING, not a
        // best-effort subset.
        const { bytes, sha256 } = await stage();
        const fake = createFakeTransfer(bytes.subarray(0, 10));
        let result = 'not-thrown';
        await withBridge(fake.bridge, async () => {
            try {
                result = await seam.drainTransfer({
                    transferId: 't1',
                    totalBytes: bytes.length,
                    sha256,
                });
            } catch (error) {
                result = error;
            }
        });
        expect(result.profiles, 'a refused drain returned profiles anyway').toBeUndefined();
    });

    test('the seam is inert with no bridge injected', async () => {
        // The web branch. Both delivery channels ship these bytes, and on the
        // PWA there is no plugin — the seam must say so rather than throw
        // something the surface cannot classify.
        expect(seam.isTransferAvailable()).toBe(false);
        const pending = await seam.pendingTransfer();
        expect(pending).toEqual({ present: false, refusal: 'no_handler' });
    });
});
