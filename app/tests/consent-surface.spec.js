'use strict';

// What a browser actually fetches, and when (PPR-P2, PDR-035 §5).
//
// THIS IS THE EXECUTING HALF, and it is the only place in this repository where
// the claim "no request reaches googletagmanager.com until the visitor says yes"
// is made at all. app/tests/consent-gate.spec.js reads the source and says about
// itself that it boots nothing; a source scan can show there is one place the tag
// could be created, and it can never show that the page did not create it
// (AGENTS.md §11).
//
// HOW AN ABSENCE IS MADE PROVABLE HERE, in three parts, because an absence
// assertion is the easiest kind to pass for the wrong reason:
//
//   1. page.on('request') fires BEFORE routing, so the suite-wide analytics stub
//      in support/seed.js does not hide anything from it. That stub fulfils
//      rather than aborts (an abort would surface as a console error and collide
//      with the fixture's console guard), and a fulfilled request is still a
//      request this listener sees. app/tests/privacy-surface.spec.js records the
//      same argument for the same reason.
//   2. Every negative leg first asserts that the listener saw the DOCUMENT. A
//      listener attached too late, or a page that never loaded, makes every
//      absence below true about nothing.
//   3. The arm is not a mutation and not a mock: the third leg here grants
//      consent on the same page, with the same listener, and requires the request
//      to APPEAR. If the gate were wired to a tag nothing could ever load, that
//      leg goes red rather than this file going quietly green.

const fs = require('fs');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { gotoApp, seedStorage, STATES } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);

// Read out of the shipped sources, never restated. The measurement id in
// particular: this file asserts on Google's own ga-disable-<id> switch, and a
// second copy of that id here would agree with itself after a rotation.
const CONSENT_CONFIG_SOURCE = fs.readFileSync(
    path.join(APP_ROOT, 'm', MOUNT.dir, 'consent', 'config.js'),
    'utf8'
);
const GRANTED = /stateGranted:\s*'([^']+)'/.exec(CONSENT_CONFIG_SOURCE)[1];
const DENIED = /stateDenied:\s*'([^']+)'/.exec(CONSENT_CONFIG_SOURCE)[1];
const STORAGE_KEY = /const STORAGE_KEY_ANALYTICS_CONSENT = '([^']+)'/.exec(
    fs.readFileSync(path.join(APP_ROOT, 'm', MOUNT.dir, 'core', 'storage.js'), 'utf8')
)[1];
const MEASUREMENT_ID = /const GA_MEASUREMENT_ID = '([^']+)'/.exec(SHELL)[1];

// The copy is the orchestrator's and is compared verbatim: this banner is where
// the packet's no-dark-patterns rule is either kept or broken, and paraphrasing
// it in the guard would be paraphrasing the rule.
const BODY = 'Мы считаем посещения страниц, чтобы понимать, что читают. Включить статистику?';
const ACCEPT = 'Включить';
const DECLINE = 'Не включать';

const ANALYTICS_HOSTS = /(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)/;

/** Every request the page attempted, recorded before routing. */
function watchAnalytics(page) {
    const seen = [];
    page.on('request', (request) => seen.push(request.url()));
    return {
        all: () => seen,
        analytics: () => seen.filter((url) => ANALYTICS_HOSTS.test(url)),
        sawDocument: () => seen.some((url) => new URL(url).pathname === '/'),
    };
}

/** The smallest thing the channel probe accepts as the native shell. */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

/** A storage state with an explicit answer already recorded. */
const answered = (value) => Object.assign({}, STATES.seeded, { [STORAGE_KEY]: value });

/** The first-visit state: a family already set up, and the question unanswered. */
const unanswered = () => {
    const state = Object.assign({}, STATES.seeded);
    delete state[STORAGE_KEY];
    return state;
};

