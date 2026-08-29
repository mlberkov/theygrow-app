'use strict';

// NAV-P4-INV-001 — the two surfaces that need a child open ONE window, and
// nothing tells a parent their child has mastered anything when there is no
// child.
//
// WHAT WAS WRONG. `getRelevantUncompletedSkills()` returned an empty list before
// it looked at a single skill when there was no profile, and the caller rendered
// an empty list as «Все навыки освоены — подходящих активностей сейчас нет». Two
// states collapsed into one sentence and one of them was false: with no child
// nothing is known, and «освоено» has no subject. The app already had the right
// answer for that state — the create-profile window `surfaces/skill-completion.js`
// opens when a mark is refused for the same reason (ADR-015).
//
// THIS FILE IS IN `behavior` AND NOT IN `contract`, AND THE REASON IS THE CLAIM
// ITSELF (AGENTS.md §11). «Both doors open the same window» and «that sentence is
// not on the screen» are facts about a rendered page and handlers that ran. A
// source scan could see the call and could not see which element became visible,
// nor that only one of them exists. The one thing here a page CANNOT show — that
// the refusal REUSES the shipped opener instead of re-implementing the reveal —
// is the last test in this file, and it says about itself that it is static.
//
// IT IS NOT IN `native` EITHER, on the argument diary-save.spec.js records: that
// project serves a different web root, and a leg that also varied the channel
// would vary two things at once. The path carries no channel branch at all —
// `surfaces/activities.js` reads no `historyBackend()`, no `Capacitor` — so the
// web channel is where the packet's claim is made and the byte-identity of the
// two channels (LSC-P1-INV-002) is what carries it to the other one.

const fs = require('fs');
const path = require('path');

const { test, expect, gotoApp, STATES, STORAGE_KEYS, PROFILE } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);

const DIALOG = '#createProfileModal';
const ACTIVITIES = '#activitiesModal';

// The false answer, quoted from the shipped module rather than retyped: a test
// that carries its own copy of the string would keep passing after the module's
// copy drifted.
const MASTERED_SENTENCE = 'Все навыки освоены — подходящих активностей сейчас нет';

/** Door one: the footer control that asks for the month's activities. */
async function openActivities(page) {
    await page.locator('#activitiesBtn').click();
}

/** Door two: a mark on the first skill in the table. `click`, not `check` —
 *  `check` asserts the box ends up checked, and the whole point of this path is
 *  that the mark is rolled back. */
async function markFirstSkill(page) {
    await page.locator('#tableBody tr[data-skill-id] input[type="checkbox"]').first().click();
}

test.describe(`no child: one window, and no false all-clear — /m/${MOUNT.dir}/ (NAV-P4-INV-001)`, () => {
    test('the fixture really has no child, and the table really rendered', async ({ page }) => {
        // ANTI-VACUITY FOR EVERY LEG BELOW. If `STATES.empty` ever stopped being
        // empty, or the table stopped rendering, both doors would be unreachable
        // and every assertion here would hold for the wrong reason.
        await gotoApp(page, { state: STATES.empty });
        expect(
            await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEYS.profiles),
            'the empty state carries a profile — every leg in this file is about the state with none'
        ).toBeNull();
        await expect(page.locator('#tableBody tr[data-skill-id]').first()).toBeVisible();
        await expect(page.locator(DIALOG)).not.toHaveClass(/show/);
        await expect(page.locator(ACTIVITIES)).not.toHaveClass(/show/);
    });

    test('door one — the activities control opens the profile window, and not the activities window', async ({
        page,
    }) => {
        await gotoApp(page, { state: STATES.empty });

        await openActivities(page);

        await expect(page.locator(DIALOG)).toHaveClass(/show/);
        // Not merely class-toggled: the window is on screen.
        await expect(page.locator(DIALOG)).toHaveCSS('display', 'block');
        await expect(page.locator(`${DIALOG} h2`)).toBeVisible();
        // And the activities window is NOT opened underneath it. All .modal
        // elements share one z-index, so an activities window opened here would
        // stand over the dialog the parent is being asked to fill in.
        await expect(page.locator(ACTIVITIES)).not.toHaveClass(/show/);
    });

    test('door two — a skill mark opens the profile window, and the mark is rolled back', async ({
        page,
    }) => {
        await gotoApp(page, { state: STATES.empty });
        const box = page.locator('#tableBody tr[data-skill-id] input[type="checkbox"]').first();

        await markFirstSkill(page);

        await expect(page.locator(DIALOG)).toHaveClass(/show/);
        await expect(box).not.toBeChecked();
    });

    test('both doors open ONE window — the same element, not a second one like it', async ({
        page,
    }) => {
        // THE CLAIM THE PACKET IS REALLY MAKING, AND IT NEEDS BOTH HALVES.
        // A stamp written onto the element the FIRST door opened must still be
        // on the element the SECOND door opens — a clone would carry none — and
        // the document must hold exactly one element with that id, or "the same
        // one" would be a statement about whichever of two the locator picked.
        await gotoApp(page, { state: STATES.empty });

        await openActivities(page);
        await expect(page.locator(DIALOG)).toHaveClass(/show/);
        await page.evaluate(() => {
            document.getElementById('createProfileModal').setAttribute('data-nav-p4-probe', '1');
        });

        await page.locator('#cancelProfile').click();
        await expect(page.locator(DIALOG)).not.toHaveClass(/show/);

        await markFirstSkill(page);
        await expect(page.locator(DIALOG)).toHaveClass(/show/);

        await expect(
            page.locator(DIALOG),
            'the second door opened a window that never met the first — the two paths do not share one dialog'
        ).toHaveAttribute('data-nav-p4-probe', '1');
        expect(
            await page.locator(DIALOG).count(),
            'the shell holds more than one #createProfileModal — "the same window" cannot be said of two elements'
        ).toBe(1);
    });

    test('with no child, nothing on screen claims the child has mastered anything', async ({
        page,
    }) => {
        await gotoApp(page, { state: STATES.empty });

        await openActivities(page);

        await expect(page.locator('.no-activities-message')).toHaveCount(0);
        expect(
            await page.locator('body').innerText(),
            'the no-profile path still answers that everything is mastered — there is no child, so nothing is known'
        ).not.toContain(MASTERED_SENTENCE);
    });
});

