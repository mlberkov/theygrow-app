'use strict';

// What the diary surface OFFERS and what it says when it refuses (DIA-P3).
//
// WHY THIS FILE LOADS A PAGE. "The diary is offered where a store exists" and
// "a refused entry leaves the parent holding their text" are facts about a
// rendered document and a handler that ran, not substrings in a module
// (AGENTS.md §11). The static halves — the control ships `hidden`, the `.show`
// rule exists, the payload is safe — are export-contour, show-rule-coverage and
// signal-payload, and every one of them would stay green against a surface that
// revealed everything at boot or lost the text on failure.
//
// HOW THE NATIVE BRANCH IS REACHED, and what it does NOT buy — the same
// stand-in channel-composition.spec.js documents: `isNativePlatform()` and
// nothing else, installed before any shell script runs. There is no plugin
// behind it, so `isNativeStore()` is false, the store never opens, and
// core/state.js lands on the localStorage backend. That is exactly what makes
// the store-unavailable leg below REAL rather than simulated: it is the app
// meeting a store that did not open, which is the state a parent meets when
// SQLCipher fails on their device.
//
// WHAT IS DELIBERATELY NOT CLAIMED HERE. Nothing about an entry actually being
// written, and nothing about the DISK-FULL refusal. Reaching either needs a
// store that opens, and faking one in a browser would prove the fake
// (`DIA-DL-004` alternative 9 rejected exactly that shape for the export). Both
// belong to `DiaryEntryTest` on `android-instrumented`, where the engine is
// real and a genuine SQLITE_FULL is forced with `PRAGMA max_page_count` — DIA-P3
// checkpoint 4. The disk-full string is NOT asserted anywhere in this file, so
// nobody can read a green here as covering it.

const { test, expect } = require('@playwright/test');
const { gotoApp, STATES } = require('./support/seed');

/** The smallest thing the channel probe accepts as the native shell. */
async function simulateNativeShell(page) {
    await page.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
    });
}

/**
 * Reveals the compose form the way the surface itself would.
 *
 * Needed because `#diaryNewBtn` is withheld when there is nowhere to write —
 * which is the behaviour under test two blocks down — and the submit handler
 * below it can then never be reached from a browser. What is driven afterwards
 * is the SHIPPED handler on the SHIPPED form: only the pane's `hidden` flag is
 * set here, and nothing else about the module is replaced.
 */
async function revealForm(page) {
    await page.evaluate(() => {
        document.getElementById('diaryListPane').hidden = true;
        document.getElementById('diaryForm').hidden = false;
    });
}

test.describe('the diary is offered only where the store it writes to exists', () => {
    test('a browser does not offer the diary', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });

        // ANTI-VACUITY FIRST: the control is IN the document, and a control this
        // channel does offer is visible in the same shot — otherwise a renamed
        // id or a shell that failed to boot would make "hidden" true for the
        // wrong reason.
        await expect(page.locator('#diaryBtn')).toHaveCount(1);
        await expect(page.locator('#activitiesBtn')).toBeVisible();

        await expect(page.locator('#diaryBtn')).toBeHidden();
        await expect(page.locator('#diaryModal')).toBeHidden();
    });
});

