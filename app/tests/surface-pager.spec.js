'use strict';

// The surface pager, and the one negative this packet is really about
// (NAV-P3-INV-002).
//
// WHAT THIS FILE EXECUTES. Two claims, and they are a PAIR rather than two
// tests: that a synthesized sideways drag turns the page inside the app, and
// that the identical drag does nothing at all in a browser. Neither half is
// worth anything alone — a green negative on the web would say only that the
// synthesizer is broken, which is exactly how a "no swipe here" claim passes
// vacuously — so every web leg below is answered by a native leg driving the
// same helper with the same numbers.
//
// WHY A LOADED PAGE AND NOT A SOURCE SCAN. "The web channel has no page turn"
// is a fact about listeners that were or were not registered and about a
// gesture that did or did not change the screen (AGENTS.md §11). A scan of
// surfaces/pager.js would stay green against a wirePager() that had lost its
// channel gate, which is the one regression this file exists to catch — and
// that mutation is run, not assumed.
//
// HOW THE NATIVE BRANCH IS REACHED, and what it does NOT buy — the same
// stand-in channel-composition.spec.js and diary-surface.spec.js document:
// `isNativePlatform()` and nothing else, installed before any shell script
// runs. There is no plugin behind it, so the store never opens and the diary
// surface comes up on its refusal text. That is irrelevant here and deliberately
// so: what is under test is WHICH SURFACE IS ON SCREEN, not what it says.
//
// WHAT IS DELIBERATELY NOT CLAIMED HERE. Nothing about the hardware back button
// (app/tests/back-button.spec.js off-device, BackButtonTest on a device), and
// nothing about a real finger. Playwright drives POINTER events through the
// mouse, which is why the recogniser is pointer-type agnostic by decision
// rather than by omission: gating it on `pointerType === 'touch'` would have
// left the whole mechanism with no executor anywhere off-device, which is the
// shape that cost DIA-P3 a repair round.

const { test, expect } = require('@playwright/test');
const { gotoApp, STATES } = require('./support/seed');

/** The smallest thing the channel probe accepts as the native shell. */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

/**
 * Turns off the browser's own text-selection drag, for the length of one leg.
 *
 * MEASURED, NOT PRECAUTIONARY. Driven by a mouse, a drag that starts over
 * selectable text makes Chromium begin a SELECTION and cancel the pointer:
 * the sequence recorded in this run over the skills table was `pointerdown`
 * then `pointercancel`, with no `pointerup` at all. The recogniser treats
 * `pointercancel` as «the browser took this gesture», which is exactly what
 * makes scrolling win on a phone — so the product is right and the INSTRUMENT
 * is what needs neutralising: a finger does not start a selection by moving,
 * and a touch drag over text is not cancelled this way.
 *
 * It is applied to EVERY leg in this file, the web ones included, and that
 * direction matters: without it a negative leg could pass because the browser
 * cancelled the gesture rather than because nothing was armed to receive it —
 * which is the exact vacuity this file exists to avoid.
 */
async function neutraliseSelectionDrag(page) {
    await page.addStyleTag({
        content: '*, *::before, *::after { -webkit-user-select: none !important; user-select: none !important; }',
    });
}

/** The centre of an element, as a drag anchor. */
async function centreOf(page, selector) {
    const box = await page.locator(selector).boundingBox();
    expect(box, `${selector} has no box to drag from`).not.toBeNull();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * One drag, in pointer events, from a point by a delta.
 *
 * `steps` matters: a single jump produces one pointermove and a zero-length
 * time base, and the recogniser reads the elapsed time for its flick path. The
 * legs below never rely on the flick path — every intended turn is past the
 * distance threshold on its own — but a drag that arrives in one frame is not
 * a drag a person makes, and the helper should not be the thing that decides.
 */
async function drag(page, from, dx, dy, { steps = 12 } = {}) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
}

// Comfortably past NAV_CONFIG.pageTurnMinDistancePx (60) and comfortably inside
// pageTurnMaxOffAxisRatio (0.6). Written here once so a web leg and its native
// answer cannot drift apart in the numbers.
const TURN_DX = 140;
const HEADER = 'header h1';
const DIARY_TITLE = '#diaryModal .modal-content h2';

