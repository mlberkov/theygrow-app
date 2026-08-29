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
// written, and nothing about the DISK-FULL refusal. The disk-full string is NOT
// asserted anywhere in this file, so nobody can read a green here as covering
// it: reaching it needs a store that opens and a genuine SQLITE_FULL, and that
// is `DiaryEntryTest` on `android-instrumented`, where the engine is real and
// the ceiling is forced with `PRAGMA max_page_count` — DIA-P3 checkpoint 4.
// `DIA-DL-004` alternative 9 rejected faking a store to reach that refusal, and
// that rejection stands untouched.
//
// THE OTHER HALF OF THAT SENTENCE WAS DRAWN TOO WIDE, AND RUN 31971968427 SENT
// THE BILL (DIA-P3R). "Faking a store would prove the fake" is true of the
// disk-full refusal and false of the SUCCESS path, and applying it to both left
// the diary's success path with no executor anywhere off-device — every leg in
// this file ends in a refusal BEFORE the store is called, so a bare
// `ReferenceError` on the line that calls it went unseen through 1104 green
// tests until an emulator found it. The success path now has an executor,
// `app/tests/diary-save.spec.js`, which drives this same shipped surface against
// a seam at the BRIDGE boundary that resolves. It proves the surface asks the
// store for the right thing and renders what comes back; it proves nothing about
// SQLite, and it does not touch the disk-full refusal, which stays exactly where
// the paragraph above puts it.

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
        await expect(page.locator('#surfaceDiaryBtn')).toHaveCount(1);
        await expect(page.locator('#activitiesBtn')).toBeVisible();

        await expect(page.locator('#surfaceDiaryBtn')).toBeHidden();
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

        await expect(page.locator('#surfaceDiaryBtn')).toBeVisible();
        await expect(page.locator('#diaryModal')).toBeHidden();

        await page.locator('#surfaceDiaryBtn').click();

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
        await page.locator('#surfaceDiaryBtn').click();

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
        await page.locator('#surfaceDiaryBtn').click();
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
        await page.locator('#surfaceDiaryBtn').click();
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
        await page.locator('#surfaceDiaryBtn').click();
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

// ─────────────────────────────────────────────────────────────────────────────
// THE FIRST LAUNCH AFTER AN INSTALL (L3-P2, FIU-DL-002).
//
// Until this packet the first screen a family met was the transfer offer: on
// the native channel `offerImportIfPending()` opened `#importModal` at boot
// whenever nothing was staged, and on a phone that modal is 100vw/100dvh, so it
// was a SCREEN — over an empty tracker, offering to move a history the app
// could not see. Dead by construction on that channel too: the WebView lives at
// https://localhost and the browser history is on the production origin, so
// `readProfilesRaw()` there had always returned null.
//
// The owner removed the offer outright. That leaves a first launch with exactly
// one path to a profile, so these legs execute that it exists, that it is taken
// without the parent knowing anything about transfer, and — the anti-vacuity —
// that it stops the moment there is a child.
//
// A STORE THAT OPENS IS REQUIRED HERE, and that is why this block uses the
// bridge seam rather than the `isNativePlatform` stand-in the blocks above use.
// "No profile" and "no store" are different refusals with different cures, and
// the stand-in can only ever produce the second one.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { installPageBridge, shippedStatements } = require('./support/page-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const STATEMENTS = shippedStatements(APP_ROOT, MOUNT.dir);

const SELF = 'p-first-install-self';
const A_CHILD = {
    id: 'child-first-install',
    name: 'Проба',
    birthdate: '2024-09-15',
    createdAtUtc: 1_700_000_000_000,
};

/** Boots the app on the native branch with a store that opens and holds `child`. */
async function bootWithStore(page, child) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child,
        selfParticipantId: SELF,
    });
    await gotoApp(page, { state: STATES.empty });
}

const createProfileModal = (page) => page.locator('#createProfileModal');