test.describe('on the native channel the diary opens, and says why it cannot be written', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
    });

    test('the page really took the native branch', async ({ page }) => {
        // The premise of every assertion in this block: an init script that
        // silently failed would test the web branch twice.
        await gotoApp(page, { state: STATES.seeded });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);
    });

    test('the control is offered, and pressing it opens the window', async ({ page }) => {
        // Empty openDiaryModal()'s body, or delete the .modal.show rule, and
        // this reds — which is why show-rule-coverage.spec.js is not allowed to
        // stand in for it.
        await gotoApp(page, { state: STATES.seeded });

        await expect(page.locator('#diaryBtn')).toBeVisible();
        await expect(page.locator('#diaryModal')).toBeHidden();

        await page.locator('#diaryBtn').click();

        await expect(page.locator('#diaryModal')).toBeVisible();
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'block');

        await page.locator('#diaryModalClose').click();
        await expect(page.locator('#diaryModal')).toBeHidden();
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'none');
    });

    test('a store that did not open is named as itself, not as a missing profile', async ({
        page,
    }) => {
        // THE TWO REFUSALS ARE DIFFERENT FACTS WITH DIFFERENT CURES, and this is
        // the one the parent meets when SQLCipher fails: restarting the app can
        // help, creating a profile cannot. Before the surface told them apart,
        // one string covered both.
        await gotoApp(page, { state: STATES.seeded });
        await page.locator('#diaryBtn').click();

        await expect(page.locator('#diaryNoStore')).toBeVisible();
        await expect(page.locator('#diaryNoStore')).toContainText('хранилище');
        await expect(page.locator('#diaryNoChild')).toBeHidden();

        // AND THE FORM IS NOT OFFERED. Offering it would make the parent write
        // about their child and then lose it, which is the failure ADR-046 §1
        // exists to prevent.
        await expect(page.locator('#diaryNewBtn')).toBeHidden();
        await expect(page.locator('#diaryForm')).toBeHidden();
    });
});

test.describe('a refusal leaves the parent holding their text', () => {
    test.beforeEach(async ({ page }) => {
        await simulateNativeShell(page);
    });

    test('an entry with no text is refused, and the window stays open', async ({ page }) => {
        await gotoApp(page, { state: STATES.seeded });
        await page.locator('#diaryBtn').click();
        await revealForm(page);

        await page.locator('#diarySaveBtn').click();

        const status = page.locator('#diaryStatus');
        await expect(status).toBeVisible();
        await expect(status).toContainText('НЕ сохранена');
        // The window does not close on a refusal: a dialog that disappears
        // reads as the action having been taken.
        await expect(page.locator('#diaryModal')).toBeVisible();
        await expect(page.locator('#diaryForm')).toBeVisible();
    });

    test('a refused entry keeps every character the parent typed', async ({ page }) => {
        // THE CLAIM THIS FILE EXISTS FOR. The refusal string promises the text
        // is still in the field; that promise is executed here rather than read
        // out of the module. The store is unavailable on this page, so the
        // refusal is the store one — the disk-full path makes the same promise
        // and is proven on the device.
        const written = 'Впервые сам встал у дивана и держался почти минуту';

        await gotoApp(page, { state: STATES.seeded });
        await page.locator('#diaryBtn').click();
        await revealForm(page);

        await page.locator('#diaryEventDate').fill('2026-02-01');
        await page.locator('#diaryBody').fill(written);
        await page.locator('#diarySaveBtn').click();

        const status = page.locator('#diaryStatus');
        await expect(status).toContainText('НЕ сохранена');
        await expect(status).toContainText('текст остался в поле');

        // Not "the field is non-empty" — the exact string, character for
        // character. A handler that trimmed, truncated or re-rendered it would
        // pass a weaker check.
        await expect(page.locator('#diaryBody')).toHaveValue(written);
        // And the day they chose is still chosen: a second attempt must be one
        // press, not a re-entry of everything.
        await expect(page.locator('#diaryEventDate')).toHaveValue('2026-02-01');
        // The save control is usable again, so that second press is possible.
        await expect(page.locator('#diarySaveBtn')).toBeEnabled();
    });

    test('the refusal never says the parent did something wrong', async ({ page }) => {
        // Tone is a property of this surface, at the moment it matters most.
        // Checked as an absence, which is the only way it can be checked: the
        // words that would make a lost entry read as the parent's fault.
        await gotoApp(page, { state: STATES.seeded });
        await page.locator('#diaryBtn').click();
        await revealForm(page);
        await page.locator('#diaryBody').fill('текст');
        await page.locator('#diarySaveBtn').click();

        const said = await page.locator('#diaryStatus').textContent();
        expect(said).toBeTruthy();
        for (const blaming of ['ошибка', 'неверно', 'некорректн', 'вы не']) {
            expect(said.toLowerCase(), `the refusal reads as blame: ${said}`).not.toContain(blaming);
        }
    });
});