test.describe('nothing is fetched from the analytics origin before an explicit yes', () => {
    test('an undecided visitor reaches no analytics origin, and is asked', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: unanswered() });

        expect(
            requests.sawDocument(),
            'the request listener never saw the document itself, so every absence below is about'
                + ' a page that did not load'
        ).toBe(true);

        expect(
            requests.analytics(),
            'the shell reached the analytics origin before the visitor answered — the request'
                + ' itself carries their address, which is the part that has to stop'
        ).toEqual([]);

        // Belt on the same claim from inside the page: a tag that failed to fetch
        // would leave no request but would still be in the document.
        expect(
            await page.evaluate(() =>
                document.querySelectorAll('script[src*="googletagmanager"]').length
            ),
            'the loader tag is in the document — it was created before anyone was asked'
        ).toBe(0);

        // And GA4 was never configured, which is the second half of the promise
        // app/privacy.html §5 makes.
        expect(
            await page.evaluate(() =>
                Array.from(window.dataLayer || []).map((entry) => Array.from(entry)[0])
            ),
            'gtag was configured before consent'
        ).not.toContain('config');

        await expect(page.locator('#cookieBanner')).toBeVisible();
        await expect(page.locator('#cookieBanner span')).toHaveText(BODY);
        await expect(page.locator('#cookieEnableBtn')).toHaveText(ACCEPT);
        await expect(page.locator('#cookieDeclineBtn')).toHaveText(DECLINE);
    });

    test('declining reaches nothing, and is not asked again', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: unanswered() });
        await expect(page.locator('#cookieBanner')).toBeVisible();

        await page.locator('#cookieDeclineBtn').click();
        await expect(page.locator('#cookieBanner')).toBeHidden();
        expect(
            await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
            'declining recorded something other than the declared token'
        ).toBe(DENIED);
        expect(requests.analytics(), 'declining still reached the analytics origin').toEqual([]);

        // The second visit, which is the half a one-page test cannot see.
        await page.reload();
        await page.waitForFunction(
            () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
        );
        await expect(
            page.locator('#cookieBanner'),
            'a visitor who declined is asked again on the next visit'
        ).toBeHidden();
        expect(requests.analytics(), 'the second visit reached the analytics origin').toEqual([]);
    });

    test('consent loads the tag, and only then', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: unanswered() });
        await expect(page.locator('#cookieBanner')).toBeVisible();

        // THE ARM FOR THE TWO LEGS ABOVE, in this run and on this page: the same
        // listener, one click later. A gate whose enable() reached nothing would
        // red here instead of making those absences meaningless.
        expect(requests.analytics(), 'the premise of this leg is already broken').toEqual([]);
        await page.locator('#cookieEnableBtn').click();

        await expect
            .poll(() => requests.analytics().length, {
                message: 'consent was given and nothing was fetched from the analytics origin',
            })
            .toBeGreaterThan(0);

        expect(
            requests.analytics()[0],
            'the request that went out does not name the declared measurement id'
        ).toContain(MEASUREMENT_ID);
        await expect(page.locator('#cookieBanner')).toBeHidden();
        expect(
            await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
        ).toBe(GRANTED);
        expect(
            await page.evaluate(() =>
                Array.from(window.dataLayer || []).map((entry) => Array.from(entry)[0])
            ),
            'the tag was fetched but GA4 was never configured'
        ).toContain('config');
    });

    test('an already-granted visitor is not asked again', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: answered(GRANTED) });

        await expect(
            page.locator('#cookieBanner'),
            'a visitor who already consented is asked a second time'
        ).toBeHidden();
        await expect
            .poll(() => requests.analytics().length, {
                message: 'a granted visitor reached no analytics origin — consent stopped meaning yes',
            })
            .toBeGreaterThan(0);
    });
});

test.describe('withdrawal costs one click, and it is the same click', () => {
    test('the footer reopens the same question, and declining stops the tag', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: answered(GRANTED) });
        await expect.poll(() => requests.analytics().length).toBeGreaterThan(0);

        const control = page.locator('#cookieSettingsBtn');
        await expect(control, 'the footer offers no way back to the question').toBeVisible();
        await control.click();

        // THE SAME BANNER, NOT A SECOND ONE: same element, same two actions, same
        // words. Withdrawal costing more than consent is the dark pattern this
        // packet's rule is about, and "the same control" is how it is prevented
        // rather than promised.
        await expect(page.locator('#cookieBanner')).toBeVisible();
        await expect(page.locator('#cookieBanner span')).toHaveText(BODY);
        await expect(page.locator('#cookieEnableBtn')).toHaveText(ACCEPT);
        await expect(page.locator('#cookieDeclineBtn')).toHaveText(DECLINE);

        const before = requests.analytics().length;
        await page.locator('#cookieDeclineBtn').click();
        await expect(page.locator('#cookieBanner')).toBeHidden();

        expect(
            await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
            'withdrawing did not return the visitor to the declined state'
        ).toBe(DENIED);
        expect(
            await page.evaluate((id) => window['ga-disable-' + id], MEASUREMENT_ID),
            "Google's own opt-out switch was not set — a tag already in the document keeps sending"
        ).toBe(true);

        // Nothing further leaves the page. The script the document already
        // fetched cannot be un-fetched, which is why the switch above is the
        // assertion that carries this claim and the count is a corroboration.
        await page.waitForTimeout(500);
        expect(
            requests.analytics().length,
            'the analytics origin was reached again after the visitor withdrew'
        ).toBe(before);

        // And the next visit never creates the tag at all.
        await page.reload();
        await page.waitForFunction(
            () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
        );
        await expect(page.locator('#cookieBanner')).toBeHidden();
        expect(
            await page.evaluate(() =>
                document.querySelectorAll('script[src*="googletagmanager"]').length
            ),
            'the loader tag came back on the visit after a withdrawal'
        ).toBe(0);
    });

    test('a withdrawn visitor can grant again through the same control', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: answered(DENIED) });
        expect(requests.analytics()).toEqual([]);

        await page.locator('#cookieSettingsBtn').click();
        await expect(page.locator('#cookieBanner')).toBeVisible();
        await page.locator('#cookieEnableBtn').click();

        await expect
            .poll(() => requests.analytics().length, {
                message: 'granting after a refusal fetched nothing — the door only opens one way',
            })
            .toBeGreaterThan(0);
        expect(
            await page.evaluate((id) => window['ga-disable-' + id], MEASUREMENT_ID),
            "Google's opt-out switch was left set after the visitor changed their mind"
        ).toBe(false);
    });
});

