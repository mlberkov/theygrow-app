'use strict';

// What each delivery channel actually OFFERS (DIA-P2).
//
// WHY THIS FILE EXISTS AND WHY IT LOADS A PAGE. "The web channel no longer
// offers the archive" is a fact about a rendered document, not a substring in a
// source file (AGENTS.md §11). The static half — the control is in the header,
// it ships `hidden`, its name is one string in three places, the address is
// declared once — is app/tests/export-contour.spec.js, and it would stay green
// against a shell that revealed everything at boot. So this file loads the shell
// in a real browser, on both branches, and reads what a parent would see.
//
// HOW THE NATIVE BRANCH IS REACHED, and what that costs in honesty. Until this
// packet nothing in the Playwright layer took the native branch at all: neither
// the nginx mirror nor the staged Capacitor web root injects a bridge, so both
// took the web branch of every probe (behavior.spec.js states it). Here an init
// script installs the SMALLEST Capacitor stand-in that the channel probe reads —
// `isNativePlatform()` and nothing else — before any shell script runs. What
// that buys is the channel branch, executed. What it does NOT buy, stated so no
// one reads more into a green: there is no plugin behind it, so the store does
// not open, the export sink is unavailable, and nothing here says anything about
// whether an archive can actually be written. That is
// ExportTransferTest on the emulator, and the owner-run smoke.
//
// Nothing in this file writes to Web Storage, and the pages it opens are the
// shipped ones.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('@playwright/test');
const { gotoApp, STATES } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);
const CHANNEL_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'channel');

// The shipped knob surface, read rather than restated: a test that wrote the
// address down again would agree with itself after the knob changed.
const CONFIG_SOURCE = fs.readFileSync(path.join(CHANNEL_DIR, 'config.js'), 'utf8');
const RELEASE_URL = /apkReleaseUrl:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const PUBLISHED_VALUE = /releaseStatePublished:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const STATE_META = /releaseStateMeta:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];

// The state the SHELL declares today. Read out of the shipped markup for the
// same reason: this spec asserts what this build offers, not what a constant in
// a test says it should.
const DECLARED_STATE = new RegExp(
    `<meta name="${STATE_META}" content="([^"]*)"`
).exec(SHELL)[1];

/**
 * Installs the smallest thing the channel probe accepts as the native shell.
 *
 * Registered as an init script so it is in place before the head shim computes
 * window.IS_NATIVE_SHELL — the same ordering handoff-transfer.spec.js relies on
 * for its storage recorder.
 */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

test.describe('the web channel offers what it can deliver, and nothing else', () => {
    test('the archive control is not offered in a browser', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });

        // ANTI-VACUITY FIRST. A selector typo, a renamed id or a shell that
        // failed to boot would all make "not visible" true for the wrong
        // reason. So: the control is IN the document, and a control this
        // channel does offer is visible in the same shot.
        await expect(page.locator('#exportBtn')).toHaveCount(1);
        await expect(page.locator('#activitiesBtn')).toBeVisible();

        await expect(page.locator('#exportBtn')).toBeHidden();

        // And the surface behind it stays shut, which is the point of removing
        // the control rather than only the action.
        await expect(page.locator('#exportModal')).toBeHidden();
    });

    test('the browser channel says the copy it holds is the only one', async ({ page }) => {
        // The sentence the archive modal used to carry, on the channel it is
        // true for. Executed rather than scanned: it must be on screen without
        // opening anything.
        await gotoApp(page, { state: STATES.seeded });

        const note = page.locator('#webChannelNote');
        await expect(note).toBeVisible();
        await expect(note).toContainText('только в этом браузере');
        await expect(note).toContainText('резервной копии');
    });

    test('the download control follows the declared release state', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });

        const link = page.locator('#apkBtn');
        await expect(link).toHaveCount(1);

        // The address is wired from the knob whichever branch is taken — the
        // link is never left addressing nothing.
        await expect(link).toHaveAttribute('href', RELEASE_URL);

        if (DECLARED_STATE === PUBLISHED_VALUE) {
            await expect(link).toBeVisible();
        } else {
            // THE STATE THIS BUILD SHIPS. No release exists — no tag, no
            // published asset — so the control is withheld rather than pointing
            // a visitor at an empty page.
            await expect(link).toBeHidden();
        }
    });

    test('a shell declaring a published release offers the download', async ({ page }) => {
        // THE OTHER BRANCH, EXECUTED — and executed on the SHIPPED module, not
        // on a copy of its logic. The page is the real shell with one attribute
        // changed before boot: exactly the edit the owner makes after publishing
        // a release. Without this leg the reveal path would ship unobserved and
        // the gate could be inverted without anything going red.
        await page.addInitScript(
            ([meta, value]) => {
                // Registered before any script in the page, so this listener is
                // registered before the one m/v{N}/app.js adds — listeners fire
                // in registration order, so the attribute is already changed by
                // the time wireChannel() reads it.
                document.addEventListener(
                    'DOMContentLoaded',
                    () => {
                        const tag = document.querySelector(`meta[name="${meta}"]`);
                        if (tag) tag.setAttribute('content', value);
                    },
                    { once: true }
                );
            },
            [STATE_META, PUBLISHED_VALUE]
        );
        await gotoApp(page, { state: STATES.seeded });

        // The mutation took — otherwise the assertion below would be about the
        // shipped state and would pass for the wrong reason.
        expect(
            await page.evaluate(
                (meta) => document.querySelector(`meta[name="${meta}"]`).getAttribute('content'),
                STATE_META
            )
        ).toBe(PUBLISHED_VALUE);

        await expect(page.locator('#apkBtn')).toBeVisible();
        await expect(page.locator('#apkBtn')).toHaveAttribute('href', RELEASE_URL);
    });
});

