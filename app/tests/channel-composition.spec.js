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

// The second declaration of the same shape (L3-P3), read the same way.
const POLICY_URL = /policyUrl:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const POLICY_PUBLISHED_VALUE = /policyStatePublished:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const POLICY_META = /policyStateMeta:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const DECLARED_POLICY_STATE = new RegExp(
    `<meta name="${POLICY_META}" content="([^"]*)"`
).exec(SHELL)[1];

/**
 * Rewrites one <meta> declaration before the app boots.
 *
 * The listener is registered before any script in the page, so it runs before
 * the one m/v{N}/app.js adds — listeners fire in registration order, so the
 * attribute is already changed by the time wireChannel() reads it. This is
 * exactly the edit an owner makes after publishing the thing.
 */
async function declareBeforeBoot(page, meta, value) {
    await page.addInitScript(
        ([name, content]) => {
            document.addEventListener(
                'DOMContentLoaded',
                () => {
                    const tag = document.querySelector(`meta[name="${name}"]`);
                    if (tag) tag.setAttribute('content', content);
                },
                { once: true }
            );
        },
        [meta, value]
    );
}

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

        const control = page.locator('#apkBtn');
        await expect(control).toHaveCount(1);

        // The address is wired from the knob whichever branch is taken — the
        // link is never left addressing nothing. Since L3-P3 the address is on
        // the link INSIDE the pre-install window, and the header control is a
        // button that opens that window.
        await expect(page.locator('#installDownloadLink')).toHaveAttribute('href', RELEASE_URL);

        if (DECLARED_STATE === PUBLISHED_VALUE) {
            // THE STATE THIS BUILD SHIPS since a8b2ec2, which declared the
            // release published.
            await expect(control).toBeVisible();
        } else {
            // No release declared, so the control is withheld rather than
            // pointing a visitor at an empty page.
            await expect(control).toBeHidden();
        }
    });

    test('pressing the download control opens the pre-install window, and it closes again', async ({
        page,
    }) => {
        // WHAT A VISITOR MEETS BETWEEN DECIDING AND DOWNLOADING (L3-P3). Before
        // this packet the answer was "nothing": the control went straight to a
        // releases page, and no surface anywhere said what the app is or what
        // happens to the family's data.
        //
        // THE ARM: empty the click handler in surfaces/channel.js, or delete the
        // `.modal.show` rule, and this reds. show-rule-coverage.spec.js is a
        // static scan and cannot stand in for it (AGENTS.md §11).
        test.skip(
            DECLARED_STATE !== PUBLISHED_VALUE,
            'the control is withheld in this build, so it cannot be pressed'
        );
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#installModal')).toBeHidden();

        await page.locator('#apkBtn').click();

        await expect(page.locator('#installModal')).toBeVisible();
        await expect(page.locator('#installModal')).toHaveCSS('display', 'block');
        // The parent can actually read it, and the download is inside it.
        await expect(page.locator('#installModal h2')).toBeVisible();
        await expect(page.locator('#installDownloadLink')).toBeVisible();

        await page.locator('#installModalClose').click();
        await expect(page.locator('#installModal')).toBeHidden();
    });

    test('the pre-install window says where the data lives, and sells nothing', async ({ page }) => {
        // The value contract, executed on the rendered text rather than asserted
        // about the source: PDR-006 layer B and PDR-003 §2 forbid comparison,
        // percentile, streak and deadline framing, and this is the one surface
        // where that framing would sell. A packet that "improves the copy" and
        // reaches for it reds here.
        test.skip(
            DECLARED_STATE !== PUBLISHED_VALUE,
            'the control is withheld in this build, so the window cannot be opened'
        );
        await gotoApp(page, { state: STATES.seeded });
        await page.locator('#apkBtn').click();

        const text = await page.locator('#installModal .modal-content').innerText();

        // It answers the question a parent actually has, and it disclaims the
        // two readings the subject matter invites. Asserted POSITIVELY rather
        // than by forbidding the word "сравнивать": the honest copy uses that
        // word to deny comparison, so a stem ban would forbid the sentence that
        // does the work.
        for (const promised of [
            'на самом телефоне',
            'никуда не отправляются',
            'не оценка и не диагноз',
            'ни с кем вашего ребёнка не сравнивает',
        ]) {
            expect(
                text,
                `the pre-install screen no longer says "${promised}" — this is where a parent decides whether to trust the app with their child`
            ).toContain(promised);
        }

        // And the framings that have no honest use on this surface. A packet
        // that "improves the copy" and reaches for one of these reds here.
        for (const forbidden of [
            'процентил',
            'рейтинг',
            'серия дней',
            'успей',
            'успеть',
            'не упусти',
            'отстава',
            'опережа',
            // Price is a public promise on the free/paid boundary; this packet
            // deliberately says nothing about it (FIU-DL-003).
            'бесплатн',
        ]) {
            expect(
                text.toLowerCase(),
                `the pre-install screen reaches for "${forbidden}" — ranking, deadline and price framing are forbidden here (PDR-006 layer B, PDR-003 §2)`
            ).not.toContain(forbidden);
        }
    });

    test('a shell declaring a published release offers the download', async ({ page }) => {
        // THE OTHER BRANCH, EXECUTED — and executed on the SHIPPED module, not
        // on a copy of its logic. The page is the real shell with one attribute
        // changed before boot: exactly the edit the owner makes after publishing
        // a release. Without this leg the reveal path would ship unobserved and
        // the gate could be inverted without anything going red.
        await declareBeforeBoot(page, STATE_META, PUBLISHED_VALUE);
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
        await expect(page.locator('#installDownloadLink')).toHaveAttribute('href', RELEASE_URL);
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
    let shouldOfferPolicy = null;

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
        ({ shouldOfferApk, shouldOfferPolicy } = await dynamicImport(
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

    test('the policy offer needs a published document, and nothing else', () => {
        // ONE ARGUMENT, DELIBERATELY (L3-P3). The download decision takes the
        // channel because a download is pointless where the app is installed;
        // the policy decision does not, because the person who needs it is the
        // one entering data, and that happens on both channels (PDR-035 §2).
        // This test is what would red if a later packet quietly added a channel
        // branch to it.
        expect(shouldOfferPolicy.length, 'shouldOfferPolicy grew an argument').toBe(1);
        expect(shouldOfferPolicy(POLICY_PUBLISHED_VALUE)).toBe(true);
        expect(shouldOfferPolicy('none')).toBe(false);
    });

    test('anything that is not the declared value means no policy', () => {
        // The same fail-closed table, and here it carries more: a link labelled
        // "privacy policy" that 404s is a promise about family data with nothing
        // behind it.
        for (const state of [null, undefined, '', ' published', 'Published', 'yes', 'true']) {
            expect(shouldOfferPolicy(state), `"${state}" was treated as published`).toBe(false);
        }
    });
});

test.describe('the privacy policy is linked only once it exists (FIU-P3-INV-002)', () => {
    // BOTH LEGS EXECUTE. The undeclared leg is the state this build ships, and
    // it is the one that matters most: the document is not published yet, so
    // nothing may offer it. The declared leg rewrites the shell's <meta> before
    // boot — the same edit the owner makes, on the same shipped module — so the
    // reveal path does not ship unobserved.
    //
    // THE ARM: make shouldOfferPolicy default-true, or drop the reveal from
    // wireChannel, and one of the two legs reds either way.

    test('while the shell declares nothing, no policy link is offered', async ({ page }) => {
        test.skip(
            DECLARED_POLICY_STATE === POLICY_PUBLISHED_VALUE,
            'this build declares the policy published, so the withheld state cannot be observed here'
        );
        await gotoApp(page, { state: STATES.firstRun });

        // In the document — one set of bytes for both channels — and not in view.
        await expect(page.locator('#introPolicyLink')).toHaveCount(1);
        await expect(page.locator('#introPolicyLink')).toBeHidden();

        // The intro is open on a first run, so "hidden" here is a fact about the
        // link and not about the window it sits in.
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await expect(page.locator('#onboardingModal h2')).toBeVisible();

        // And nowhere else either: this is the only home the link has.
        expect(
            await page.evaluate(() =>
                Array.from(document.querySelectorAll('a')).filter(
                    (a) => a.offsetParent !== null && /privacy|конфиденциальн/i.test(a.textContent + a.href)
                ).length
            ),
            'something is offering a policy link while the shell declares none'
        ).toBe(0);
    });

    for (const [channel, prepare] of [
        ['the web channel', async () => {}],
        ['the native channel', simulateNativeShell],
    ]) {
        test(`a shell declaring the policy published offers it on ${channel}`, async ({ page }) => {
            // BOTH CHANNELS, because that is the decision this packet made: the
            // parent reads it where they enter data, and they enter data in the
            // app. A regression that made this web-only would red here.
            await prepare(page);
            await declareBeforeBoot(page, POLICY_META, POLICY_PUBLISHED_VALUE);
            await gotoApp(page, { state: STATES.firstRun });

            // The mutation took — otherwise this would pass for the wrong reason.
            expect(
                await page.evaluate(
                    (meta) => document.querySelector(`meta[name="${meta}"]`).getAttribute('content'),
                    POLICY_META
                )
            ).toBe(POLICY_PUBLISHED_VALUE);

            const link = page.locator('#introPolicyLink');
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', POLICY_URL);
            // A new tab, and no referrer or opener handed to it.
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', /noopener/);
        });
    }
});
