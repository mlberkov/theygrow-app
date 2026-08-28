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
// The withheld token. There is no knob for it and there should not be: the gate
// is fail-closed, so EVERY value that is not `policyStatePublished` means the
// same thing, and the truth table below drives seven of them. This one is the
// value the shell shipped from L3-P3 until the PPR-P3 flip, which makes it the
// state a rollback returns to — the one worth executing a page against.
const POLICY_WITHHELD_VALUE = 'none';

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
 * window.IS_NATIVE_SHELL. The ordering is the point: an init script registered
 * after the fact would leave the page on the web branch and this block would
 * test it twice, which is why every describe using this helper opens with a
 * premise leg reading IS_NATIVE_SHELL back.
 */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

/**
 * Opens the intro window through whichever entry THIS channel offers (NAV-P1).
 *
 * WHY A BRANCH IS SOUND HERE AND WOULD NOT BE ANYWHERE ELSE. The entry moved
 * per channel: the web keeps the header control #aboutBtn, the app reaches the
 * same window through the header menu. A leg about the POLICY LINK or the
 * BROWSER-ONLY SENTENCE is not a leg about where the door is, and hard-coding
 * one door would make those legs red for a reason they are not about.
 *
 * The branch is only safe because the composition itself is asserted elsewhere,
 * per channel and without a branch — see the NAV-P1 block below, which pins that
 * the app offers the menu and NOT the header control, and the web the reverse.
 * Without those, this helper would happily pass on a channel showing both doors.
 */