const diary = (page) => page.locator('#diaryModal');

test.describe('the web channel has no page turn at all (NAV-P3-INV-002)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });
        await neutraliseSelectionDrag(page);
        // The premise: this is the web branch, and the switcher is withheld.
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(false);
        await expect(page.locator('#surfaceNav')).toBeHidden();
    });

    test('a left drag opens nothing', async ({ page }) => {
        const from = await centreOf(page, HEADER);
        await drag(page, from, -TURN_DX, 0);

        await expect(diary(page)).toBeHidden();
        await expect(diary(page)).toHaveCSS('display', 'none');
    });

    test('a right drag opens nothing either', async ({ page }) => {
        const from = await centreOf(page, HEADER);
        await drag(page, from, TURN_DX, 0);

        await expect(diary(page)).toBeHidden();
    });

    test('nothing writes the transition duration, so no surface can animate in', async ({ page }) => {
        // The stylesheet reads --surface-transition-ms with no fallback, so an
        // unset property is «no animation» rather than «a different duration».
        // Only an armed pager writes it, and nothing arms one here.
        const declared = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--surface-transition-ms').trim()
        );
        expect(declared).toBe('');
    });
});

test.describe('inside the app the same drag turns the page', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });
        await neutraliseSelectionDrag(page);
    });

    test('the page really took the native branch', async ({ page }) => {
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
        await expect(page.locator('#surfaceNav')).toBeVisible();
    });

    // THE ANTI-VACUITY LEG FOR THE WHOLE FILE. Without this one, every negative
    // above would be satisfied by a helper that dispatches nothing.
    test('a left drag from the skills surface opens the diary', async ({ page }) => {
        await expect(diary(page)).toBeHidden();

        const from = await centreOf(page, HEADER);
        await drag(page, from, -TURN_DX, 0);

        await expect(diary(page)).toBeVisible();
        await expect(page.locator('#surfaceDiaryBtn')).toHaveAttribute('aria-current', 'page');
    });

    test('a right drag from the diary returns to the skills surface', async ({ page }) => {
        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();

        const from = await centreOf(page, DIARY_TITLE);
        await drag(page, from, TURN_DX, 0);

        await expect(diary(page)).toBeHidden();
        await expect(page.locator('#surfaceSkillsBtn')).toHaveAttribute('aria-current', 'page');
    });

    test('the surface animates in, and the duration is the declared one', async ({ page }) => {
        const declared = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--surface-transition-ms').trim()
        );
        expect(declared).toBe('220ms');

        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();
        await expect(diary(page)).toHaveCSS('animation-name', 'surface-enter');
        await expect(diary(page)).toHaveCSS('animation-duration', '0.22s');
    });
});

