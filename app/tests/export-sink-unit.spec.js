'use strict';

// Off-device unit run of the export sink's transfer (XPT-P1).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It imports the SHIPPED sink.js — the
// same file the APK carries — and drives it against a FAKE Capacitor. So it
// proves the JavaScript half: that an archive is cut into chunks the declared
// size, that the pieces reassemble into exactly the bytes that went in, and that
// the call which opens the system file picker carries a reference and nothing
// else. It proves NOTHING about the plugin, the bridge, saved instance state or
// the binder limit — a fake would prove the fake. Those claims belong to
// native/android/app/src/androidTest/.../ExportTransferTest.java, which runs the
// whole path on a device in the `android-instrumented` job.
//
// It is here because that job runs on pull_request and dispatch only, and the
// property "the bytes that arrive are the bytes that left" is cheap enough to
// check on every push. Same plumbing as store-unit.spec.js, and for the same two
// Node reasons documented there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const EXPORT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'export');

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let sink = null;
let EXPORT_CONFIG = null;

test.beforeAll(async () => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-sink-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    for (const name of fs.readdirSync(EXPORT_DIR)) {
        const from = path.join(EXPORT_DIR, name);
        if (!fs.statSync(from).isFile()) continue;
        fs.copyFileSync(from, path.join(loadRoot, name));
        expect(
            fs.readFileSync(path.join(loadRoot, name)).equals(fs.readFileSync(from)),
            `${name} was not copied verbatim — this test would be testing a different file`
        ).toBeTruthy();
    }
    sink = await dynamicImport(pathToFileURL(path.join(loadRoot, 'sink.js')).href);
    ({ EXPORT_CONFIG } = await dynamicImport(
        pathToFileURL(path.join(loadRoot, 'config.js')).href
    ));
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
    delete global.window;
});

// The native side, reduced to what the seam actually promises: a transfer id, a
// receipt per chunk, and a saved document. Every call is recorded, because what
// this file asserts is the SHAPE of the conversation, not its result.
function fakeCapacitor({ saved = true } = {}) {
    const calls = [];
    return {
        calls,
        isNativePlatform: () => true,
        nativePromise: async (plugin, method, options) => {
            calls.push({ plugin, method, options });
            if (method === 'beginTransfer') return { transferId: 'transfer-probe' };
            if (method === 'appendChunk') return { received: options.base64.length };
            if (method === 'createDocument') {
                return saved
                    ? { saved: true, uri: 'content://probe/document' }
                    : { saved: false, reason: 'cancelled' };
            }
            throw new Error(`the sink called an unexpected method "${method}"`);
        },
    };
}

function install(capacitor) {
    global.window = { Capacitor: capacitor };
    return capacitor;
}

// Deliberately not a repeating byte: a transfer that dropped, duplicated or
// reordered a chunk would still pass against a uniform buffer.
function archive(size) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    return bytes;
}

const ARCHIVE_BYTES = 5 * 1024 * 1024;

test.describe('the archive travels in pieces and arrives whole', () => {
    test('every byte that left arrives, in order', async () => {
        const capacitor = install(fakeCapacitor());
        const bytes = archive(ARCHIVE_BYTES);

        await sink.saveArtifact(bytes, 'theygrow-archive-2026-08-16.zip');

        const chunks = capacitor.calls.filter((call) => call.method === 'appendChunk');
        expect(chunks.length, 'nothing was staged — the scan would be vacuous').toBeGreaterThan(1);
        const received = Buffer.concat(
            chunks.map((call) => Buffer.from(call.options.base64, 'base64'))
        );
        expect(received.length).toBe(bytes.length);
        expect(received.equals(Buffer.from(bytes))).toBeTruthy();
    });

    test('the chunk size is the declared knob, not an accident', async () => {
        const capacitor = install(fakeCapacitor());
        const bytes = archive(ARCHIVE_BYTES);

        const result = await sink.saveArtifact(bytes, 'theygrow-archive-2026-08-16.zip');

        const chunks = capacitor.calls.filter((call) => call.method === 'appendChunk');
        expect(result.chunks).toBe(chunks.length);
        expect(chunks.length).toBe(Math.ceil(bytes.length / EXPORT_CONFIG.sinkChunkBytes));
        for (const call of chunks) {
            expect(
                Buffer.from(call.options.base64, 'base64').length,
                'a chunk carried more raw bytes than the knob allows'
            ).toBeLessThanOrEqual(EXPORT_CONFIG.sinkChunkBytes);
        }
    });

    test('the picker is opened last, after every chunk is staged', async () => {
        const capacitor = install(fakeCapacitor());

        await sink.saveArtifact(archive(ARCHIVE_BYTES), 'theygrow-archive-2026-08-16.zip');

        const methods = capacitor.calls.map((call) => call.method);
        expect(methods[0]).toBe('beginTransfer');
        expect(methods[methods.length - 1]).toBe('createDocument');
        expect(
            methods.filter((method) => method === 'createDocument').length,
            'the picker was addressed more than once'
        ).toBe(1);
        // A document created before the bytes are in hand is the 0-byte file
        // this packet exists to end.
        expect(methods.slice(1, -1).every((method) => method === 'appendChunk')).toBeTruthy();
    });
});

test.describe('the call that opens the picker carries no payload', () => {
    test('it carries exactly four small values', async () => {
        const capacitor = install(fakeCapacitor());
        const bytes = archive(ARCHIVE_BYTES);

        await sink.saveArtifact(bytes, 'theygrow-archive-2026-08-16.zip');

        const launch = capacitor.calls.find((call) => call.method === 'createDocument');
        expect(Object.keys(launch.options).sort()).toEqual([
            'filename',
            'mimeType',
            'totalBytes',
            'transferId',
        ]);
        expect(launch.options.totalBytes).toBe(bytes.length);
        // The measured defect, restated as a number: this object is what
        // Capacitor persists into saved instance state, twice, while the picker
        // is in front. It used to be 2 313 920 bytes.
        expect(JSON.stringify(launch.options).length).toBeLessThan(
            EXPORT_CONFIG.sinkLaunchOptionsMaxBytes
        );
    });

    test('the staged transfer is what it points at', async () => {
        const capacitor = install(fakeCapacitor());

        await sink.saveArtifact(archive(1024), 'theygrow-archive-2026-08-16.zip');

        const opened = capacitor.calls.find((call) => call.method === 'beginTransfer');
        const launch = capacitor.calls.find((call) => call.method === 'createDocument');
        for (const call of capacitor.calls.filter((c) => c.method === 'appendChunk')) {
            expect(call.options.transferId).toBe('transfer-probe');
        }
        expect(opened.options.totalBytes).toBe(1024);
        expect(launch.options.transferId).toBe('transfer-probe');
    });
});

test.describe('a document that was not saved is not reported as saved', () => {
    test('a closed picker raises the cancelled error, not a success', async () => {
        install(fakeCapacitor({ saved: false }));

        await expect(
            sink.saveArtifact(archive(4096), 'theygrow-archive-2026-08-16.zip')
        ).rejects.toThrow(/picker/i);
    });

    test('off the native shell the sink refuses rather than pretending', async () => {
        global.window = {};

        await expect(
            sink.saveArtifact(archive(4096), 'theygrow-archive-2026-08-16.zip')
        ).rejects.toThrow(/unavailable/i);
    });
});
