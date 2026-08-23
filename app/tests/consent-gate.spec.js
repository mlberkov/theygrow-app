'use strict';

// The analytics-consent gate, read as source and as an off-device module
// (PPR-P2, PDR-035 §5).
//
// WHAT THIS FILE IS AND IS NOT. It boots nothing, and says so: every leg here is
// a property of the tree — the shape of the shell's analytics block, the pairing
// of two declaration sites, and the truth tables of four pure functions imported
// under Node. The claim that MATTERS — that no request reaches
// googletagmanager.com until a visitor says yes — is a runtime claim and is
// executed by app/tests/consent-surface.spec.js, in a browser, by watching the
// requests a real page makes (AGENTS.md §11). Nothing here stands in for it.
//
// What a source scan IS the right instrument for is the one thing a runtime leg
// cannot show: that there is only ONE place in the shell where the tag can be
// created, and that it sits behind the gate. A browser can only tell you what
// happened on the path it took.

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

const CONSENT_CONFIG_SOURCE = fs.readFileSync(
    path.join(MOUNT_DIR, 'consent', 'config.js'),
    'utf8'
);
const STORAGE_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'core', 'storage.js'), 'utf8');
const CONSENT_SURFACE_SOURCE = fs.readFileSync(
    path.join(MOUNT_DIR, 'surfaces', 'consent.js'),
    'utf8'
);

// Read out of the declaring file, never restated here. A guard carrying its own
// copy of the value it checks agrees with itself.
const GRANTED = /stateGranted:\s*'([^']+)'/.exec(CONSENT_CONFIG_SOURCE)[1];
const DENIED = /stateDenied:\s*'([^']+)'/.exec(CONSENT_CONFIG_SOURCE)[1];
const BRIDGE = /shellBridge:\s*'([^']+)'/.exec(CONSENT_CONFIG_SOURCE)[1];
const STORAGE_KEY = /const STORAGE_KEY_ANALYTICS_CONSENT = '([^']+)'/.exec(STORAGE_SOURCE)[1];

// The shell with its comments stripped. The block below TALKS about
// googletagmanager and about the tag it no longer creates at parse time, so a
// scan over the raw file would find the prose and report the code.
//
// LINE-LEADING `//` ONLY, AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG IN THE
// DIRECTION THAT MATTERS. A general /\/\/[^\n]*/ also eats everything from the
// `//` of `https://www.googletagmanager.com/…`, so the very address these legs
// exist to locate disappeared from the scanned text and the count came back 0
// instead of 1. It failed CLOSED — the leg went red — which is the only reason
// it was noticed rather than shipped as a guard that could never find anything.
const SHELL_CODE = SHELL.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let consent = null;
let channel = null;

