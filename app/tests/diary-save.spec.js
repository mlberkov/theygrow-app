'use strict';

// The diary's SUCCESS path, executed in a browser (DIA-P3R).
//
// WHY THIS FILE EXISTS — it is the finding of run 31971968427, not a tidy-up.
// `surfaces/diary.js` shipped a save handler that spread `...who`, an identifier
// the module never declared, so EVERY create threw a `ReferenceError` before
// reaching the store and every parent got a generic refusal. It survived 1104
// green tests because nothing off-device had ever executed the resolving branch:
// `diary-surface.spec.js` reaches the surface with a simulated shell and NO
// store behind it, so `isNativeStore()` is false and every leg there ends in a
// refusal before the try block. The success path had no executor anywhere except
// an emulator that runs on `pull_request` and dispatch.
//
// WHAT THIS PROVES. That the shipped surface asks the shipped store for the
// right thing — with the author the store minted and the child the parent is
// looking at — survives the answer, re-renders, and shows the parent their
// entry; and that an edit is an overwrite of the same row. The whole chain
// `saveEntry -> store/boot.js -> store/records.js -> store/bridge.js` executes.
//
// WHAT THIS PROVES NOTHING ABOUT. SQLite. The seam behind it
// (`support/page-bridge.js`) executes no SQL, applies no DDL, and has no
// constraints, triggers, transactions, index or encryption. What the statements
// MEAN is `pytest app/tests/schema` (`test_diary_write_path.py`) against the real
// frozen DDL; that a parent's entry LANDS is `DiaryEntryTest` on
// `android-instrumented`, on the real plugin and the real SQLCipher. This file
// is not a substitute for either, and the DISK-FULL refusal is deliberately
// absent from it: reaching that needs a store that opens, `DIA-DL-005`
// alternative 9 rejected faking it, and that rejection is untouched.

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, STATES } = require('./support/seed');
const { installPageBridge, shippedStatements } = require('./support/page-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
// The mount the SHELL references, never a literal (EMV-DL-001): a copy-forward
// bump leaves the frozen generation shipped, so a pinned version would keep
// driving bytes nothing runs.
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const STATEMENTS = shippedStatements(APP_ROOT, MOUNT.dir);

// The id the store minted. The diary's author attribution comes from here and
// from nowhere else, which is what makes "asked with the right author"
// assertable rather than assumed.
const SELF = 'p-page-bridge-self';
const CHILD = {
    id: 'child-page-bridge',
    name: 'Проба',
    birthdate: '2024-09-15',
    createdAtUtc: 1_700_000_000_000,
};

// The child a leg creates through the form, and the sibling that comes after.
// Neither id is written here: the app mints them, and a leg that pinned one
// would stop being able to see which child an entry was attributed to.
const NEW_CHILD = { name: 'Мила', birthdate: '2024-09-15' };
const SIBLING = { name: 'Артём', birthdate: '2022-04-02' };
// The pinned clock (`support/seed.js`), which is what the form defaults to.
const TODAY = '2026-03-15';
const FIRST_ENTRY = 'Первый день дома: спал у меня на руках всю дорогу';

const MORNING = '2026-02-01';
const ENTRY = 'Впервые сам встал у дивана и держался почти минуту';
const CORRECTED = 'Не у дивана, а у стула';

/**
 * Boots the app with a store that opens.
 *
 * `STATES.empty` rather than `STATES.seeded`: on this backend the family comes
 * from the STORE, and legacy profiles in localStorage belong to a channel this
 * one is not. (Until L3-P2 there was a second reason — a boot-time transfer
 * offer put a modal over the surface under test, and every leg here had to
 * dismiss it first. That offer is gone, FIU-DL-002.)
 */
async function bootWithStore(page) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child: CHILD,
        selfParticipantId: SELF,
    });
    await gotoApp(page, { state: STATES.empty });
}

/**
 * Boots the app with a store that opened and holds NOBODY.
 *
 * The state a first launch is in, and the one this packet's flow starts from:
 * the app opens the create-profile window itself (`FIU-P2-INV-001`), so a leg
 * below fills that window rather than pressing a control to reach it.
 */
