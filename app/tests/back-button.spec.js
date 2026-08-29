'use strict';

// What the page does with a back press — the JavaScript half of NAV-P3-INV-001.
//
// WHAT THIS FILE EXECUTES, AND WHAT IT CANNOT. It dispatches the SAME window
// event the native plugin dispatches, under the name read out of the shipped
// module rather than retyped, and then reads what the app did: which window
// closed, which surface is on screen, and which single answer went back to the
// plugin. That is the whole decision, executed on the shipped handler.
//
// IT PROVES NOTHING ABOUT THE JAVA, AND THAT IS SAID HERE SO NO GREEN IS READ
// AS MORE THAN IT IS. Whether a real KEYCODE_BACK reaches this event at all,
// and whether case three actually leaves the app, needs the platform: that is
// native/android/app/src/androidTest/java/app/theygrow/BackButtonTest.java on
// `android-instrumented`, which sends the key through the real window. In
// particular, THE THIRD CASE — «let the system default happen» — is only
// observable there, because a browser has no task to move to the background.
// What this file observes about case three is that the app changed nothing and
// asked the plugin for the default, which is the page's whole share of it.
//
// THE RECORDER IS THE INSTRUMENT, and it carries its own anti-vacuity: every
// leg asserts that a call was recorded, so a stub that silently stopped
// resolving would red rather than pass with an empty log.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { gotoApp, STATES } = require('./support/seed');
const { installPageBridge, shippedStatements } = require('./support/page-bridge');
const { currentMount } = require('./support/ship-list');
const { appModule } = require('./support/app-module');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);
const STATEMENTS = shippedStatements(APP_ROOT, MOUNT.dir);

const SELF = 'p-back-self';
const CHILD = {
    id: 'child-back',
    name: 'Проба',
    birthdate: '2024-09-15',
    createdAtUtc: 1_700_000_000_000,
};

// Read, never retyped: the event name is one protocol constant with two ends
// (surfaces/back.js and BackButtonPlugin.java), and a test that spelled it out
// by hand would keep passing after a rename on one of them.
const BACK_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'back.js'), 'utf8');
const BACK_EVENT = /BACK_EVENT\s*=\s*'([^']+)'/.exec(BACK_SOURCE)[1];
const NAV_CONFIG_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'nav', 'config.js'), 'utf8');
const DEADLINE_MS = Number(/backAnswerDeadlineMs:\s*(\d+)/.exec(NAV_CONFIG_SOURCE)[1]);

test('the constants this file drives were actually read', () => {
    // Anti-vacuity for the readers above: a regex that missed would leave
    // `undefined` here and every leg below would dispatch an event nothing
    // listens for, silently.
    expect(BACK_EVENT).toBe('theygrowback');
    expect(DEADLINE_MS).toBeGreaterThan(0);
});

/**
 * Boots the app on the native branch, with a store that opens and a recorder
 * standing where the back plugin stands.
 *
 * WHY THE FULL STORE SEAM AND NOT A BARE `isNativePlatform` PROBE. Measured in
 * this file's first run: a bridge that answers `nativePromise` at all makes
 * `isNativeStore()` true, so the app tries to open a store — and a store that
 * then refuses puts `core/state.js` on BACKEND.unavailable, where there is no
 * family at all. Every leg below would have been driving an app with no child,
 * no marks and the create-profile window standing over it. The seam in
 * `support/page-bridge.js` is the instrument the diary legs already use for
 * exactly this: the shipped chain executes, and what it proves nothing about —
 * SQLite — is not what this file is about.
 *
 * The recorder WRAPS that seam rather than replacing it. Init scripts run in
 * order, so this one takes the bridge the seam installed and answers only for
 * `TheyGrowBack`, handing every other plugin back to it untouched.
 */
async function simulateShellWithPlugin(page) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child: CHILD,
        selfParticipantId: SELF,
    });
    await page.addInitScript(() => {
        window.__backCalls = [];
        const storeSeam = window.Capacitor.nativePromise;
        window.Capacitor.nativePromise = (plugin, method, options) => {
            if (plugin !== 'TheyGrowBack') return storeSeam(plugin, method, options);
            window.__backCalls.push({ plugin, method, options });
            return Promise.resolve({});
        };
    });
}

const calls = (page) => page.evaluate(() => window.__backCalls);

/** Dispatches the event the plugin dispatches, and lets the answer settle. */
async function pressBack(page, event) {
    await page.evaluate((name) => window.dispatchEvent(new Event(name)), event);
}

/** The method name of the last call the page made to the plugin. */
async function lastAnswer(page) {
    const log = await calls(page);
    expect(log.length, 'the page answered nothing at all').toBeGreaterThan(0);
    return log[log.length - 1].method;
}

const diary = (page) => page.locator('#diaryModal');