test.describe('a fresh install reaches a working profile by itself', () => {
    test('the transfer offer is not merely hidden — it is not in the document', async ({ page }) => {
        await bootWithStore(page, null);

        // ANTI-VACUITY: a shell that failed to boot would make every count zero.
        await expect(page.locator('#surfaceDiaryBtn')).toBeVisible();
        expect(
            await page.locator('#importModal').count(),
            'the transfer offer is back in the shell'
        ).toBe(0);
        expect(await page.locator('#importHandoffBtn').count()).toBe(0);
        expect(await page.locator('#importRunBtn').count()).toBe(0);
    });

    test('with nobody in the store the app asks for the child itself', async ({ page }) => {
        await bootWithStore(page, null);
        await expect(
            createProfileModal(page),
            'a first launch offered nothing at all — the one path to a profile is a dropdown'
                + ' the parent has no reason to open (FIU-P2-INV-001)'
        ).toHaveCSS('display', 'block');
        await expect(page.locator('#childName')).toBeVisible();
        await expect(page.locator('#childBirthdate')).toBeVisible();
    });

    test('THE ARM — with a child in the store it asks nothing', async ({ page }) => {
        // Without this the leg above could be green on a surface that opens the
        // create-profile window at every launch, which is the defect L3-P1 just
        // finished removing in its other form.
        await bootWithStore(page, A_CHILD);
        await expect(createProfileModal(page)).toHaveCSS('display', 'none');
    });

    test('THE SECOND ARM — a browser is asked nothing either', async ({ page }) => {
        // The offer is a runtime branch on the backend, not a second build. The
        // web channel keeps the first visit it has always had.
        await gotoApp(page, { state: STATES.empty });
        await expect(createProfileModal(page)).toHaveCSS('display', 'none');
    });

    // WHAT THIS BLOCK DOES NOT EXECUTE, AND WHERE IT IS EXECUTED INSTEAD.
    // Filling that form in and pressing Создать is NOT driven here. On this
    // backend the child is appended to the journal, and the seam behind these
    // legs deliberately does not model `v_child_attribute_current` — projecting
    // a child out of the entries it just recorded would be a fake proving a
    // fake, the same rule that keeps FTS matching out of it (see the seam's own
    // header). So the two halves are executed where each is real:
    //
    //   the SURFACE half — the form, the handler, the switch, the header and
    //   the table rebuild — `app/tests/behavior.spec.js`, on the web channel,
    //   where `createProfile` goes through core/repo-local.js and needs no
    //   store at all. It is the same shipped handler either way;
    //   the JOURNAL half — `appendChild` against a real SQLCipher store —
    //   `DiaryEntryTest` on `android-instrumented`.
    //
    // Written down because until L3-P2 NEITHER existed: the app's only path to
    // a profile had no executor anywhere, on any channel.
});

test.describe('the diary refusal offers the act that resolves it', () => {
    test('with no child the diary names the button, and pressing it opens the form', async ({
        page,
    }) => {
        await bootWithStore(page, null);

        // The parent puts the boot-time question aside — they came to write,
        // not to fill in a form — and goes to the diary instead.
        await page.locator('#cancelProfile').click();
        await expect(createProfileModal(page)).toHaveCSS('display', 'none');

        await page.locator('#surfaceDiaryBtn').click();
        await expect(page.locator('#diaryModal')).toBeVisible();
        await expect(page.locator('#diaryNoChild')).toBeVisible();
        await expect(
            page.locator('#diaryNoStore'),
            'a missing profile was named as a store that did not open — two causes with two'
                + ' different cures, and only one of them is true here'
        ).toBeHidden();
        await expect(page.locator('#diaryNewBtn')).toBeHidden();

        const createButton = page.locator('#diaryCreateProfileBtn');
        await expect(
            createButton,
            'the refusal names a menu and offers nothing — the parent is told what is wrong and'
                + ' left to find the cure (FIU-P2-INV-001)'
        ).toBeVisible();
        await createButton.click();

        // BOTH HALVES. The diary has to close first: every .modal shares one
        // z-index, #createProfileModal precedes #diaryModal in the markup, and
        // a create window opened UNDER a full-screen white panel is a button
        // that does nothing.
        await expect(
            page.locator('#diaryModal'),
            'the diary stayed open over the window it just opened'
        ).toBeHidden();
        await expect(createProfileModal(page)).toHaveCSS('display', 'block');
        await expect(page.locator('#childName')).toBeVisible();
    });

    test('THE ARM — with a child there is no such button', async ({ page }) => {
        await bootWithStore(page, A_CHILD);
        await page.locator('#surfaceDiaryBtn').click();
        await expect(page.locator('#diaryNewBtn')).toBeVisible();
        await expect(page.locator('#diaryCreateProfileBtn')).toBeHidden();
        await expect(page.locator('#diaryNoChild')).toBeHidden();
    });
});