async function bootWithEmptyStore(page) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child: null,
        selfParticipantId: SELF,
    });
    await gotoApp(page, { state: STATES.empty });
}

/** Opens the diary and switches to the compose form, as a parent does. */
async function openCompose(page) {
    await page.locator('#diaryBtn').click();
    // The list renders asynchronously, and that render decides whether the
    // compose control is offered at all — pressing it in the same turn would
    // sometimes press a button the app had not finished deciding about.
    await expect(page.locator('#diaryNewBtn')).toBeVisible();
    await page.locator('#diaryNewBtn').click();
    await expect(page.locator('#diaryForm')).toBeVisible();
}

/** Every statement the surface caused, flattened out of its transactions. */
function statements(calls) {
    const out = [];
    for (const call of calls) {
        if (call.plugin !== 'CapacitorSQLite') continue;
        if (call.method === 'executeSet') {
            for (const item of call.options.set) {
                out.push({ statement: item.statement, values: item.values });
            }
        } else if (call.method === 'run') {
            out.push({ statement: call.options.statement, values: call.options.values });
        }
    }
    return out;
}

const transcript = (page) => page.evaluate(() => window.__pageBridgeCalls);

test.describe('a parent writes an entry and the app shows it back', () => {
    test('the page really took the journal backend', async ({ page }) => {
        // THE PREMISE OF EVERY LEG BELOW, and the state `diary-surface.spec.js`
        // proves is unreachable without a store: there, `#diaryNoStore` is
        // visible and `#diaryNewBtn` is withheld. If this init script silently
        // failed, the legs below would drive the refusal path and could not tell.
        await bootWithStore(page);
        await page.locator('#diaryBtn').click();

        await expect(page.locator('#diaryNoStore')).toBeHidden();
        await expect(page.locator('#diaryNoChild')).toBeHidden();
        await expect(page.locator('#diaryNewBtn')).toBeVisible();
        await expect(page.locator('#diaryEmpty')).toBeVisible();
    });

    test('the entry is saved, and the list is the confirmation', async ({ page }) => {
        // THE LEG THIS FILE EXISTS FOR. With `...who` restored this reds twice
        // over: here, on a list that never gains a row, and again on seed.js's
        // console-error guard catching `[diary] the entry was not recorded:
        // ReferenceError`.
        await bootWithStore(page);
        await openCompose(page);

        await page.locator('#diaryEventDate').fill(MORNING);
        await page.locator('#diaryBody').fill(ENTRY);
        await page.locator('#diarySaveBtn').click();

        // The window does NOT close on success: the confirmation is the list,
        // with the entry standing in it (DIA-DL-005 (g)).
        await expect(page.locator('#diaryForm')).toBeHidden();
        await expect(page.locator('#diaryModal')).toBeVisible();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        // Character for character, and the day the parent chose — not "the list
        // is non-empty", which a surface that rendered a placeholder would pass.
        await expect(page.locator('#diaryList .diary-entry-body')).toHaveText(ENTRY);
        await expect(page.locator('#diaryList .diary-entry-date')).toHaveText(MORNING);
        await expect(page.locator('#diaryEmpty')).toBeHidden();
    });

    test('the store was asked with the author it minted and the child on screen', async ({
        page,
    }) => {
        // THE ASSERTION `...who` FAILS. The rendered list alone would not carry
        // it: what the defect destroyed was the ASKING, so this reads the
        // transcript of what the surface actually sent across the seam.
        await bootWithStore(page);
        await openCompose(page);
        await page.locator('#diaryEventDate').fill(MORNING);
        await page.locator('#diaryBody').fill(ENTRY);
        await page.locator('#diarySaveBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        const calls = await transcript(page);
        const written = statements(calls).filter((s) =>
            s.statement === STATEMENTS.RECORD_INSERT_SQL
        );
        expect(written, 'the surface wrote no record at all').toHaveLength(1);

        const [record] = written;
        expect(record.values, 'the entry is attributed to the id the store minted').toContain(SELF);
        expect(record.values, 'the text the parent typed').toContain(ENTRY);
        expect(record.values, 'the day the entry is about').toContain(MORNING);
        expect(record.values, 'the declared kind, from the shipped knob').toContain('text');

        // And the area lookup asked about this author and this child — the other
        // half of `who`, which decides WHOSE diary the entry lands in.
        const lookup = calls.find(
            (c) => c.method === 'query' && c.options.statement === STATEMENTS.AREA_LOOKUP_SQL
        );
        expect(lookup, 'the surface never asked which diary it was writing into').toBeTruthy();
        expect(lookup.options.values.slice(0, 2)).toEqual([SELF, CHILD.id]);
    });

    test('a second save is not a second diary', async ({ page }) => {
        // The area is created once and reused. Driven from the SURFACE rather
        // than from the module, because the surface is what calls twice.
        await bootWithStore(page);
        await openCompose(page);
        await page.locator('#diaryEventDate').fill(MORNING);
        await page.locator('#diaryBody').fill(ENTRY);
        await page.locator('#diarySaveBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        await page.locator('#diaryNewBtn').click();
        await page.locator('#diaryEventDate').fill('2026-02-02');
        await page.locator('#diaryBody').fill('И ещё раз');
        await page.locator('#diarySaveBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(2);

        const written = statements(await transcript(page));
        expect(
            written.filter((s) => s.statement === STATEMENTS.AREA_INSERT_SQL),
            'a second entry created a second diary for the same child'
        ).toHaveLength(1);
        expect(
            written.filter((s) => s.statement === STATEMENTS.RECORD_INSERT_SQL)
        ).toHaveLength(2);
    });
});

test.describe('an edit overwrites the entry, at the surface', () => {
    test('the correction replaces the text and appends nothing', async ({ page }) => {
        // PDR-026 §4 rule 1, driven through the button a parent presses. The
        // module's half is `diary-write.spec.js`; what is added here is that the
        // surface reaches it — `startEdit` carries the record id, and the save
        // takes the overwrite branch rather than creating a second entry.
        await bootWithStore(page);
        await openCompose(page);
        await page.locator('#diaryEventDate').fill(MORNING);
        await page.locator('#diaryBody').fill(ENTRY);
        await page.locator('#diarySaveBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        await page.locator('#diaryList .diary-entry-edit').click();
        await expect(page.locator('#diaryForm')).toBeVisible();
        // The form opens with what is already written, so a correction is an
        // edit and not a re-typing.
        await expect(page.locator('#diaryBody')).toHaveValue(ENTRY);
        await expect(page.locator('#diaryEventDate')).toHaveValue(MORNING);

        await page.locator('#diaryBody').fill(CORRECTED);
        await page.locator('#diaryEventDate').fill('2026-01-31');
        await page.locator('#diarySaveBtn').click();

        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
        await expect(page.locator('#diaryList .diary-entry-body')).toHaveText(CORRECTED);
        await expect(page.locator('#diaryList .diary-entry-date')).toHaveText('2026-01-31');

        const written = statements(await transcript(page));
        expect(
            written.filter((s) => s.statement === STATEMENTS.RECORD_UPDATE_SQL),
            'the edit did not overwrite the row'
        ).toHaveLength(1);
        expect(
            written.filter((s) => s.statement === STATEMENTS.RECORD_INSERT_SQL),
            'an overwrite is not an append — a second INSERT would give the family a diary'
                + ' that cannot be corrected'
        ).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SURFACE SAYS WHEN THE STORE REFUSES — BOTH DIRECTIONS (L3-P2).
//
// `DIA-DL-010` inventoried two defects here as debts 10 and 11, and called them
// one failure mode with two addresses. They are executed here because both need
// a store that RESOLVES: every leg in `diary-surface.spec.js` ends in a refusal
// before the try block, so neither defect was reachable from that file, and
// neither was reachable from the device suite either — `DiaryEntryTest` reaches
// a full disk, which fails the WRITE, and these two are about what happens when
// the READ fails while the write succeeded.
//
// Debt 10: `renderList` awaited the store with no try/catch. The window is
// already open and the list already cleared by then, so a refused read left the
// parent looking at an empty diary — a silent claim that they had never written
// anything — with no line anywhere, not even a signal.
//
// Debt 11: the confirmation refresh sat INSIDE `saveEntry`'s try, after the
// write had succeeded and after `diary.write outcome=complete` had gone out. A
// refusal there ran the catch, emitted a SECOND `diary.write` with
// `outcome=failed`, and showed «Запись НЕ сохранена» about an entry that was
// saved. Two contradictory signals for one save, and a lie to the parent.
//
// THE THIRD LEG IS NOT OPTIONAL. A false failure report can be "fixed" by
// making the surface quiet, which is the same defect facing the other way, so
// the direction that must NOT change is asserted beside the two that must.
// ─────────────────────────────────────────────────────────────────────────────

/** Collects every console line the page writes, in order. */
function watchConsole(page) {
    const lines = [];
    page.on('console', (msg) => lines.push(msg.text()));
    return lines;
}

/** Arms the seam's list read to refuse with the engine words a leg names. */
const refuseTheList = (page, message) =>
    page.evaluate((words) => {
        window.__pageBridgeList.failWith = words;
    }, message);

/** Arms the seam's record INSERT to refuse. */
const refuseTheWrite = (page, message) =>
    page.evaluate((words) => {
        window.__pageBridgeWrite.failWith = words;
    }, message);

const signalsOf = (lines, kind) => lines.filter((line) => line.startsWith(`[signal] ${kind} `));

test.describe('a store that refuses the LIST is stated, not shown as an empty diary', () => {
    test.use({ allowConsoleErrors: true });

    test('the refusal names the cause, and no entry count is implied', async ({ page }) => {
        const lines = watchConsole(page);
        await bootWithStore(page);
        await refuseTheList(page, 'database or disk is full (code 13)');

        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryModal')).toBeVisible();

        const status = page.locator('#diaryListStatus');
        await expect(
            status,
            'a refused list render said nothing at all — the parent is looking at an empty'
                + ' diary that is not empty (DIA-DL-010 debt 10)'
        ).toBeVisible();
        await expect(status).toContainText('Список не прочитан');
        await expect(
            status,
            'a full disk was reported as something a restart fixes'
        ).toContainText('закончилось место');

        // The two sentences that would be FALSE here stay hidden: one asserts
        // the diary is empty, the other offers a search over a list we could
        // not read.
        await expect(page.locator('#diaryEmpty')).toBeHidden();
        await expect(page.locator('#diarySearchForm')).toBeHidden();

        const emitted = signalsOf(lines, 'diary.list');
        expect(emitted, 'the refused render emitted no signal').toHaveLength(1);
        expect(emitted[0]).toContain('outcome=failed');
        expect(emitted[0]).toContain('failure_class=disk_full');
        expect(
            emitted[0],
            'the signal named a record count for a list that never loaded'
        ).not.toContain('records=');
    });

    test('THE ARM — a list that loads says so, and says nothing else', async ({ page }) => {
        // Without this the leg above could go green on a surface that shows the
        // refusal line always, or on a seam that refuses every read.
        const lines = watchConsole(page);
        await bootWithStore(page);

        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryEmpty')).toBeVisible();
        await expect(page.locator('#diaryListStatus')).toBeHidden();

        const emitted = signalsOf(lines, 'diary.list');
        expect(emitted, 'a successful render emitted no signal').toHaveLength(1);
        expect(emitted[0]).toContain('outcome=complete');
        expect(emitted[0]).toContain('records=0');
    });
});

test.describe('a save the store ACCEPTED is never reported to the parent as a failure', () => {
    test.use({ allowConsoleErrors: true });

    test('the refusal that follows a good write is about the list, not the entry', async ({
        page,
    }) => {
        const lines = watchConsole(page);
        await bootWithStore(page);
        await openCompose(page);
        await page.locator('#diaryEventDate').fill('2026-03-15');
        await page.locator('#diaryBody').fill('Сама застегнула куртку');

        // The write will succeed; the confirmation refresh that follows it will
        // not. This is the exact sequence debt 11 describes.
        await refuseTheList(page, 'no such table: record');
        await page.locator('#diarySaveBtn').click();

        // THE ROW WAS WRITTEN. Asked of the transcript rather than of the
        // screen, because the screen is what was lying.
        const written = statements(await transcript(page));
        expect(
            written.filter((s) => s.statement === STATEMENTS.RECORD_INSERT_SQL),
            'the entry never reached the store, so this leg is about the wrong thing'
        ).toHaveLength(1);

        await expect(
            page.locator('#diaryStatus'),
            'the app told the parent their entry was NOT saved, about an entry it had just'
                + ' saved (DIA-DL-010 debt 11)'
        ).not.toContainText('НЕ сохранена');

        const writes = signalsOf(lines, 'diary.write');
        expect(
            writes,
            'one save put two contradictory diary.write lines on the wire: ' + writes.join(' | ')
        ).toHaveLength(1);
        expect(writes[0]).toContain('outcome=complete');

        // And the truth about the list is still told, on the line that owns it.
        await expect(page.locator('#diaryListStatus')).toBeVisible();
    });

    test('THE ARM — a write the store REFUSED still says the entry was not saved', async ({
        page,
    }) => {
        const lines = watchConsole(page);
        await bootWithStore(page);
        await openCompose(page);
        await page.locator('#diaryEventDate').fill('2026-03-15');
        await page.locator('#diaryBody').fill('Сама застегнула куртку');

        await refuseTheWrite(page, 'database or disk is full (code 13)');
        await page.locator('#diarySaveBtn').click();

        const status = page.locator('#diaryStatus');
        await expect(
            status,
            'the false-failure fix was bought by making a real failure silent'
        ).toContainText('Запись НЕ сохранена');
        await expect(status).toContainText('закончилось место');

        // The parent's text is still in the field — the property DIA-P3 shipped
        // and this repair must not cost.
        await expect(page.locator('#diaryBody')).toHaveValue('Сама застегнула куртку');
        await expect(page.locator('#diaryForm')).toBeVisible();

        const writes = signalsOf(lines, 'diary.write');
        expect(writes, 'a refused write emitted no signal').toHaveLength(1);
        expect(writes[0]).toContain('outcome=failed');
        expect(writes[0]).toContain('failure_class=disk_full');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A PARENT MEETS THE MOMENT THEY HAVE A CHILD TO WRITE ABOUT (UIP-P4).
//
// THE SYMPTOM THE OWNER FOUND ON A DEVICE. Creating a profile left him on the
// skills table, and the only way to write anything was to find «Дневник» in the
// header, meet an empty list, and press «Новая запись» there — three actions,
// none of them offered, for the thing he had just asked for by creating a child.
// The flow now continues into the entry form itself.
//
// WHY THESE LEGS ARE HERE AND NOT IN `diary-surface.spec.js`. Every leg in that
// file reaches the surface with NO store behind it, so it ends in a refusal
// before the store is called — and the whole subject here is what happens after
// a profile is really written. This file already has a seam at the bridge
// boundary that RESOLVES, which is what makes «the entry landed on the child
// that was just created» assertable at all.
//
// WHAT THEY DO NOT CLAIM, said plainly. No SQLite: the seam executes no SQL,
// models no `v_child_attribute_current` and enforces no foreign key, so «a child
// created here comes back out of a real journal» is `DiaryEntryTest` on a
// device, exactly as `FIU-P2-INV-001`'s Scope already says. And nothing here is
// about the web channel — that the flow does NOT fire where the diary cannot be
// written is `behavior.spec.js::creating a profile from the form leaves the app
// with a usable one`, on a channel with no store at all.
// ─────────────────────────────────────────────────────────────────────────────

/** The id the app minted for the child it just wrote, read off the transcript. */
function createdChildIds(calls) {
    return statements(calls)
        .filter((item) => item.statement === STATEMENTS.childInsert)
        .map((item) => item.values[0]);
}

/** Fills the create-profile window that is already on screen, and submits it. */
async function createProfile(page, { name, birthdate }) {
    await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'block');
    await page.locator('#childName').fill(name);
    await page.locator('#childBirthdate').fill(birthdate);
    await page.locator('#createProfileForm button[type="submit"]').click();
}

const recordsWritten = (calls) =>
    statements(calls).filter((item) => item.statement === STATEMENTS.RECORD_INSERT_SQL);

test.describe('a profile just created opens the diary on its first entry', () => {
    test('the form is on screen, ready to type, and it is the only window', async ({ page }) => {
        await bootWithEmptyStore(page);
        // THE PREMISE, not a step this leg performs: with nobody in the store the
        // app opens the create window itself (FIU-P2-INV-001). If that stopped
        // happening, this leg reds here rather than somewhere confusing later.
        await createProfile(page, NEW_CHILD);

        await expect(
            page.locator('#diaryForm'),
            'the parent was left on the table with nowhere to write — the packet\'s whole subject'
        ).toBeVisible();
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'block');
        await expect(page.locator('#diaryListPane')).toBeHidden();
        // «Ready to type into» is a claim about the caret, not about the layout.
        await expect(page.locator('#diaryBody')).toBeFocused();
        await expect(page.locator('#diaryEventDate')).toHaveValue(TODAY);

        // EXACTLY ONE WINDOW (owner item 4). The create window is closed, and
        // nothing else has stacked behind or above the field — the intro window
        // included, which no longer opens by itself since UIP-P3.
        await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'none');
        await expect(
            page.locator('.modal.show'),
            'more than one window is on screen at the moment the parent starts typing'
        ).toHaveCount(1);

        // Two controls, and the second one says what it does here.
        await expect(page.locator('#diarySaveBtn')).toBeVisible();
        await expect(page.locator('#diaryCancelBtn')).toHaveText('Закрыть');
    });

    test('«Сохранить» writes one entry, through the same path, about the new child', async ({
        page,
    }) => {
        await bootWithEmptyStore(page);
        await createProfile(page, NEW_CHILD);
        await expect(page.locator('#diaryForm')).toBeVisible();

        await page.locator('#diaryBody').fill(FIRST_ENTRY);
        await page.locator('#diarySaveBtn').click();

        // The confirmation is the list, exactly as it is from the ordinary door:
        // this packet introduced no second save and no second confirmation.
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
        await expect(page.locator('#diaryList .diary-entry-body')).toHaveText(FIRST_ENTRY);
        await expect(page.locator('#diaryList .diary-entry-date')).toHaveText(TODAY);
        await expect(page.locator('#diaryForm')).toBeHidden();
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'block');

        const calls = await transcript(page);
        const written = recordsWritten(calls);
        expect(written, 'the entry never reached the store').toHaveLength(1);
        expect(written[0].values).toContain(FIRST_ENTRY);
        expect(written[0].values).toContain(TODAY);
        expect(written[0].values, 'attributed to the id the store minted').toContain(SELF);

        // AND IT WENT INTO THE NEW CHILD'S DIARY. Asked of the area lookup,
        // because that is where the subject is bound — the record row carries no
        // child column at all.
        const [childId] = createdChildIds(calls);
        expect(childId, 'no child was written, so this leg is about the wrong thing').toBeTruthy();
        const lookup = calls.find(
            (call) =>
                call.method === 'query' && call.options.statement === STATEMENTS.AREA_LOOKUP_SQL
        );
        expect(lookup.options.values.slice(0, 2)).toEqual([SELF, childId]);
    });

    test('«Закрыть» leaves a created profile, writes nothing, and is not a dead end', async ({
        page,
    }) => {
        await bootWithEmptyStore(page);
        await createProfile(page, NEW_CHILD);
        await expect(page.locator('#diaryForm')).toBeVisible();

        await page.locator('#diaryCancelBtn').click();

        // What the parent is left with reads as success, not as a creation that
        // failed: the window is gone, nothing else took its place, and the child
        // is in the header where the app names whose table this is.
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'none');
        await expect(page.locator('.modal.show')).toHaveCount(0);
        await expect(page.locator('#profileName')).toContainText(NEW_CHILD.name);
        expect(
            recordsWritten(await transcript(page)),
            'closing the first-entry form wrote an entry the parent never saved'
        ).toHaveLength(0);

        // NOT A DEAD END: the ordinary door is where it always was, and behind it
        // the diary is empty and says so.
        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryEmpty')).toBeVisible();
        await expect(page.locator('#diaryNewBtn')).toBeVisible();

        // AND THE MODE DID NOT SURVIVE THE CLOSE. Opened from the list, the same
        // control is «Отмена» again and returns to the list instead of closing
        // the window — otherwise a parent editing an entry later would lose the
        // window on a button that says it only cancels an edit.
        await page.locator('#diaryNewBtn').click();
        await expect(page.locator('#diaryCancelBtn')).toHaveText('Отмена');
        await page.locator('#diaryCancelBtn').click();
        await expect(page.locator('#diaryModal')).toHaveCSS('display', 'block');
        await expect(page.locator('#diaryListPane')).toBeVisible();
    });

    test('the SECOND child gets the same offer, and the entry lands on the second child', async ({
        page,
    }) => {
        // The household with two children, which a real family reaches within a
        // day. WHAT THIS PROVES: the offer is not a first-run special case, and
        // an entry written from it lands in the NEW child's diary — asked of the
        // area lookup, because that is where the subject is bound.
        //
        // WHAT IT DOES NOT PROVE, and this is measured rather than assumed: it
        // does not catch the offer being made BEFORE `switchProfile()` resolves.
        // That mutation was run and this leg stayed green, because `saveEntry`
        // computes the subject at SAVE time (`author()`) — late binding, which
        // is stronger than any ordering here — so a form opened a moment early
        // still writes to whoever is current when «Сохранить» is pressed. What
        // that mutation DOES red is the fresh-install case, four legs of this
        // block, where there is no current child yet and the offer is withheld
        // outright by `whyNotWritable()`.
        await bootWithStore(page);
        await page.locator('#profileButton').click();
        await page.locator('#profileDropdown .create-new').click();
        await createProfile(page, SIBLING);

        await expect(page.locator('#diaryForm')).toBeVisible();
        await expect(page.locator('.modal.show')).toHaveCount(1);
        await expect(page.locator('#profileName')).toContainText(SIBLING.name);

        await page.locator('#diaryBody').fill(FIRST_ENTRY);
        await page.locator('#diarySaveBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        const calls = await transcript(page);
        const [siblingId] = createdChildIds(calls);
        expect(siblingId).toBeTruthy();
        expect(siblingId, 'the seeded child was reused instead of the new one').not.toBe(CHILD.id);

        const lookups = calls.filter(
            (call) =>
                call.method === 'query' && call.options.statement === STATEMENTS.AREA_LOOKUP_SQL
        );
        const asked = lookups[lookups.length - 1].options.values.slice(0, 2);
        expect(asked, 'the first entry about the new child was written into another diary').toEqual(
            [SELF, siblingId]
        );
        expect(recordsWritten(calls)).toHaveLength(1);
        expect(
            statements(calls).filter((item) => item.statement === STATEMENTS.AREA_INSERT_SQL),
            'the new child got no diary of their own'
        ).toHaveLength(1);
    });

    test('THE ARM — an empty save from this door writes nothing and says why', async ({ page }) => {
        // The offer arrives without being asked for, so the field it opens on is
        // empty by construction and «Сохранить» is one press away. Nothing is
        // disabled and nothing is silently swallowed: the refusal this surface
        // already had names what is missing and keeps the form open.
        await bootWithEmptyStore(page);
        await createProfile(page, NEW_CHILD);
        await expect(page.locator('#diaryForm')).toBeVisible();

        await page.locator('#diarySaveBtn').click();

        await expect(page.locator('#diaryStatus')).toBeVisible();
        await expect(page.locator('#diaryStatus')).toContainText('в ней пока нет текста');
        await expect(page.locator('#diaryForm')).toBeVisible();
        expect(
            recordsWritten(await transcript(page)),
            'an empty entry was written into the family journal'
        ).toHaveLength(0);
    });
});
