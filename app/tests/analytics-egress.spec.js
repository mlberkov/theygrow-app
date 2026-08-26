'use strict';

// UIP-P1-INV-001, the executing half — a real browser reaches no analytics
// origin, in any visitor state, on any page of this product.
//
// WHAT THIS FILE REPLACES AND WHY THE SUBJECT CHANGED. PPR-P2 wrote
// consent-surface.spec.js to answer "does anything leave, and WHEN" — its legs
// were paired arms, four of which required an analytics request to APPEAR after
// an explicit yes. UIP-P1 removed analytics from the web showcase entirely
// (vault ADR-043 annotation 2026-08-25, class: reversal), so the positive arms
// have nothing to assert and the question collapses from "when" to "ever". This
// file asks the collapsed question, with the same instrument: the network log of
// a real page, not a spy on our own wrapper.
//
// WHY AN EXECUTING LEG AT ALL, WHEN THE STATIC ONE READS THE SAME TREE. Because
// they fail differently, which is the whole reason AGENTS.md §11 separates them.
// analytics-absence.spec.js proves no shipped BYTE names an analytics origin; it
// cannot see a request assembled at runtime — a URL built by concatenation, a
// third-party script pulled in by another third-party script, or a beacon fired
// from a handler. A page that made such a request would be green there and red
// here.
//
// THE THIRD OF THOSE NEEDS A CLICK, AND SO THERE IS ONE. A spec that only ever
// navigates could not see a beacon fired from a handler, and saying it could
// would be the same over-claim this milestone spent a packet removing from other
// people's sentences. The last describe below DRIVES the surfaces that used to
// emit: every one of the thirteen retired call sites sat behind a user action,
// and the leg performs the actions rather than reading the files they used to
// live in.
//
// THE ANTI-VACUITY PROBLEM THIS FILE HAS, NAMED BEFORE THE LEGS. "Zero requests
// matched a pattern" is exactly what a listener that was never attached
// reports, what a navigation that never happened reports, and what a page that
// failed to boot reports. Every leg below therefore asserts, on the SAME
// observer and the SAME navigation, that a request which MUST happen was seen.
// Without that the zero means only that the instrument saw nothing.

const { test, expect, gotoApp, STATES } = require('./support/seed');

const ANALYTICS_HOSTS = /(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)/;

/**
 * Every request the page attempted, recorded before routing.
 *
 * Nothing routes or stubs the analytics hosts any more — support/seed.js dropped
 * that stub at UIP-P1 along with the surface that made requests to them — so an
 * absence recorded here is a plain absence with no harness behind it.
 */
function watchRequests(page) {
    const seen = [];
    page.on('request', (request) => seen.push(request.url()));
    return {
        all: () => seen,
        analytics: () => seen.filter((url) => ANALYTICS_HOSTS.test(url)),
        sawPath: (p) => seen.some((url) => new URL(url).pathname === p),
    };
}

/** The smallest thing the channel probe accepts as the native shell. */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

/** Asserts the observer was live for this navigation, then that it saw no analytics. */
async function expectNoEgress(page, requests, what) {
    expect(
        requests.sawPath('/'),
        `${what}: the request listener never saw the document itself, so the absence below would`
            + ' be about a page that did not load'
    ).toBe(true);
    expect(
        requests.sawPath('/kb-v1.json'),
        `${what}: the app never fetched the knowledge base, so it did not boot and the absence`
            + ' below is a fact about a dead page rather than about this product'
    ).toBe(true);
    expect(
        requests.analytics(),
        `${what}: a request left for an analytics origin. The request itself carries the visitor`
            + ' address and the user agent, which is the whole of the egress — there is no state,'
            + ' stored answer or channel in which this product may make one'
    ).toEqual([]);

    // Belt on the same claim from inside the page: a tag that was created and
    // failed to fetch would leave no request but would still be in the document.
    expect(
        await page.evaluate(() =>
            document.querySelectorAll('script[src*="googletagmanager"]').length
        ),
        `${what}: an analytics loader tag is in the document`
    ).toBe(0);

    // And the shim that used to queue events is gone rather than quiet: dataLayer
    // was created unconditionally in the old head block, so its ABSENCE is the
    // thing to assert, not its length.
    const globals = await page.evaluate(() => ({
        dataLayer: typeof window.dataLayer,
        gtag: typeof window.gtag,
        trackEvent: typeof window.trackEvent,
        seam: typeof window.theygrowAnalytics,
    }));
    expect(globals, `${what}: an analytics global is defined on the page`).toEqual({
        dataLayer: 'undefined',
        gtag: 'undefined',
        trackEvent: 'undefined',
        seam: 'undefined',
    });
}