async function openIntroWindow(page) {
    if (await page.locator('#headerMenu').isVisible()) {
        // Pressing the toggle unconditionally would CLOSE a panel a caller had
        // already opened, and the failure would read as "the row is not visible"
        // rather than as "this helper shut it".
        if (!(await page.locator('#headerMenuPanel').isVisible())) {
            await page.locator('#menuBtn').click();
        }
        await page.locator('#menuAboutBtn').click();
        return;
    }
    await page.locator('#aboutBtn').click();
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
        // true for. Executed rather than scanned.
        //
        // IT MOVED INTO THE INTRO WINDOW AT UIP-P3, and the leg moved with it.
        // DIA-P2 put it above the table precisely so a parent met it without
        // opening anything; the owner reversed that on 2026-08-25 because the
        // top of the page said the same things twice. The cost is real and is
        // what this leg now shows: the sentence is reached by pressing the
        // header control, and by nothing else. `UIP-DL-003` records the choice.
        await gotoApp(page, { state: STATES.seeded });

        const note = page.locator('#webChannelNote');
        // Before the window is opened it is in the document and off screen —
        // asserted so "visible" below is a fact about the reveal and not about
        // an element that was on screen all along.
        await expect(note).toHaveCount(1);
        await expect(note).toBeHidden();

        await page.locator('#aboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

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

    // WHICH PLATFORM IS LOOKING, AND WHAT IT IS OFFERED (PPR-P2, debt 21).
    //
    // Two ways to say "this is an Android phone", because there are two in the
    // wild: Chromium answers navigator.userAgentData.platform, and everything
    // else leaves the token in the user-agent string. Playwright sets a real
    // user-agent header and navigator.userAgent from test.use(); userAgentData is
    // defined by an init script, because no browser lets a test set it.
    //
    // The header control is NOT branched on platform and that is the decision,
    // recorded here where the reader will ask: it opens a window that explains
    // what the app is and where the family's data lives, which is worth reading
    // on any device. What is withheld is the OFFER — the link that hands over a
    // package — because that is the thing a non-Android visitor cannot act on.
    const declarePlatform = async (page, platform) => {
        await page.addInitScript((value) => {
            Object.defineProperty(navigator, 'userAgentData', {
                configurable: true,
                get: () => ({ platform: value }),
            });
        }, platform);
    };

    const ANDROID_UA =
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/126.0.0.0 Mobile Safari/537.36';
    const IPHONE_UA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

    const PLATFORM_SENTENCE =
        'Приложение работает на Android. Откройте эту страницу на телефоне с Android,'
        + ' чтобы установить.';

    const openInstallWindow = async (page) => {
        await gotoApp(page, { state: STATES.seeded });
        await expect(
            page.locator('#apkBtn'),
            'the header control is withheld, so this leg would prove nothing about the window'
        ).toBeVisible();
        await page.locator('#apkBtn').click();
        await expect(page.locator('#installModal')).toHaveCSS('display', 'block');
    };

    test('an Android visitor is offered the file', async ({ page }) => {
        test.skip(DECLARED_STATE !== PUBLISHED_VALUE, 'no release is declared published');
        await declarePlatform(page, 'Android');
        await openInstallWindow(page);

        await expect(page.locator('#installDownloadLink')).toBeVisible();
        await expect(page.locator('#installDownloadLink')).toHaveAttribute('href', RELEASE_URL);
        await expect(
            page.locator('#installPlatformNote'),
            'the visitor who can install is told to go somewhere else as well'
        ).toBeHidden();
    });

    // A REAL USER-AGENT, SET WHERE PLAYWRIGHT ALLOWS IT. test.use() is a describe-
    // level fixture and throws inside a test body, so the two string-driven legs
    // sit in their own blocks. They are worth the two extra describes: Firefox and
    // Safari on Android expose no userAgentData at all, so the string is the only
    // source there, and a probe that read only the declared value would pass every
    // Chromium test in this file and still offer a real Android visitor nothing.
    test.describe('driven by the user-agent string, with nothing declared', () => {
        test.use({ userAgent: ANDROID_UA });

        test('an Android string alone is enough to be offered the file', async ({ page }) => {
            test.skip(DECLARED_STATE !== PUBLISHED_VALUE, 'no release is declared published');
            await openInstallWindow(page);
            await expect(page.locator('#installDownloadLink')).toBeVisible();
            await expect(page.locator('#installPlatformNote')).toBeHidden();
        });
    });

    test.describe('driven by an iPhone user-agent string', () => {
        test.use({ userAgent: IPHONE_UA });

        test('an iPhone is offered the sentence, from its own user-agent', async ({ page }) => {
            test.skip(DECLARED_STATE !== PUBLISHED_VALUE, 'no release is declared published');
            await openInstallWindow(page);
            await expect(page.locator('#installDownloadLink')).toBeHidden();
            await expect(page.locator('#installPlatformNote')).toHaveText(PLATFORM_SENTENCE);
        });
    });

    test('a visitor who cannot install it is told so, in the same slot', async ({ page }) => {
        test.skip(DECLARED_STATE !== PUBLISHED_VALUE, 'no release is declared published');
        await declarePlatform(page, 'macOS');
        await openInstallWindow(page);

        await expect(
            page.locator('#installDownloadLink'),
            'an iPhone or a desktop is offered an Android package — the defect PDR-034 §1 names'
        ).toBeHidden();
        const note = page.locator('#installPlatformNote');
        await expect(note).toBeVisible();
        await expect(note).toHaveText(PLATFORM_SENTENCE);
    });

    test('an unreadable platform gets the sentence, never the offer', async ({ page }) => {
        // THE FAILURE DIRECTION, EXECUTED. Platform detection is a heuristic; what
        // is not a heuristic is which way it falls when it cannot tell.
        test.skip(DECLARED_STATE !== PUBLISHED_VALUE, 'no release is declared published');
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'userAgentData', {
                configurable: true,
                get: () => undefined,
            });
            Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => '' });
        });
        await openInstallWindow(page);

        await expect(page.locator('#installDownloadLink')).toBeHidden();
        await expect(page.locator('#installPlatformNote')).toBeVisible();
    });

    test('an undeclared release offers neither the file nor the sentence', async ({ page }) => {
        // The declaration stays in front of everything: withheld means nothing is
        // offered at all, not "offered with an explanation". Driven by mutating
        // the meta before boot, so this leg runs whatever the shell ships today.
        await declareBeforeBoot(page, STATE_META, 'none');
        await declarePlatform(page, 'Android');
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#apkBtn')).toBeHidden();
        await expect(page.locator('#installDownloadLink')).toBeHidden();
        await expect(
            page.locator('#installPlatformNote'),
            'the window is unreachable, and its slot is explaining an offer that is not being made'
        ).toBeHidden();
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
        // The parent can actually read it, and the offer slot is filled.
        //
        // EITHER-OR SINCE PPR-P2, and deliberately not "the link is visible": on
        // this runner the browser is a desktop Chromium, which is exactly the
        // visitor the packet stopped offering an Android package to. What the
        // window must never be is a button row with nothing in it, so the leg
        // asserts the slot is occupied and leaves WHICH of the two to the legs
        // above, whose subject that is.
        await expect(page.locator('#installModal h2')).toBeVisible();
        const linkShown = await page.locator('#installDownloadLink').isVisible();
        const noteShown = await page.locator('#installPlatformNote').isVisible();
        expect(
            linkShown !== noteShown,
            `the offer slot shows ${linkShown && noteShown ? 'both' : 'neither'} the download link`
                + ' and the platform sentence — it holds exactly one of them'
        ).toBe(true);

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

        // NAV-P1: the archive is offered BEHIND THE MENU on this channel, so the
        // offer is now two facts rather than one — the menu is there, and the
        // archive is inside it. Asserted in that order: a menu that failed to
        // open would otherwise read as an archive that was never offered.
        await expect(page.locator('#headerMenu')).toBeVisible();
        await expect(page.locator('#exportBtn')).toBeHidden();

        await page.locator('#menuBtn').click();
        await expect(page.locator('#exportBtn')).toBeVisible();

        await expect(page.locator('#apkBtn')).toBeHidden();

        // The browser-only sentence does not follow the app inside: on this
        // channel the device store is the source of truth, and the statement
        // would be false.
        //
        // THE WINDOW IS OPENED FIRST, AND THAT IS NOT CEREMONY (UIP-P3). Since
        // the sentence moved inside the intro, a closed window would make
        // `toBeHidden()` true for the wrong reason — an element inside a
        // `display: none` modal is hidden whatever the channel gate decided.
        // Opening it puts the channel branch back in front of the assertion.
        await openIntroWindow(page);
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await expect(page.locator('#webChannelNote')).toHaveCount(1);
        await expect(page.locator('#webChannelNote')).toBeHidden();
    });

    test('clicking #exportBtn shows the modal, and closing it hides it again', async ({ page }) => {
        // MOVED HERE FROM behavior.spec.js, UNCHANGED IN SUBSTANCE (EMV-DL-001,
        // DIA-P2). Empty openExportModal()'s body, or delete the .modal.show
        // rule, and this reds — which is why show-rule-coverage.spec.js is not
        // allowed to stand in for it.
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#exportModal')).toBeHidden();

        // NAV-P1 put the control inside the menu; the handler behind it is the
        // same listener surfaces/export.js has always installed, which is the
        // point of the relocation being a relocation.
        await page.locator('#menuBtn').click();
        await page.locator('#exportBtn').click();

        await expect(page.locator('#exportModal')).toBeVisible();
        await expect(page.locator('#exportModal')).toHaveCSS('display', 'block');

        await page.locator('#exportModalClose').click();
        await expect(page.locator('#exportModal')).toBeHidden();
        await expect(page.locator('#exportModal')).toHaveCSS('display', 'none');
    });
});