test.describe('a drag that is not a page turn is left alone', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });
        await neutraliseSelectionDrag(page);
        await expect(diary(page)).toBeHidden();
    });

    test('a vertical drag does not turn the page', async ({ page }) => {
        const from = await centreOf(page, HEADER);
        await drag(page, from, 0, TURN_DX);
        await expect(diary(page)).toBeHidden();
    });

    test('a mostly vertical drag does not turn the page', async ({ page }) => {
        // |dy| = 1.4 * |dx|, which is past the declared off-axis ratio of 0.6
        // while still moving sideways as far as a page turn would.
        const from = await centreOf(page, HEADER);
        await drag(page, from, -TURN_DX, Math.round(TURN_DX * 1.4));
        await expect(diary(page)).toBeHidden();
    });

    test('a diagonal drag past the declared slant does not turn the page', async ({ page }) => {
        // THIS LEG EXISTS TO CARRY `pageTurnMaxOffAxisRatio` AND NOTHING ELSE,
        // and it is built so that the ratio is the ONLY variable in it.
        //
        // The horizontal distance is IDENTICAL in both halves and clears
        // pageTurnMinDistancePx on its own, so neither half can be decided by
        // the distance test. What differs is the slant: 120/140 = 0.857 is past
        // the declared 0.6 and must be refused; 60/140 = 0.43 is inside it and
        // must turn the page. A leg with only the first half would go green
        // against a recogniser that had stopped working for any reason at all.
        const askew = Math.round(TURN_DX * 0.857);
        const withinAxis = Math.round(TURN_DX * 0.43);
        expect(askew).toBeGreaterThan(Math.round(TURN_DX * 0.6));
        expect(withinAxis).toBeLessThan(Math.round(TURN_DX * 0.6));

        const from = await centreOf(page, HEADER);
        await drag(page, from, -TURN_DX, askew);
        await expect(diary(page)).toBeHidden();

        // Same sideways distance, same starting point, slant inside the ratio.
        await drag(page, from, -TURN_DX, withinAxis);
        await expect(diary(page)).toBeVisible();
    });

    test('a tap does not turn the page', async ({ page }) => {
        const from = await centreOf(page, HEADER);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.up();
        await expect(diary(page)).toBeHidden();
    });

    test('a drag begun inside a horizontally scrollable element does not turn the page', async ({ page }) => {
        // NO FIXTURE IS NEEDED HERE, AND THAT IS ITSELF THE FINDING. At this
        // project's viewport the skills table is genuinely wider than its
        // wrapper — measured in this run, not assumed — so the case the rule is
        // about is the app's own resting state rather than something a test
        // built. The arm is asserted before the act all the same: a wrapper that
        // had stopped scrolling would leave this leg green about nothing.
        const armed = await page.evaluate(() => {
            const wrapper = document.querySelector('.table-wrapper');
            const box = wrapper.getBoundingClientRect();
            return {
                scrolls: wrapper.scrollWidth > wrapper.clientWidth,
                overflowX: getComputedStyle(wrapper).overflowX,
                at: { x: box.x + 140, y: box.y + 40 },
            };
        });
        expect(armed.scrolls, 'the skills table does not overflow here, so this leg tests nothing').toBe(true);
        expect(['auto', 'scroll']).toContain(armed.overflowX);

        await drag(page, armed.at, -TURN_DX, 0);
        await expect(diary(page)).toBeHidden();

        // BOTH HALVES OF THE RULE ARE LOAD-BEARING, and each gets its own
        // control at the same coordinates. First: the declared overflow. With
        // the wrapper no longer offering a sideways scroll, the identical drag
        // turns the page.
        await page.evaluate(() => {
            document.querySelector('.table-wrapper').style.overflowX = 'hidden';
        });
        await drag(page, armed.at, -TURN_DX, 0);
        await expect(diary(page)).toBeVisible();
    });

    test('an element that declares a sideways scroll but has none does not decline the gesture', async ({ page }) => {
        // The second half of the same rule: overflow-x alone is not enough.
        // Content that fits needs no scrolling, and declining there would make
        // the gesture dead over any container that merely declares auto.
        const at = await page.evaluate(() => {
            const wrapper = document.querySelector('.table-wrapper');
            // Narrowing the table by style does not narrow it: its columns set
            // their own widths. Taking it out of layout is what actually leaves
            // the wrapper with nothing to scroll, which is the state under test.
            document.getElementById('mainTable').style.display = 'none';
            const box = wrapper.getBoundingClientRect();
            return { fits: wrapper.scrollWidth <= wrapper.clientWidth, x: box.x + 140, y: box.y + 40 };
        });
        expect(at.fits, 'the table still overflows, so this leg is the other case').toBe(true);

        await drag(page, at, -TURN_DX, 0);
        await expect(diary(page)).toBeVisible();
    });

    test('over a table that scrolls sideways, the switcher is the way through', async ({ page }) => {
        // THE COST OF THE CONSERVATIVE RULE, EXECUTED RATHER THAN CLAIMED. Where
        // the skills table really does scroll sideways — a wide window, which on
        // this channel means a tablet, since the phone layout is the accordion
        // and does not overflow — a drag begun over the table is declined, and
        // the non-gesture control is how a parent gets to the diary. That is the
        // trade this packet took: never fight the content, and always leave a
        // control that works.
        const at = await page.evaluate(() => {
            const wrapper = document.querySelector('.table-wrapper');
            const box = wrapper.getBoundingClientRect();
            return { scrolls: wrapper.scrollWidth > wrapper.clientWidth, x: box.x + 140, y: box.y + 40 };
        });
        expect(at.scrolls).toBe(true);

        await drag(page, at, -TURN_DX, 0);
        await expect(diary(page)).toBeHidden();

        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();
    });

    test('a drag begun in a text field does not turn the page', async ({ page }) => {
        // THE FIELD IS LAID OVER THE HEADER ANCHOR, so the control below is a
        // real control: the same coordinates are known to turn the page once
        // the field is gone, which is what makes «the field declined it» the
        // only remaining explanation.
        const at = await page.evaluate(() => {
            const anchor = document.querySelector('header h1').getBoundingClientRect();
            const field = document.createElement('input');
            field.id = 'parity-text-field';
            field.type = 'text';
            field.style.position = 'fixed';
            field.style.left = `${Math.round(anchor.x)}px`;
            field.style.top = `${Math.round(anchor.y)}px`;
            field.style.width = `${Math.max(Math.round(anchor.width), 200)}px`;
            field.style.height = `${Math.max(Math.round(anchor.height), 24)}px`;
            field.style.zIndex = '90';
            document.body.appendChild(field);
            const box = field.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });

        await drag(page, at, -TURN_DX, 0);
        await expect(diary(page)).toBeHidden();

        // THE CONTROL, again at the same coordinates: it is the field that
        // declines the gesture, not the place.
        await page.evaluate(() => document.getElementById('parity-text-field').remove());
        await drag(page, at, -TURN_DX, 0);
        await expect(diary(page)).toBeVisible();
    });

    test('a drag under an open window does not turn the page', async ({ page }) => {
        await page.locator('#menuBtn').click();
        await page.locator('#menuAboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

        // The gesture begins INSIDE the open window, which is the case the rule
        // is about — a finger in a window that lies over the app is not turning
        // the app's pages. Anchoring on the backdrop instead would close the
        // window with the drag's own click and prove nothing about the pager.
        const from = await centreOf(page, '#onboardingModal .onboarding-modal-header');
        await drag(page, from, -TURN_DX, 0);

        await expect(diary(page)).toBeHidden();
        // And the window the parent opened is still the window they are looking
        // at: the gesture was declined, not redirected.
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
    });

    test('the pager does not run off either end of the list', async ({ page }) => {
        // Right from the start surface: there is nothing to the left of it.
        const fromHeader = await centreOf(page, HEADER);
        await drag(page, fromHeader, TURN_DX, 0);
        await expect(diary(page)).toBeHidden();

        // Left from the last surface: there is nothing to the right of it, and
        // in particular the diary does not close by being pushed past.
        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();
        const fromDiary = await centreOf(page, DIARY_TITLE);
        await drag(page, fromDiary, -TURN_DX, 0);
        await expect(diary(page)).toBeVisible();
    });
});

test.describe('reduced motion removes the movement and nothing else', () => {
    test('the surface arrives without an animation', async ({ page }) => {
        await simulateNativeShell(page);
        // Emulated on the PAGE rather than declared with test.use: measured in
        // this run, the fixture form leaves matchMedia reporting false under
        // this project, which would have made the assertion below pass for the
        // wrong reason — an emulation that never took looks exactly like a
        // stylesheet that has no reduced-motion branch. The arm is asserted
        // before the act for the same reason.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await gotoApp(page, { state: STATES.seeded });
        await neutraliseSelectionDrag(page);

        expect(
            await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
            'the reduced-motion emulation did not take, so this leg would prove nothing'
        ).toBe(true);

        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();
        await expect(diary(page)).toHaveCSS('animation-name', 'none');
    });

    test('and without it the same surface does animate', async ({ page }) => {
        // The control for the leg above: the branch is what removes the
        // movement, not something else that had already removed it.
        await simulateNativeShell(page);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await gotoApp(page, { state: STATES.seeded });
        await neutraliseSelectionDrag(page);

        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();
        await expect(diary(page)).toHaveCSS('animation-name', 'surface-enter');
    });
});