test.describe('the two actions are offered at equal weight', () => {
    test('same element, same class, same computed presentation, and no third exit', async ({
        page,
    }) => {
        await gotoApp(page, { state: unanswered() });
        await expect(page.locator('#cookieBanner')).toBeVisible();

        const shape = await page.evaluate(() => {
            const read = (id) => {
                const el = document.getElementById(id);
                const style = getComputedStyle(el);
                return {
                    tag: el.tagName,
                    classes: el.className,
                    disabled: el.disabled === true,
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    padding: style.padding,
                    color: style.color,
                    background: style.backgroundColor,
                    border: style.border,
                    opacity: style.opacity,
                    textDecoration: style.textDecorationLine,
                };
            };
            return {
                accept: read('cookieEnableBtn'),
                decline: read('cookieDeclineBtn'),
                controls: document.querySelectorAll('#cookieBanner button').length,
            };
        });

        expect(shape.accept.tag, 'the accept control is not a button').toBe('BUTTON');
        expect(
            shape.decline.tag,
            'the decline control is not a button — a link beside a button is not equal weight'
        ).toBe('BUTTON');
        expect(shape.decline.disabled, 'the decline control is disabled').toBe(false);

        for (const property of [
            'classes',
            'fontSize',
            'fontWeight',
            'padding',
            'color',
            'background',
            'border',
            'opacity',
            'textDecoration',
        ]) {
            expect(
                shape.decline[property],
                `"${property}" differs between the two actions: accept has`
                    + ` "${shape.accept[property]}", decline has "${shape.decline[property]}".`
                    + ' The two answers are offered at equal weight or they are not offered at all.'
            ).toBe(shape.accept[property]);
        }

        expect(
            shape.controls,
            'the banner carries a control that is neither answer. Closing it would then be an exit'
                + ' that records nothing, and a banner that goes away without an answer is the'
                + ' shape "closing is consent" hides in.'
        ).toBe(2);
    });
});

test.describe('the native channel is asked nothing and loads nothing', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
    });

    test('the page really took the native branch', async ({ page }) => {
        // The premise of every assertion in this block: an init script that
        // silently failed would test the web branch twice.
        await gotoApp(page, { state: unanswered() });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
    });

    test('no banner, no footer control, no request — with nothing stored either way', async ({
        page,
    }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: unanswered() });

        expect(requests.sawDocument()).toBe(true);
        await expect(
            page.locator('#cookieBanner'),
            'the native channel asks about analytics it does not have'
        ).toBeHidden();
        await expect(
            page.locator('#cookieSettingsBtn'),
            'the native channel offers a way to withdraw a consent it never collects'
        ).toBeHidden();
        expect(requests.analytics(), 'the native channel reached the analytics origin').toEqual([]);
        expect(
            await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
            'the native channel recorded an answer to a question it never asked'
        ).toBeNull();
    });

    test('even a granted answer loads nothing on this channel', async ({ page }) => {
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: answered(GRANTED) });

        expect(requests.sawDocument()).toBe(true);
        expect(
            requests.analytics(),
            'a stored yes reached the analytics origin inside the app — the native channel carries'
                + ' no analytics at all (L1-P4), whatever a browser on the same device answered'
        ).toEqual([]);
    });

    test("the shell's own native guard holds when the seam is called by hand", async ({ page }) => {
        // The second, independent guard, executed. surfaces/consent.js returns
        // before it reaches the bridge on this channel; this leg reaches past that
        // module entirely and calls the shell's enable() itself, which is what
        // says L1-P4's decision cannot be undone by a future caller's mistake.
        const requests = watchAnalytics(page);
        await gotoApp(page, { state: answered(GRANTED) });
        await page.evaluate(() => window.theygrowAnalytics.enable());
        await page.waitForTimeout(300);

        expect(
            requests.analytics(),
            "the shell's analytics seam fetched the tag inside the app when called directly"
        ).toEqual([]);
        expect(
            await page.evaluate(() =>
                document.querySelectorAll('script[src*="googletagmanager"]').length
            )
        ).toBe(0);
    });
});

test.describe('the first-run visitor meets the question at all', () => {
    test('a browser with nothing stored is asked, and fetches nothing meanwhile', async ({
        page,
    }) => {
        const requests = watchAnalytics(page);
        await seedStorage(page, STATES.firstRun);
        await page.goto('/');
        await page.waitForFunction(
            () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
        );

        expect(requests.sawDocument()).toBe(true);
        await expect(page.locator('#cookieBanner')).toBeVisible();
        expect(requests.analytics()).toEqual([]);
    });
});