test.describe('the native branch offers the archive, and its modal is actually visible', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
    });

    test('the page really took the native branch', async ({ page }) => {
        // The premise of every assertion in this block, asserted rather than
        // assumed: an init script that silently failed to run would make the
        // rest of this file test the web branch twice.
        await gotoApp(page, { state: STATES.seeded });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
    });

    test('the archive control is offered, and the download control is not', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#exportBtn')).toBeVisible();
        await expect(page.locator('#apkBtn')).toBeHidden();

        // The browser-only sentence does not follow the app inside: on this
        // channel the device store is the source of truth, and the statement
        // would be false.
        await expect(page.locator('#webChannelNote')).toBeHidden();
    });

    test('clicking #exportBtn shows the modal, and closing it hides it again', async ({ page }) => {
        // MOVED HERE FROM behavior.spec.js, UNCHANGED IN SUBSTANCE (EMV-DL-001,
        // DIA-P2). Empty openExportModal()'s body, or delete the .modal.show
        // rule, and this reds — which is why show-rule-coverage.spec.js is not
        // allowed to stand in for it.
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#exportModal')).toBeHidden();

        await page.locator('#exportBtn').click();

        await expect(page.locator('#exportModal')).toBeVisible();
        await expect(page.locator('#exportModal')).toHaveCSS('display', 'block');

        await page.locator('#exportModalClose').click();
        await expect(page.locator('#exportModal')).toBeHidden();
        await expect(page.locator('#exportModal')).toHaveCSS('display', 'none');
    });
});

test.describe('the offer decision itself, both branches (module-level)', () => {
    // NOT A RUNTIME CLAIM ABOUT THE PRODUCT, and labelled so. This block imports
    // the SHIPPED decision function and drives its truth table off-device. It
    // starts no page and presses nothing; what it covers is the combinations the
    // two page legs above cannot both hold at once — a native shell that also
    // declares a published release, and an unknown state token.
    let shouldOfferApk = null;

    test.beforeAll(async () => {
        // The same Node plumbing store-unit.spec.js documents: a real dynamic
        // import Playwright's CommonJS transform will not rewrite, and a temp
        // directory carrying the ESM marker that app/m/ cannot carry because
        // everything under it ships.
        const dynamicImport = new Function('specifier', 'return import(specifier)');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-channel-'));
        fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
        for (const [from, sub] of [
            [path.join(APP_ROOT, 'm', MOUNT.dir, 'surfaces', 'channel.js'), 'surfaces'],
            [path.join(CHANNEL_DIR, 'config.js'), 'channel'],
        ]) {
            fs.mkdirSync(path.join(root, sub), { recursive: true });
            const to = path.join(root, sub, path.basename(from));
            fs.copyFileSync(from, to);
            expect(
                fs.readFileSync(to).equals(fs.readFileSync(from)),
                `${sub}/${path.basename(from)} was not copied verbatim — this spec would test a different file`
            ).toBeTruthy();
        }
        ({ shouldOfferApk } = await dynamicImport(
            `file://${path.join(root, 'surfaces', 'channel.js')}`
        ));
    });

    test('the offer needs a published release AND the web channel', () => {
        expect(shouldOfferApk(PUBLISHED_VALUE, false)).toBe(true);
        expect(shouldOfferApk(PUBLISHED_VALUE, true)).toBe(false);
        expect(shouldOfferApk('none', false)).toBe(false);
        expect(shouldOfferApk('none', true)).toBe(false);
    });

    test('anything that is not the declared value means no release', () => {
        // Fail-closed, and this is the half a typo would break: a missing tag,
        // an empty value, a near-miss token. Each of these is a state an owner
        // edit can produce, and none of them may offer a download.
        for (const state of [null, undefined, '', ' published', 'Published', 'yes', 'true']) {
            expect(shouldOfferApk(state, false), `"${state}" was treated as published`).toBe(false);
        }
    });
});