test.beforeAll(async () => {
    // Node decides ESM-or-CommonJS from the nearest package.json, and
    // app/package.json cannot say "type":"module" without breaking every
    // CommonJS spec in this directory — while a marker file inside app/m/ is not
    // an option either, because everything under m/ SHIPS. So the shipped modules
    // are copied BYTE-FOR-BYTE into a temp directory that carries the marker, and
    // each copy is verified against its original before it is imported. Same
    // trap, same answer, as app/tests/store-unit.spec.js documents at length.
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-consent-'));
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

    copy('consent', 'config.js');
    copy('channel', 'config.js');
    copy('core', 'storage.js');
    const consentPath = copy('surfaces', 'consent.js');
    const channelPath = copy('surfaces', 'channel.js');

    // core/storage.js touches localStorage at call time only, so importing it
    // under Node is safe; the surfaces read window lazily and guard for its
    // absence, which is the property that makes this import possible at all.
    consent = await dynamicImport(pathToFileURL(consentPath).href);
    channel = await dynamicImport(pathToFileURL(channelPath).href);
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

test.describe('the shell can start analytics in exactly one place, and never does it itself', () => {
    test('the guard is reading a real shell, not an empty string', () => {
        expect(SHELL_CODE.length, 'the shell collapsed to almost nothing').toBeGreaterThan(10000);
        expect(SHELL_CODE, 'the shell no longer carries the analytics block at all').toContain(
            'GA_MEASUREMENT_ID'
        );
    });

    test('the loader URL appears once, and only inside enable()', () => {
        const hits = Array.from(SHELL_CODE.matchAll(/googletagmanager\.com/g));
        expect(
            hits.length,
            'the analytics loader address appears more than once in the shell — one of them is'
                + ' outside the gate, or the id and the URL have drifted apart again'
        ).toBe(1);

        const bridge = SHELL_CODE.indexOf(`window.${BRIDGE} = {`);
        expect(bridge, `the shell does not define window.${BRIDGE}`).toBeGreaterThan(-1);
        const disable = SHELL_CODE.indexOf('disable()', bridge);
        expect(disable, 'the bridge declares no disable()').toBeGreaterThan(bridge);
        expect(
            hits[0].index > bridge && hits[0].index < disable,
            'the analytics loader address is not inside enable() — before this packet it was at the'
                + ' top of the head script and ran on every load, which is the defect PPR-P2 closed'
        ).toBe(true);
    });

    test('nothing in the shell calls enable(), and the flag starts false', () => {
        expect(
            SHELL_CODE,
            'the shell declares no analyticsEnabled flag — the gate has no fail-closed default'
        ).toContain('let analyticsEnabled = false;');
        expect(
            SHELL_CODE.includes(`${BRIDGE}.enable()`),
            `the shell calls ${BRIDGE}.enable() itself — the decision belongs to the mount`
        ).toBe(false);
        expect(
            SHELL_CODE,
            'trackEvent no longer returns early for a visitor who has not consented — a queue of'
                + ' events would accumulate for someone who said no'
        ).toContain('if (!analyticsEnabled) return;');
    });

    test('no gtag consent-mode default is declared — this is basic mode, as the policy says', () => {
        expect(
            SHELL_CODE,
            "the shell declares a gtag('consent', …) default. That is ADVANCED consent mode, which"
                + ' loads the tag before the answer; app/privacy.html §5 states the opposite'
        ).not.toMatch(/gtag\(\s*['"]consent['"]/);
    });
});

test.describe('the gate declares its vocabulary once, and the two halves are paired', () => {
    test('the storage key is declared in the storage door and nowhere else', () => {
        expect(STORAGE_KEY.length, 'the consent storage key parsed empty').toBeGreaterThan(0);
        expect(
            CONSENT_CONFIG_SOURCE,
            'consent/config.js declares the storage key too — key identity lives in core/storage.js,'
                + ' and a second declaration is a second thing to drift'
        ).not.toContain(`'${STORAGE_KEY}'`);
        expect(
            CONSENT_SURFACE_SOURCE,
            'surfaces/consent.js names the storage key literally instead of going through the door'
        ).not.toContain(`'${STORAGE_KEY}'`);
    });

    test('the STORED vocabulary is read from the knob, never written out again', () => {
        // TWO VOCABULARIES LIVE IN THAT MODULE AND ONLY ONE OF THEM IS THE
        // KNOB'S. What a browser has in storage is `granted` / `denied` and is
        // declared in consent/config.js. What consentState() RETURNS is a
        // three-value enum of this module's own — 'granted' / 'denied' /
        // 'undecided' — and 'undecided' proves it is a different alphabet,
        // because nothing is ever stored under that name. So the check is not
        // "no literal anywhere", which would forbid the enum; it is that every
        // point where the module meets the STORED value goes through the knob.
        const mapping = /export function consentState\([\s\S]*?\n}/.exec(CONSENT_SURFACE_SOURCE);
        expect(mapping, 'consentState is gone or was renamed').not.toBeNull();
        expect(
            mapping[0],
            'consentState compares the stored value against something other than'
                + ' CONSENT_CONFIG.stateGranted'
        ).toContain('CONSENT_CONFIG.stateGranted');
        expect(
            mapping[0],
            'consentState compares the stored value against something other than'
                + ' CONSENT_CONFIG.stateDenied'
        ).toContain('CONSENT_CONFIG.stateDenied');
        // The COMPARISONS, not the body: the returns above are the enum and are
        // supposed to be literals. What may never be a literal is the thing the
        // stored value is measured against.
        const comparisons = Array.from(mapping[0].matchAll(/raw\s*===\s*([^)\s]+)/g)).map(
            (m) => m[1]
        );
        expect(
            comparisons.length,
            'consentState compares the stored value against nothing — it cannot be reading it'
        ).toBe(2);
        for (const operand of comparisons) {
            expect(
                operand.startsWith('CONSENT_CONFIG.'),
                `consentState compares the stored value against ${operand} — the stored vocabulary`
                    + ' is declared in consent/config.js and read from there'
            ).toBe(true);
        }

        // And the write side: nothing is ever stored under a literal either.
        const writes = Array.from(CONSENT_SURFACE_SOURCE.matchAll(/writeAnalyticsConsent\(([^)]*)\)/g));
        expect(writes.length, 'nothing in the surface records an answer at all').toBeGreaterThan(0);
        for (const write of writes) {
            expect(
                write[1].includes("'"),
                `writeAnalyticsConsent(${write[1]}) stores a literal — the token comes from the knob`
            ).toBe(false);
        }
    });

    test('the shell defines the bridge the mount calls, under that exact name', () => {
        expect(BRIDGE.length, 'shellBridge parsed empty').toBeGreaterThan(0);
        expect(SHELL_CODE, `the shell does not define window.${BRIDGE}`).toContain(
            `window.${BRIDGE} = {`
        );
        expect(
            CONSENT_SURFACE_SOURCE,
            'surfaces/consent.js reaches the shell by a hard-coded name instead of through the knob'
        ).not.toContain(`window.${BRIDGE}`);
        expect(
            CONSENT_SURFACE_SOURCE,
            'surfaces/consent.js does not read the bridge through CONSENT_CONFIG.shellBridge'
        ).toContain('win[CONSENT_CONFIG.shellBridge]');
    });

    test('the surface reaches the network through nothing of its own', () => {
        for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'createElement']) {
            expect(
                CONSENT_SURFACE_SOURCE,
                `surfaces/consent.js uses ${forbidden} — the tag is the shell's to create, once,`
                    + ' and this module only decides whether it is created at all'
            ).not.toContain(forbidden);
        }
    });
});

test.describe('the three states, and which of them loads anything', () => {
    test('only the declared tokens resolve; everything else is undecided', () => {
        const { consentState } = consent;
        expect(consentState(GRANTED)).toBe('granted');
        expect(consentState(DENIED)).toBe('denied');
        for (const raw of [null, undefined, '', ' ' + GRANTED, GRANTED.toUpperCase(), 'true', '1', 'yes']) {
            expect(
                consentState(raw),
                `"${raw}" was read as something other than undecided — the gate must fail closed on`
                    + ' any value it does not recognise'
            ).toBe('undecided');
        }
    });

    test('analytics loads for exactly one state, on exactly one channel', () => {
        const { shouldLoadAnalytics } = consent;
        expect(shouldLoadAnalytics('granted', false)).toBe(true);
        expect(shouldLoadAnalytics('denied', false)).toBe(false);
        expect(shouldLoadAnalytics('undecided', false)).toBe(false);
        for (const state of ['granted', 'denied', 'undecided']) {
            expect(
                shouldLoadAnalytics(state, true),
                `the native channel loaded analytics in state "${state}" — it carries none at all`
            ).toBe(false);
        }
    });

    test('the question is asked once, of the one visitor who has not answered it', () => {
        const { shouldAskForConsent } = consent;
        expect(shouldAskForConsent('undecided', false)).toBe(true);
        expect(shouldAskForConsent('granted', false)).toBe(false);
        expect(
            shouldAskForConsent('denied', false),
            'a visitor who declined is asked again — declining has to mean something'
        ).toBe(false);
        for (const state of ['granted', 'denied', 'undecided']) {
            expect(shouldAskForConsent(state, true)).toBe(false);
        }
    });
});

test.describe('the download offer is platform-honest, and unreadable means no offer', () => {
    const ANDROID_UA =
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/126.0.0.0 Mobile Safari/537.36';
    const IPHONE_UA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const DESKTOP_UA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/126.0.0.0 Safari/537.36';

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
        const PUBLISHED = /releaseStatePublished:\s*'([^']+)'/.exec(
            fs.readFileSync(path.join(MOUNT_DIR, 'channel', 'config.js'), 'utf8')
        )[1];
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