test.describe('the back button resolves in three cases (NAV-P3-INV-001, off-device half)', () => {
    test.beforeEach(async ({ page }) => {
        await simulateShellWithPlugin(page);
        await gotoApp(page, { state: STATES.empty });
    });

    test('the interceptor is armed with the declared deadline, and only then', async ({ page }) => {
        // THE PREMISE OF EVERY LEG BELOW. Nothing here is true of an app that
        // never armed: the plugin ships disarmed on purpose, so a page that
        // failed to arm leaves the hardware button behaving exactly as it did
        // before this packet — and every assertion below would be about an
        // event nobody would ever send.
        const log = await calls(page);
        const arming = log.filter((call) => call.method === 'arm');
        expect(arming).toHaveLength(1);
        expect(arming[0].plugin).toBe('TheyGrowBack');
        // The deadline is NOT a Java literal: it is declared once in
        // nav/config.js and handed over here.
        expect(arming[0].options.deadlineMs).toBe(DEADLINE_MS);
    });

    test('case one: an open window closes, and the pager does not move', async ({ page }) => {
        await page.locator('#menuBtn').click();
        await page.locator('#menuAboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

        await pressBack(page, BACK_EVENT);

        await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
        // The pager stayed where it was: a press that closed a window is not
        // also a press that navigated.
        await expect(diary(page)).toBeHidden();
        await expect(page.locator('#surfaceSkillsBtn')).toHaveAttribute('aria-current', 'page');
        expect(await lastAnswer(page)).toBe('handled');
    });

    test('case two: off the start surface, the pager steps back', async ({ page }) => {
        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();

        await pressBack(page, BACK_EVENT);

        await expect(diary(page)).toBeHidden();
        await expect(page.locator('#surfaceSkillsBtn')).toHaveAttribute('aria-current', 'page');
        expect(await lastAnswer(page)).toBe('handled');
    });

    test('case three: on the start surface with nothing open, the platform decides', async ({ page }) => {
        await expect(diary(page)).toBeHidden();
        const before = (await calls(page)).length;

        await pressBack(page, BACK_EVENT);

        // Nothing on screen changed — the app did not invent a confirmation, a
        // toast or a second press to require.
        await expect(diary(page)).toBeHidden();
        await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
        await expect(page.locator('#surfaceSkillsBtn')).toHaveAttribute('aria-current', 'page');

        const log = await calls(page);
        expect(log.length, 'the press produced no answer at all').toBe(before + 1);
        expect(log[log.length - 1].method).toBe('passThrough');
    });

    test('the three cases are answered exactly once each, in that order', async ({ page }) => {
        // The ORDER is the behaviour: a window outranks the pager, and the pager
        // outranks leaving. A press is never answered twice, because the plugin
        // is waiting for exactly one answer.
        await page.locator('#surfaceDiaryBtn').click();
        await expect(diary(page)).toBeVisible();

        await page.locator('#diaryModalClose').click();
        await expect(diary(page)).toBeHidden();

        const answersBefore = (await calls(page)).filter((c) => c.method !== 'arm').length;
        expect(answersBefore).toBe(0);

        await page.locator('#surfaceDiaryBtn').click();
        await pressBack(page, BACK_EVENT);
        await pressBack(page, BACK_EVENT);

        const answers = (await calls(page)).filter((c) => c.method !== 'arm').map((c) => c.method);
        expect(answers).toEqual(['handled', 'passThrough']);
    });
});

test.describe('the back button unwinds the one real stack this shell has', () => {
    test.beforeEach(async ({ page }) => {
        await simulateShellWithPlugin(page);
        await gotoApp(page, { state: STATES.empty });
    });

    test('the skill window closes before the activities window under it', async ({ page }) => {
        await page.locator('#activitiesBtn').click();
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);

        const card = page.locator('#activitiesGrid .activity-card-title[data-skill-id]').first();
        await expect(card).toBeVisible();
        await card.click();
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');

        // The DECLARED order is what decides this, and it is the only place the
        // order is load-bearing: both windows are open at once.
        await pressBack(page, BACK_EVENT);
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'none');
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);

        await pressBack(page, BACK_EVENT);
        await expect(page.locator('#activitiesModal')).not.toHaveClass(/show/);
        await expect(diary(page)).toBeHidden();
    });

    test('it walks the visited cards before it closes the skill window', async ({ page }) => {
        // WHAT THE TRAIL IS, MEASURED. Every card-to-card move is recorded, by
        // any of the three link kinds the window renders with the same class —
        // «Требуемые навыки», «Открывает дальше» and «Откроется, когда». So this
        // is a walk back through VISITED CARDS, which can lead down the graph as
        // well as up, and the back button owes it the same step the window's own
        // control gives.
        const opened = await page.evaluate(
            ({ app }) => {
                const first = Object.values(app.DATA._skillsMap).find(
                    (skill) => (skill.prerequisites || []).length > 0
                );
                app.openSkillModal(first, true, 'parity');
                return first.id;
            },
            { app: await appModule(page) }
        );

        await expect(page.locator('#skillModalBody h2')).toHaveAttribute('data-skill-id', opened);

        const chip = page.locator('#skillModalBody .prerequisite-skill[data-skill-id]').first();
        const chipId = await chip.getAttribute('data-skill-id');
        await chip.click();
        await expect(page.locator('#skillModalBody h2')).toHaveAttribute('data-skill-id', chipId);

        // One press: back to the card the parent came from, window still open.
        await pressBack(page, BACK_EVENT);
        await expect(page.locator('#skillModalBody h2')).toHaveAttribute('data-skill-id', opened);
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');
        expect(await lastAnswer(page)).toBe('handled');

        // Another press: the trail is empty, so the window closes.
        await pressBack(page, BACK_EVENT);
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'none');
        expect(await lastAnswer(page)).toBe('handled');

        // And a third leaves the app, because there is nothing left to unwind.
        await pressBack(page, BACK_EVENT);
        expect(await lastAnswer(page)).toBe('passThrough');
    });
});

test.describe('a browser is never armed and never listens', () => {
    test('no plugin call is made and a back event changes nothing', async ({ page }) => {
        await page.addInitScript(() => {
            window.__backCalls = [];
        });
        await gotoApp(page, { state: STATES.seeded });
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(false);

        await pressBack(page, BACK_EVENT);

        await expect(diary(page)).toBeHidden();
        expect(await calls(page)).toEqual([]);
    });
});