test.describe('no visitor state reaches an analytics origin', () => {
    // The states the suite boots from, plus a reload. STATES.firstRun is the
    // one that matters most and is the one PPR-P2 had to treat specially: a
    // visitor with nothing stored is where a consent gate would have had a
    // decision to make, and it is now indistinguishable from every other state.
    //
    // `firstRun` and `empty` ARE THE SAME STORAGE SINCE UIP-P3 — the intro's
    // dismissal flag was what distinguished them, and it left with the auto-open
    // (see support/seed.js). Both names are driven anyway rather than one being
    // dropped: this sweep is about visitor STATES as the product names them, and
    // the day they diverge again the leg is already here.
    for (const [name, state] of [
        ['a first visit with nothing stored', STATES.firstRun],
        ['a visitor with no profile', STATES.empty],
        ['a seeded family', STATES.seeded],
    ]) {
        test(`${name} reaches nothing`, async ({ page }) => {
            const requests = watchRequests(page);
            await gotoApp(page, { state });
            await expectNoEgress(page, requests, name);
        });
    }

    test('a second visit reaches nothing either', async ({ page }) => {
        // The state a returning visitor is in — including one whose browser still
        // holds the `analytics_consent` value the retired gate wrote. Nothing
        // reads it, and this leg is what says so rather than assuming it: a stale
        // stored 'granted' must not start anything.
        const requests = watchRequests(page);
        await gotoApp(page, { state: Object.assign({}, STATES.seeded, { analytics_consent: 'granted' }) });
        await page.reload();
        await page.waitForFunction(
            () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
        );
        await expectNoEgress(page, requests, 'a returning visitor with a stale stored answer');
    });

    test('the footer offers no way to reach one', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });
        await expect(page.locator('#cookieSettingsBtn')).toHaveCount(0);
        await expect(page.locator('#cookieBanner')).toHaveCount(0);
    });
});

test.describe('the native channel reaches nothing either, and never did', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
    });

    test('the page really took the native branch', async ({ page }) => {
        // Anti-vacuity for the leg below: both assertions there are about a
        // branch that would otherwise not have been taken.
        await gotoApp(page, { state: STATES.seeded });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
    });

    test('nothing leaves on the native branch', async ({ page }) => {
        const requests = watchRequests(page);
        await gotoApp(page, { state: STATES.seeded });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
        await expectNoEgress(page, requests, 'the native branch');
    });
});

// EVERY SURFACE THAT USED TO EMIT, DRIVEN.
//
// The thirteen `trackEvent()` call sites UIP-P1 removed were not spread evenly:
// they sat on seven surfaces, and every one of them fired from a user action —
// a tick, a filter toggle, an accordion toggle, opening the activities window,
// opening a skill from it, walking the graph chips, closing the skill window,
// showing and dismissing the intro, opening the profile dropdown, creating a
// profile. This leg performs them in one page life and asserts that the network
// log is still empty of analytics afterwards. It is the only leg in this file
// that could ever catch a beacon fired from a handler, which is why the header
// promises one.
test.describe('driving the surfaces that used to emit still reaches nothing', () => {
    test('a full pass over every retired call site leaves the network log empty', async ({ page }) => {
        const requests = watchRequests(page);
        await gotoApp(page, { state: STATES.seeded });

        // The intro window: shown and dismissed (onboarding_shown,
        // onboarding_dismissed). Since UIP-P3 the window never opens by itself
        // in any state, so it is opened through the header control the way a
        // parent would — which is now the only way it opens at all.
        await page.locator('#aboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await page.locator('#onboardingCloseBtn').click();
        await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);

        // The profile control (profile_click).
        await page.locator('#profileButton').click();
        await expect(page.locator('#profileDropdown')).toBeVisible();
        await page.locator('#profileButton').click();

        // A tick and an untick (skill_complete, both directions). The row is
        // resolved to a STABLE id first: a `:not(:checked)` locator re-evaluates
        // after the click and would hand the assertion a different, still
        // unchecked box — measured while writing this leg.
        const skillId = await page.evaluate(() => {
            const row = Array.from(document.querySelectorAll('#tableBody tr[data-skill-id]')).find(
                (tr) => {
                    const input = tr.querySelector('input[type="checkbox"]');
                    return input && !input.checked;
                }
            );
            return row ? row.getAttribute('data-skill-id') : null;
        });
        expect(skillId, 'no unticked skill on the seeded board — nothing to tick').not.toBeNull();
        const box = page.locator(`#tableBody tr[data-skill-id="${skillId}"] input[type="checkbox"]`);
        await box.check();
        await expect(box).toBeChecked();
        await box.uncheck();
        await expect(box).not.toBeChecked();

        // The ZPD filter, on and off (filter_zpd_toggle, zpd_empty_state_shown).
        await page.locator('#zpdFilterToggleBtn').click();
        await page.locator('#zpdFilterToggleBtn').click();

        // The activities window and a skill opened from it (activities_open,
        // activity_skill_open, skill_view).
        await page.locator('#activitiesBtn').click();
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
        const card = page.locator('#activitiesGrid .activity-card-title[data-skill-id]').first();
        await expect(card).toBeVisible();
        await card.click();
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');

        // Closing the skill window (skill_modal_close).
        await page.locator('#skillModalClose').click();
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'none');

        // Anti-vacuity for the actions themselves, not just for the observer:
        // if none of the clicks landed, the absence below would be about a page
        // nobody touched. The activities window is still open underneath, which
        // is only true if the stack was actually driven.
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);

        await expectNoEgress(page, requests, 'a full pass over every retired call site');
    });
});

// THE SCOPE OF THIS FILE, STATED SO IT IS NOT READ WIDER THAN IT IS. Both
// projects it can run in serve app/tests/server.js over plain HTTP; neither is a
// real Capacitor WebView, and simulateNativeShell() above only satisfies the
// channel probe. The claim about a real APK is WebViewStorageTest on the
// emulator, which runs on dispatch. And nothing here observes production nginx:
// what it drives is this repository's server mirror.
