'use strict';

// NAV-P2-INV-002, the static half — properties of the tree, read as properties of
// the tree (AGENTS.md §11).
//
// WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. Its executing twin,
// app/tests/update-check.spec.js, presses the row in a real browser and reads the
// network log: it is what says the request happens on a press and nowhere else,
// and what it is composed of. This file boots nothing and presses nothing. It
// asserts the shape of what ships — which is the right instrument for the two
// claims it carries, because both are ABSENCES, and an absence in a running page
// is only an absence of what that page happened to do.
//
// THE TWO CLAIMS.
//
//   1. ONE ADDRESS, ONE REQUEST PRIMITIVE. The update surface reaches exactly one
//      off-origin address, that address is declared once on the knob surface, and
//      the surface has no second way to make a request at all. This is the shape
//      LSC-P3-INV-002 established for the export contour, and it is here for a
//      stronger reason: the export contour never went off-origin, and this one
//      does.
//
//   2. THIS MODULE WRITES NO TEXT. Every sentence a parent can read is a literal
//      in app/index.html, revealed by clearing `hidden`; the module assigns no
//      textContent and no innerHTML and builds no string that reaches the DOM.
//      That is what turns "no error message carries family data" from a promise
//      into a property — a string carrying anything about the family has nowhere
//      to come from. A running page cannot carry this claim: it would only show
//      that the messages it happened to display were clean.
//
// AND THE THINGS THE PACKET PROMISED NOT TO DO, which are absences too: no
// scheduler, no retry, no storage, no signal, and no install permission.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const {
    shippedPaths,
    expandShippedFiles,
    offlineUrls,
    currentMount,
} = require('./support/ship-list');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);

const SHIPPED = expandShippedFiles(
    shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
    APP_ROOT
);
const PRECACHED = offlineUrls(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));

const SURFACE_REL = `/m/${MOUNT.dir}/surfaces/update.js`;
const SURFACE = fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'update.js'), 'utf8');
const CONFIG_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'channel', 'config.js'), 'utf8');
const CHANNEL_SURFACE = fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'channel.js'), 'utf8');
const MANIFEST = fs.readFileSync(
    path.join(REPO_ROOT, 'native', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8'
);

const API_URL = /updateApiUrl:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];

