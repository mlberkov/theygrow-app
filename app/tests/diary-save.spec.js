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