test.describe(`the sentence is still what a family who really finished sees — /m/${MOUNT.dir}/`, () => {
    test('a child with every skill marked gets the all-mastered sentence, and the activities window', async ({
        page,
    }) => {
        // ANTI-VACUITY FOR THE LEG ABOVE, AND THE REASON THE STRING WAS NOT
        // DELETED. "Nothing says that sentence" is trivially true of a build that
        // no longer contains it. This leg reaches the state in which the sentence
        // is TRUE and requires it, so the leg above is a statement about the
        // no-child PATH rather than about a removed literal.
        //
        // The skill ids are read off the rendered table rather than out of
        // kb-v1.json: what has to be complete is what the app treats as the set
        // of skills, and that is the only place that answers it.
        await gotoApp(page, { state: STATES.seeded });
        const ids = await page.$$eval('#tableBody tr[data-skill-id]', (rows) =>
            rows.map((row) => row.getAttribute('data-skill-id'))
        );
        expect(ids.length, 'the table rendered no skills — the "everything" below would be empty').toBeGreaterThan(100);

        await page.evaluate(
            ({ keys, profile, completed }) => {
                window.localStorage.setItem(
                    keys.profiles,
                    JSON.stringify([{ ...profile, completedSkills: completed }])
                );
                window.localStorage.setItem(keys.current, profile.id);
            },
            { keys: STORAGE_KEYS, profile: PROFILE, completed: ids }
        );
        await page.reload();
        await page.waitForFunction(
            () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
        );

        await openActivities(page);

        await expect(page.locator(ACTIVITIES)).toHaveClass(/show/);
        await expect(page.locator(DIALOG)).not.toHaveClass(/show/);
        await expect(page.locator(`${ACTIVITIES} .no-activities-message`)).toHaveText(
            MASTERED_SENTENCE
        );
    });

    test('a seeded family still gets the activities window and its cards', async ({ page }) => {
        // The other anti-vacuity direction: the guard above must not be green
        // because the activities window stopped opening for anybody.
        await gotoApp(page, { state: STATES.seeded });

        await openActivities(page);

        await expect(page.locator(ACTIVITIES)).toHaveClass(/show/);
        await expect(page.locator(DIALOG)).not.toHaveClass(/show/);
        await expect(
            page.locator('#activitiesGrid .activity-card-title[data-skill-id]').first()
        ).toBeVisible();
    });
});

test.describe('the refusal reuses the shipped opener (static — a property of the tree)', () => {
    // THIS ONE BOOTS NOTHING AND SAYS SO (AGENTS.md §11). The runtime legs above
    // prove the two doors open the SAME ELEMENT; they would stay green against a
    // second implementation that reached for the same id, because there is only
    // one element either way. What a page cannot show is that the surface REUSES
    // `openCreateProfileModal()` rather than carrying its own copy of the reveal
    // — and a second copy is how the two paths drift apart later, one of them
    // keeping a behaviour the other loses. That is a property of the source, and
    // reading the source is the right instrument for it.
    const MODULE = fs.readFileSync(
        path.join(APP_ROOT, 'm', MOUNT.dir, 'surfaces', 'activities.js'),
        'utf8'
    );
    // Comments are stripped before matching, so the decision can be EXPLAINED in
    // the file it governs without the explanation reading as the thing it
    // forbids. Same technique as install-channel.spec.js.
    const CODE = MODULE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    test('the scan is looking at the real module', () => {
        expect(CODE.length, 'the activities surface collapsed to almost nothing').toBeGreaterThan(1000);
        expect(CODE, 'the module no longer opens the activities window at all').toContain(
            "classList.add('show')"
        );
    });

    test('it imports the shipped opener from the surface that owns the window', () => {
        expect(
            CODE,
            'surfaces/activities.js no longer imports openCreateProfileModal from ./profile.js'
        ).toMatch(/import\s*\{[^}]*\bopenCreateProfileModal\b[^}]*\}\s*from\s*'\.\/profile\.js'/);
        expect(CODE).toContain('openCreateProfileModal()');
    });

    test('it names no create-profile element of its own', () => {
        expect(
            CODE,
            'surfaces/activities.js reaches for the create-profile window by id — that is a second'
                + ' implementation of a reveal that profile.js owns, and it is how the two paths drift'
        ).not.toContain('createProfileModal');
    });
});
