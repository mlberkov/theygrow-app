'use strict';

// The APK download offer, read as source and as an off-device module
// (PPR-P2-INV-002).
//
// WHERE THIS FILE CAME FROM. It is the surviving half of
// app/tests/consent-gate.spec.js, which PPR-P2 wrote to hold two unrelated
// subjects: the analytics-consent gate and the platform probe behind the
// download control. UIP-P1 removed analytics from every channel, so the consent
// half has no object left; this half never had anything to do with consent and
// keeps its enforcement. It is renamed rather than left under the old name
// because docs/INVARIANTS.md names its path, and a file named for a retired
// subject is how the next reader is misled.
//
// WHAT THIS FILE IS AND IS NOT. It boots nothing, and says so: every leg here is
// a property of the tree — the truth tables of two pure functions imported under
// Node, read against the knob that declares their vocabulary (AGENTS.md §11).
// The EXECUTING half of the same invariant is
// app/tests/channel-composition.spec.js, which drives a real browser on both
// channels. Nothing here stands in for it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
// The mount the SHELL references, never a literal (EMV-DL-001): a copy-forward
// bump leaves the old generation on disk and shipped, so a pinned literal would
// keep guarding bytes nothing runs.
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);

const CHANNEL_CONFIG_SOURCE = fs.readFileSync(
    path.join(MOUNT_DIR, 'channel', 'config.js'),
    'utf8'
);

// Read out of the declaring file, never restated here. A guard carrying its own
// copy of the value it checks agrees with itself.
const PLATFORM_TOKEN = /androidPlatformToken:\s*'([^']+)'/.exec(CHANNEL_CONFIG_SOURCE)[1];
const PUBLISHED = /releaseStatePublished:\s*'([^']+)'/.exec(CHANNEL_CONFIG_SOURCE)[1];

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let channel = null;

test.beforeAll(async () => {
    // Node decides ESM-or-CommonJS from the nearest package.json, and
    // app/package.json cannot say "type":"module" without breaking every
    // CommonJS spec in this directory — while a marker file inside app/m/ is not
    // an option either, because everything under m/ SHIPS. So the shipped modules
    // are copied BYTE-FOR-BYTE into a temp directory that carries the marker, and
    // each copy is verified against its original before it is imported. Same
    // trap, same answer, as app/tests/store-unit.spec.js documents at length.
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-download-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');

    const copy = (sub, file) => {
        fs.mkdirSync(path.join(loadRoot, sub), { recursive: true });
        const from = path.join(MOUNT_DIR, sub, file);
        const to = path.join(loadRoot, sub, file);
        fs.copyFileSync(from, to);
        expect(
            fs.readFileSync(to).equals(fs.readFileSync(from)),
            `${sub}/${file} was not copied verbatim — this spec would test a different file`
        ).toBeTruthy();
        return to;
    };

    copy('channel', 'config.js');
    const channelPath = copy('surfaces', 'channel.js');

    // surfaces/channel.js reads window lazily and guards for its absence, which
    // is the property that makes this import possible at all.
    channel = await dynamicImport(pathToFileURL(channelPath).href);
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

test.describe(`the download offer is platform-honest, and unreadable means no offer — /m/${MOUNT.dir}/`, () => {
    const ANDROID_UA =
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/126.0.0.0 Mobile Safari/537.36';
    const IPHONE_UA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const DESKTOP_UA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/126.0.0.0 Safari/537.36';

    // ANTI-VACUITY, RE-ANCHORED AT UIP-P1. The leg this replaces required
    // GA_MEASUREMENT_ID to be present in the shell, which was a fair proof that
    // the file had been read while the shell had an analytics block and is an
    // impossible one now. What it anchors on instead are the three things every
    // leg below depends on: the module was imported, the two functions exist,
    // and the vocabulary was read out of a real knob rather than defaulting to
    // an empty string that would make every comparison below trivially true.
    test('the spec imported a real module and read a real knob', () => {
        expect(typeof channel.isAndroidPlatform, 'isAndroidPlatform was not imported').toBe(
            'function'
        );
        expect(typeof channel.shouldOfferDownloadLink, 'shouldOfferDownloadLink was not imported').toBe(
            'function'
        );
        expect(PLATFORM_TOKEN.length, 'the platform token read back empty').toBeGreaterThan(0);
        expect(PUBLISHED.length, 'the published release token read back empty').toBeGreaterThan(0);
        // The token is what the probe matches on. If it ever stopped appearing
        // in the user-agent string this file scans with, every leg below would
        // pass while the shipped probe measured something else.
        expect(
            ANDROID_UA.toLowerCase().includes(PLATFORM_TOKEN.toLowerCase()),
            `the declared platform token "${PLATFORM_TOKEN}" is not in the Android user-agent this`
                + ' spec probes with — the fixture and the shipped knob have drifted apart'
        ).toBeTruthy();
    });

    test('the declared platform is preferred over the user-agent string', () => {
        const { isAndroidPlatform } = channel;
        // A declared value beats a scan, in BOTH directions — including the case
        // that says the preference is real: a desktop that happens to carry the
        // token somewhere in its UA string is still not Android.
        expect(isAndroidPlatform({ userAgentData: { platform: 'Android' }, userAgent: DESKTOP_UA })).toBe(
            true
        );
        expect(isAndroidPlatform({ userAgentData: { platform: 'macOS' }, userAgent: ANDROID_UA })).toBe(
            false
        );
    });

    test('the user-agent string answers when nothing is declared', () => {
        const { isAndroidPlatform } = channel;
        expect(isAndroidPlatform({ userAgent: ANDROID_UA })).toBe(true);
        expect(isAndroidPlatform({ userAgent: IPHONE_UA })).toBe(false);
        expect(isAndroidPlatform({ userAgent: DESKTOP_UA })).toBe(false);
    });

    test('anything unreadable is not Android — the failure direction, stated and executed', () => {
        const { isAndroidPlatform } = channel;
        for (const nav of [
            null,
            undefined,
            {},
            { userAgent: '' },
            { userAgent: 42 },
            { userAgentData: {} },
            { userAgentData: { platform: '' }, userAgent: '' },
        ]) {
            expect(
                isAndroidPlatform(nav),
                `${JSON.stringify(nav)} was read as Android — an unreadable platform must get the`
                    + ' honest sentence, never a package it cannot install'
            ).toBe(false);
        }
    });

    test('the declaration still gates the file, on every platform', () => {
        const { shouldOfferDownloadLink } = channel;
        expect(shouldOfferDownloadLink(PUBLISHED, false, true)).toBe(true);
        expect(shouldOfferDownloadLink(PUBLISHED, false, false)).toBe(false);
        expect(shouldOfferDownloadLink(PUBLISHED, true, true)).toBe(false);
        for (const state of [null, undefined, '', 'none', 'Published', ' ' + PUBLISHED]) {
            expect(
                shouldOfferDownloadLink(state, false, true),
                `"${state}" was treated as a published release — an undeclared release is offered to`
                    + ' nobody, whatever they are holding'
            ).toBe(false);
        }
    });
});