test.describe('the header menu is the app\'s entry and the web has none (NAV-P1-INV-001)', () => {
    // WHAT THIS BLOCK IS FOR. NAV-P1 moved two controls without changing what
    // either of them does, and "without changing" is exactly the kind of claim
    // that passes by inspection and fails in the hand. So every leg here RUNS
    // the product: a real page loads, a real control is pressed, and the window
    // that comes up is the one the handler was always wired to.
    //
    // IT ALSO PINS THE PACKET BOUNDARY. The panel carries exactly two rows. The
    // «Обновление» item belongs to the next packet, together with the first
    // network call this channel makes and edition v1.3 of the policy (vault
    // ADR-052 §1); a placeholder row landing early would red here rather than
    // ship a control that promises something nothing does.

    test.describe('the web channel', () => {
        test('keeps the header control and is offered no menu', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            // ANTI-VACUITY: both entries are IN the document on both channels —
            // one build, one set of bytes (LSC-P1-INV-002). What differs is
            // which one this channel reveals.
            await expect(page.locator('#aboutBtn')).toHaveCount(1);
            await expect(page.locator('#headerMenu')).toHaveCount(1);
            await expect(page.locator('#menuAboutBtn')).toHaveCount(1);

            await expect(page.locator('#aboutBtn')).toBeVisible();
            await expect(page.locator('#headerMenu')).toBeHidden();
            // The hidden attribute is only worth having if the class does not
            // defeat it — the fourth case of the rule .header-help[hidden]
            // announced in advance. A missing .header-menu[hidden] rule shows up
            // here as a menu standing open on the showcase.
            await expect(page.locator('#headerMenu')).toHaveCSS('display', 'none');
        });

        test('the header control still opens the intro, unchanged', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await expect(page.locator('#onboardingModal')).toBeHidden();
            await page.locator('#aboutBtn').click();
            await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
            await expect(page.locator('#onboardingModal')).toHaveCSS('display', 'flex');
        });
    });

    test.describe('the native channel', () => {
        test.beforeEach(async ({ page }) => {
            await simulateNativeShell(page);
        });

        test('took the native branch', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });
            expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
        });

        test('offers the menu and not the header control, with the panel shut', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await expect(page.locator('#headerMenu')).toBeVisible();
            await expect(page.locator('#menuBtn')).toBeVisible();

            await expect(page.locator('#aboutBtn')).toHaveCount(1);
            await expect(page.locator('#aboutBtn')).toBeHidden();
            await expect(page.locator('#aboutBtn')).toHaveCSS('display', 'none');

            // Shut by default, and said so where a screen reader reads it.
            await expect(page.locator('#headerMenuPanel')).toBeHidden();
            await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'false');
        });

        test('pressing it opens exactly two named rows, and no third', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await page.locator('#menuBtn').click();

            await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);
            await expect(page.locator('#headerMenuPanel')).toHaveCSS('display', 'block');
            await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'true');

            const rows = page.locator('#headerMenuPanel button');
            await expect(rows).toHaveCount(2);
            await expect(rows.nth(0)).toHaveAttribute('aria-label', 'О приложении');
            await expect(rows.nth(1)).toHaveAttribute('aria-label', 'Сохранить архив');

            // The rows are readable, not only reachable: in a list an unlabelled
            // row says nothing, so the archive's caption is visible here even on
            // the narrow layout where the header row hides it.
            await expect(rows.nth(0)).toBeVisible();
            await expect(rows.nth(1)).toBeVisible();
            await expect(page.locator('.header-menu-item-label')).toBeVisible();
            await expect(page.locator('#exportBtn .header-action-label')).toBeVisible();
        });

        test('«О приложении» opens the intro and closes the menu', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await expect(page.locator('#onboardingModal')).toBeHidden();

            await page.locator('#menuBtn').click();
            await page.locator('#menuAboutBtn').click();

            // The same window the web control opens, by the same handler.
            await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
            await expect(page.locator('#onboardingModal')).toHaveCSS('display', 'flex');
            await expect(page.locator('#onboardingModal h2')).toBeVisible();

            // And the list gets out of the way of what it opened.
            await expect(page.locator('#headerMenuPanel')).toBeHidden();
            await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'false');
        });

        test('«Сохранить архив» opens the archive window and closes the menu', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await expect(page.locator('#exportModal')).toBeHidden();

            await page.locator('#menuBtn').click();
            await page.locator('#exportBtn').click();

            await expect(page.locator('#exportModal')).toBeVisible();
            await expect(page.locator('#exportModal')).toHaveCSS('display', 'block');
            await expect(page.locator('#headerMenuPanel')).toBeHidden();
        });

        test('Escape closes the menu and hands the focus back', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await page.locator('#menuBtn').click();
            await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);

            await page.keyboard.press('Escape');

            await expect(page.locator('#headerMenuPanel')).toBeHidden();
            await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'false');
            // Closing with the keyboard must not lose the place: without the
            // focus return the next Tab starts from the top of the document.
            await expect(page.locator('#menuBtn')).toBeFocused();
        });

        test('a click outside closes the menu', async ({ page }) => {
            await gotoApp(page, { state: STATES.seeded });

            await page.locator('#menuBtn').click();
            await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);

            await page.locator('header h1').click({ force: true });

            await expect(page.locator('#headerMenuPanel')).toBeHidden();
            await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'false');
        });
    });

    test('the two channels name the intro entry with the SAME string', async ({ page }) => {
        // THE POLICY QUOTES THIS STRING (vault PDR-035, annotation 2026-08-27),
        // and app/tests/privacy-page.spec.js reads it off #aboutBtn. If the app's
        // row drifted from the web control's name, that guard would stay green
        // while the document named a control half the readers cannot find. This
        // leg is the half that guard cannot see: it compares the two entries to
        // each other, in the running page.
        await gotoApp(page, { state: STATES.seeded });

        const names = await page.evaluate(() => [
            document.getElementById('aboutBtn').getAttribute('aria-label'),
            document.getElementById('menuAboutBtn').getAttribute('aria-label'),
        ]);

        expect(names[0], 'the web control lost its accessible name').toBeTruthy();
        expect(names[1], 'the menu row lost its accessible name').toBeTruthy();
        expect(names[1], 'the two channels now name the same window differently').toBe(names[0]);
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
    // BOTH LEGS EXECUTE, AND SINCE PPR-P3 BOTH DECLARE THEIR OWN STATE. The
    // shipped declaration is now `published` (PPR-DL-003), so the withheld leg
    // can no longer read the withheld state off the shell — it used to skip
    // itself when the shipped token was the published one, which would have
    // retired the half of this invariant that matters most on the day of the
    // flip, silently and green. Both legs now rewrite the shell's <meta> before
    // boot — the same edit the owner makes, on the same shipped module — and
    // both assert the mutation took, so neither can pass by re-testing the
    // other's state.
    //
    // THE ARM: make shouldOfferPolicy default-true, or drop the reveal from
    // wireChannel, and one of the two legs reds either way.

    test('the two legs between them cover the state this build actually ships', () => {
        // What the self-skip used to give away for free, kept as an assertion:
        // whichever way the declaration is set, one of the two legs below is
        // driving the shipped state rather than a state no build has.
        expect(
            [POLICY_PUBLISHED_VALUE, POLICY_WITHHELD_VALUE],
            `the shell declares "${DECLARED_POLICY_STATE}", which neither leg below executes`
        ).toContain(DECLARED_POLICY_STATE);
    });

    test('while the shell declares nothing, no policy link is offered', async ({ page }) => {
        await declareBeforeBoot(page, POLICY_META, POLICY_WITHHELD_VALUE);
        await gotoApp(page, { state: STATES.firstRun });

        // The mutation took — otherwise this would pass for the wrong reason,
        // which after the flip is the only way it could pass at all.
        expect(
            await page.evaluate(
                (meta) => document.querySelector(`meta[name="${meta}"]`).getAttribute('content'),
                POLICY_META
            )
        ).toBe(POLICY_WITHHELD_VALUE);

        // THE WINDOW IS OPENED FIRST, and the order is the assertion's meaning.
        // "Hidden" has to be a fact about the LINK, not about the window it sits
        // in — inside a closed modal every child is hidden whatever the
        // declaration said. Until UIP-P3 a first run opened the window by itself
        // and this leg asserted that it was open; the auto-open is gone (owner
        // decision 2026-08-25), so the control is what opens it, and the claim
        // underneath is unchanged.
        await page.locator('#aboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await expect(page.locator('#onboardingModal h2')).toBeVisible();

        // In the document — one set of bytes for both channels — and not in view.
        await expect(page.locator('#introPolicyLink')).toHaveCount(1);
        await expect(page.locator('#introPolicyLink')).toBeHidden();

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

            // The window opens on the control since UIP-P3 — the intro no longer
            // comes up by itself on a first run, on either channel. Since NAV-P1
            // the control is not the same one on both: the web keeps the header
            // button, the app reaches it through the menu.
            await openIntroWindow(page);
            await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

            const link = page.locator('#introPolicyLink');
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', POLICY_URL);
            // A new tab, and no referrer or opener handed to it.
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', /noopener/);
        });
    }
});