/** Source with block and line comments removed — every scan below reads code. */
function code(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SURFACE_CODE = code(SURFACE);

test.describe('the update surface reaches one declared address and has no second way to reach anything', () => {
    test('the address is declared on the knob surface, with provenance', () => {
        // M4-P3-INV-002's convention: a knob with no `changed_in` is a value with
        // no history, and this packet adds four.
        for (const knob of [
            'updateApiUrl',
            'updateCheckTimeoutMs',
            'releaseAssetPattern',
            'playInstallerPackage',
        ]) {
            const declaration = new RegExp(`changed_in:[^\\n]*[\\s\\S]*?\\n\\s*${knob}:`);
            expect(
                declaration.test(CONFIG_SOURCE),
                `${knob} is declared without a changed_in block above it`
            ).toBe(true);
        }
        expect(API_URL.startsWith('https://'), 'the update address is not https').toBe(true);
    });

    test('the address appears nowhere else in the shipped tree', () => {
        // ONE DECLARATION SITE, not one file on disk — the exclusion
        // export-contour.spec.js already argues for apkReleaseUrl and policyUrl: a
        // copy-forward bump leaves the frozen generation shipped and carrying the
        // same knob, which is the same declaration rather than a second one.
        const elsewhere = SHIPPED.filter((rel) => rel.endsWith('.js') || rel.endsWith('.html'))
            .filter((rel) => !/m\/v\d+\/channel\/config\.js$/.test(rel))
            .filter((rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8').includes(API_URL));
        expect(
            elsewhere,
            'the update address appears outside the knob surface — it is declared once or not at all'
        ).toEqual([]);
    });

    test('the host itself appears nowhere outside the knob surface and the policy', () => {
        // Wider than the leg above and deliberately so: a second PATH on the same
        // host would slip past an exact-URL scan, and the claim the policy makes
        // is about the host a parent's phone contacts.
        //
        // AND THE POLICY IS THE ONE PLACE THAT MUST NAME IT, which is the same
        // exclusion export-contour.spec.js already argues for policyUrl and for
        // the same reason: /privacy.html is the DOCUMENT, and edition 1.3 §6 tells
        // a parent which host their phone contacts. Refusing it that word would be
        // this guard forbidding the disclosure it exists to make checkable. The
        // exclusion is paid for immediately below, with something stricter: in
        // that one file the host may be NAMED and may never be REACHED.
        const host = new URL(API_URL).hostname;
        const POLICY_DOCUMENT = '/privacy.html';
        const elsewhere = SHIPPED.filter((rel) => rel.endsWith('.js') || rel.endsWith('.html'))
            .filter((rel) => !/m\/v\d+\/channel\/config\.js$/.test(rel))
            .filter((rel) => rel !== POLICY_DOCUMENT)
            .filter((rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8').includes(host));
        expect(elsewhere, `${host} is named outside the knob surface`).toEqual([]);
    });

    test('the policy names the host and never links it', () => {
        // The price of the exclusion above, and it is stricter than what it
        // replaces. ANTI-VACUITY first: the document must actually carry the
        // disclosure, or this leg would be guarding a sentence that is not there
        // — which is precisely the defect edition 1.2 was published to fix.
        const host = new URL(API_URL).hostname;
        const policy = fs.readFileSync(path.join(APP_ROOT, 'privacy.html'), 'utf8');
        expect(
            policy.includes(host),
            `the published policy does not name ${host} — edition 1.3 exists to disclose this call`
        ).toBe(true);
        for (const attribute of ['href', 'src', 'action', 'formaction']) {
            expect(
                new RegExp(`${attribute}="[^"]*${host.replace(/\./g, '\\.')}`).test(policy),
                `the policy page links ${host} rather than naming it`
            ).toBe(false);
        }
    });

    test('every fetch in the surface addresses the knob, and there is exactly one', () => {
        const calls = [...SURFACE_CODE.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
        // ANTI-VACUITY: a regex that matched nothing would make the assertion
        // below vacuously true, which is failure mode 3 of AGENTS.md §11.
        expect(calls.length, 'no fetch call site found in the update surface').toBe(1);
        expect(calls[0], 'the update surface fetches something other than the declared knob')
            .toBe('CHANNEL_CONFIG.updateApiUrl');
    });

    test('the surface has no second request primitive', () => {
        for (const forbidden of [
            'XMLHttpRequest',
            'sendBeacon',
            'WebSocket',
            'EventSource',
            'navigator.',
            'import(',
            'new Image',
            'document.createElement',
        ]) {
            expect(
                SURFACE_CODE.includes(forbidden),
                `the update surface reaches for ${forbidden}`
            ).toBe(false);
        }
    });

    test('the request is composed without a credential', () => {
        // The static twin of the executing composition leg. It cannot know what a
        // browser actually sent — that is update-check.spec.js — but it can pin
        // the three options that decide it, so a later edit that drops one is red
        // here before anyone runs a browser.
        expect(SURFACE_CODE).toContain("credentials: 'omit'");
        expect(SURFACE_CODE).toContain("referrerPolicy: 'no-referrer'");
        expect(SURFACE_CODE).toContain("cache: 'no-store'");
        expect(SURFACE_CODE, 'the update surface names a token or an authorization header')
            .not.toMatch(/authorization|Authorization|token|Bearer/);
    });
});

test.describe('the update surface writes no text a parent can read', () => {
    test('it assigns no textContent, no innerHTML and no node of its own', () => {
        for (const forbidden of [
            'textContent',
            'innerHTML',
            'innerText',
            'insertAdjacentHTML',
            'createTextNode',
            'append(',
            'appendChild',
        ]) {
            expect(
                SURFACE_CODE.includes(forbidden),
                `the update surface writes text through ${forbidden} — a message it builds could`
                    + ' carry anything the app knows, which is exactly what this guard exists to'
                    + ' make impossible rather than merely unlikely'
            ).toBe(false);
        }
    });

    test('every sentence it reveals is a literal in the shell, and every literal is reachable', () => {
        const declared = [...SURFACE.matchAll(/'(updateStatus[A-Za-z]+)'/g)].map((m) => m[1]);
        const unique = [...new Set(declared)];
        expect(unique.length, 'the surface names no status lines at all').toBeGreaterThan(5);

        for (const id of unique) {
            const element = new RegExp(`<p\\b[^>]*\\bid="${id}"[^>]*>([^<]+)</p>`).exec(SHELL);
            expect(element, `${id} is revealed by the surface but is not a paragraph in the shell`)
                .not.toBeNull();
            expect(
                /\bhidden\b/.test(element[0]),
                `${id} does not ship hidden — an outcome would be on screen before any check ran`
            ).toBe(true);
            expect(element[1].trim().length, `${id} is an empty sentence`).toBeGreaterThan(0);
        }

        // And the other direction: a sentence in the shell that nothing can reveal
        // is a message the product cannot deliver.
        const inShell = [...SHELL.matchAll(/<p\b[^>]*\bid="(updateStatus[A-Za-z]+)"/g)].map(
            (m) => m[1]
        );
        expect(inShell.length, 'the shell carries no status lines').toBeGreaterThan(5);
        expect(
            inShell.filter((id) => !unique.includes(id)),
            'the shell carries a status sentence the surface can never reveal'
        ).toEqual([]);
    });

    test('the install affordance is a link to the declared page, addressed at runtime', () => {
        const link = /<a\b[^>]*\bid="updateInstallLink"[^>]*>/.exec(SHELL);
        expect(link, 'the install affordance is missing from the shell').not.toBeNull();
        expect(/\bhidden\b/.test(link[0]), 'the install link ships revealed').toBe(true);
        expect(
            /\bhref\s*=/.test(link[0]),
            'the install link carries a hard-coded href — the address is declared in channel/config.js'
        ).toBe(false);
        expect(link[0]).toContain('target="_blank"');
        expect(link[0]).toContain('rel="noopener noreferrer"');
        // It opens the RELEASE PAGE, from the knob that already declares it — the
        // app does not download, stage or install anything (vault ADR-052 §1.3).
        expect(SURFACE_CODE).toContain('CHANNEL_CONFIG.apkReleaseUrl');
    });

    test('the row ships hidden, keeps the menu open, and is named the same way in three places', () => {
        const row = /<button\b[^>]*\bid="menuUpdateBtn"[^>]*>/.exec(SHELL);
        expect(row, 'the update row is missing from the shell').not.toBeNull();
        expect(/\bhidden\b/.test(row[0]), 'the update row ships revealed').toBe(true);
        expect(
            row[0].includes('data-keeps-menu-open'),
            'the update row does not declare that it keeps the menu open — the panel would shut'
                + ' under the answer it is showing'
        ).toBe(true);

        const name = /\baria-label="([^"]+)"/.exec(row[0])[1];
        expect(row[0]).toContain(`title="${name}"`);
        expect(
            SHELL.includes(`<span class="header-menu-item-label">${name}</span>`),
            'the visible caption differs from the accessible name'
        ).toBe(true);
    });

    test('menu.js honours the attribute rather than a list of row ids', () => {
        const menu = code(fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'menu.js'), 'utf8'));
        expect(menu).toContain('data-keeps-menu-open');
        expect(
            menu.includes('menuUpdateBtn'),
            'menu.js names the update row by id — the carve-out is a rule about rows, not about'
                + ' this one row'
        ).toBe(false);
    });
});

test.describe('what the update check deliberately does not do', () => {
    test('nothing schedules it, and nothing retries it', () => {
        for (const forbidden of [
            'setInterval',
            'requestIdleCallback',
            'requestAnimationFrame',
            'visibilitychange',
            "'online'",
            "'focus'",
            'retry',
            'queueMicrotask',
        ]) {
            expect(
                SURFACE_CODE.includes(forbidden),
                `the update surface reaches for ${forbidden}`
            ).toBe(false);
        }
        // Exactly one timer, and it is the abort deadline. A second one is either
        // a retry or a poll, and both are out of this packet by its own scope.
        const timers = [...SURFACE_CODE.matchAll(/setTimeout\(/g)];
        expect(timers.length, 'the update surface sets more than one timer').toBe(1);
        expect(SURFACE_CODE).toContain('AbortController');
        expect(SURFACE_CODE).toContain('CHANNEL_CONFIG.updateCheckTimeoutMs');
    });

    test('nothing about the outcome is stored', () => {
        for (const forbidden of [
            'localStorage',
            'sessionStorage',
            'indexedDB',
            'document.cookie',
            'caches',
            'CacheStorage',
        ]) {
            expect(
                SURFACE_CODE.includes(forbidden),
                `the update surface persists something through ${forbidden}`
            ).toBe(false);
        }
    });

    test('no signal is emitted, and none is declared', () => {
        // THE ABSENCE IS A DECISION AND IS ASSERTED AS ONE (ADR-013 / contract
        // §4.7). Declaring an `update.check` kind would be declaring a counter of
        // presses, and there is no analytics on either channel since UIP-P1. The
        // candidate that WOULD need one — an opt-in fleet pulse — is a separate
        // future gate (vault ADR-052 §2) and is neither taken nor rejected here.
        expect(SURFACE_CODE.includes('emitSignal'), 'the update surface emits a signal').toBe(false);
        const signals = fs.readFileSync(path.join(MOUNT_DIR, 'core', 'signals.js'), 'utf8');
        expect(
            /'update\.[a-z]+':/.test(signals),
            'the signal taxonomy declares an update kind — this packet deliberately adds none'
        ).toBe(false);
    });

    test('the manifest gains no permission, and names none of the self-update ones', () => {
        // vault ADR-052 §1.3: the permission Play forbids for self-updating is not
        // introduced, and the manifest is shared by the GitHub- and Play-channel
        // copies, so there is nowhere to introduce it "just for one channel".
        for (const forbidden of [
            'REQUEST_INSTALL_PACKAGES',
            'UPDATE_PACKAGES_WITHOUT_USER_ACTION',
            'FOREGROUND_SERVICE',
            'RECEIVE_BOOT_COMPLETED',
            'WAKE_LOCK',
        ]) {
            expect(MANIFEST.includes(forbidden), `the manifest declares ${forbidden}`).toBe(false);
        }
        // The one permission there is, unchanged and already present before this
        // packet — which is why the packet touches no manifest at all.
        const permissions = [...MANIFEST.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)]
            .map((m) => m[1]);
        expect(permissions).toEqual(['android.permission.INTERNET']);
    });

    test('the channel seam decides the offer, and the surface does not decide it again', () => {
        expect(CHANNEL_SURFACE).toContain('export function shouldOfferUpdate');
        expect(SURFACE_CODE).toContain('shouldOfferUpdate');
        expect(
            SURFACE_CODE.includes('playInstallerPackage'),
            'the update surface compares the Play token itself — that decision lives in'
                + ' surfaces/channel.js, and a second copy is a second mechanism'
        ).toBe(false);
    });
});

test.describe('the module ships with the mount', () => {
    test('it is in the ship list, precached, and preloaded by the shell', () => {
        expect(SHIPPED, 'the update surface is not in the image').toContain(SURFACE_REL);
        expect(
            PRECACHED,
            'the update surface is not precached — an offline shell would boot without it'
        ).toContain(SURFACE_REL);
        expect(
            SHELL.includes(`<link rel="modulepreload" href="${SURFACE_REL}">`),
            'the shell does not preload the update surface'
        ).toBe(true);
    });
});
