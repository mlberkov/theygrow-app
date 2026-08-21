'use strict';

// The diary's SEARCH path, executed in a browser (DIA-P4).
//
// WHAT THIS PROVES. That the shipped surface asks the shipped store for the
// right thing — the expression the shipped builder produced, with the author the
// store minted and the child the parent is looking at — renders what comes back
// into the same list, tells the three empty cases apart, repairs the derived
// index at most once, and never lets a refusal read as "you never wrote that".
//
// AND THE ONE IT EXISTS FOR MOST (DIA-P4-INV-002). What a parent types into the
// search box is the most family-identifying string this app has ever held. This
// file watches every console line the page emits — which is where the signal
// sink writes — and asserts the term reaches none of them, on the success path,
// on the empty path and on the refusal path. `signal-payload.spec.js` proves the
// payload CANNOT structurally carry a string; this proves the running surface
// does not put one anywhere else either.
//
// WHAT THIS PROVES NOTHING ABOUT. Matching. The seam behind it
// (`support/page-bridge.js`) has no FTS5, no tokenizer and no index: a leg
// STAGES which rows come back, and the seam records the expression it was given.
// Which rows an expression really matches is `pytest app/tests/schema`
// (`test_diary_search.py`) against the real frozen DDL; that a parent's search
// finds their entry on a real device, and what the repair COSTS them, is
// `DiaryEntryTest` and `StoreEngineTest` on `android-instrumented`.

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, STATES } = require('./support/seed');
const { installPageBridge, shippedStatements } = require('./support/page-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const STATEMENTS = shippedStatements(APP_ROOT, MOUNT.dir);

const SELF = 'p-page-bridge-self';
const CHILD = {
    id: 'child-page-bridge',
    name: 'Проба',
    birthdate: '2024-09-15',
    createdAtUtc: 1_700_000_000_000,
};

// Two entries so that "the search narrowed the list" is distinguishable from
// "the search returned the list". Both are ordinary sentences about a child,
// which is what makes the term-leak assertions below mean anything.
const FIRST = { day: '2026-02-01', text: 'Впервые сам сел и держался почти минуту' };
const SECOND = { day: '2026-02-02', text: 'Ёлка в комнате, разглядывал игрушки' };

// The word a parent searches for. Held here so every assertion about where it
// does and does not appear names the same string.
const TERM = 'ёлка';

async function bootWithStore(page) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child: CHILD,
        selfParticipantId: SELF,
    });
    await gotoApp(page, { state: STATES.empty });
}

/** Writes one entry through the surface, the way DIA-P3 ships it. */
async function write(page, entry) {
    await page.locator('#diaryNewBtn').click();
    await expect(page.locator('#diaryForm')).toBeVisible();
    await page.locator('#diaryEventDate').fill(entry.day);
    await page.locator('#diaryBody').fill(entry.text);
    await page.locator('#diarySaveBtn').click();
    await expect(page.locator('#diaryForm')).toBeHidden();
}

/** Opens the diary and writes both entries. */
async function withTwoEntries(page) {
    await bootWithStore(page);
    await page.locator('#diaryBtn').click();
    await expect(page.locator('#diaryNewBtn')).toBeVisible();
    await write(page, FIRST);
    await write(page, SECOND);
    await expect(page.locator('#diaryList .diary-entry')).toHaveCount(2);
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('#diaryList .diary-entry'), (item) => item.dataset.recordId)
    );
}

/** Stages what the next search comes back with, and searches. */
async function search(page, typed, staged) {
    await page.evaluate((next) => Object.assign(window.__pageBridgeSearch, next), staged);
    await page.locator('#diarySearchInput').fill(typed);
    await page.locator('#diarySearchBtn').click();
}

const transcript = (page) => page.evaluate(() => window.__pageBridgeCalls);

/** Every search the surface issued, as the bound values the store received. */
function searches(calls) {
    return calls
        .filter((c) => c.method === 'query' && c.options.statement === STATEMENTS.RECORD_SEARCH_SQL)
        .map((c) => c.options.values);
}

/** Every rebuild the surface caused. */
function rebuilds(calls) {
    return calls.filter(
        (c) => c.method === 'run' && c.options.statement === STATEMENTS.FTS_REBUILD_SQL
    );
}

/** Collects every console line the page writes, in order. */
function watchConsole(page) {
    const lines = [];
    page.on('console', (msg) => lines.push(msg.text()));
    return lines;
}

test.describe('the search narrows the same list, in the same window', () => {
    test('searching is offered only once there is something to search', async ({ page }) => {
        // An empty diary offering a search could only ever answer "nothing
        // found" — a sentence that reads as a fault when the truth is that
        // nothing has been written yet.
        await bootWithStore(page);
        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryEmpty')).toBeVisible();
        await expect(page.locator('#diarySearchForm')).toBeHidden();

        await write(page, FIRST);
        await expect(page.locator('#diarySearchForm')).toBeVisible();
        await expect(page.locator('#diaryEmpty')).toBeHidden();
    });

    test('the store is asked with the shipped expression, this author and this child', async ({
        page,
    }) => {
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        // The comparand is the SHIPPED builder, imported in the page and called
        // with the same string — never a rule re-typed in this file, which is
        // the copy that drifts.
        const expected = await page.evaluate(async ({ base, typed }) => {
            const at = new URL('store/records.js', new URL(base, window.location.origin));
            const mod = await import(at.href);
            return mod.buildDiaryMatch(typed);
        }, { base: MOUNT.prefix, typed: TERM });

        const asked = searches(await transcript(page));
        expect(asked, 'the surface never searched').toHaveLength(1);
        const [expression, owner, child, visibility, kind] = asked[0];
        expect(expression, 'the surface built its own expression').toBe(expected);
        expect(owner, 'the search is scoped to the id the store minted').toBe(SELF);
        expect(child, 'and to the child on screen').toBe(CHILD.id);
        expect(visibility).toBe('participant_private');
        expect(kind).toBe('text');

        // Sanity on the expression itself, so a builder that returned '' could
        // not make every leg here vacuously green.
        expect(expression).toContain('*');
    });

    test('clearing the search brings the whole diary back', async ({ page }) => {
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
        await expect(page.locator('#diarySearchClearBtn')).toBeVisible();

        await page.locator('#diarySearchClearBtn').click();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(2);
        await expect(page.locator('#diarySearchInput')).toHaveValue('');
        await expect(page.locator('#diarySearchClearBtn')).toBeHidden();
    });

    test('the search control is disabled while the search runs, and enabled after', async ({
        page,
    }) => {
        // NOT COSMETIC, AND NOT ONLY ABOUT DOUBLE-PRESSES. `DiaryEntryTest`'s
        // device leg keys its wait on exactly this: the list already holds the
        // parent's entries before a search, so a predicate over the LIST settles
        // before the search has run — the failure mode DIA-DL-006 repaired in
        // the mark leg. The control being enabled again is the surface saying it
        // has decided, so that assumption gets an executor here rather than
        // living unstated inside a Java string.
        const ids = await withTwoEntries(page);
        await page.evaluate((next) => Object.assign(window.__pageBridgeSearch, next), {
            answer: [ids[0]],
        });

        // Read in the SAME synchronous turn as the press: the handler disables
        // the control before its first await, so this is deterministic.
        const during = await page.evaluate(() => {
            document.getElementById('diarySearchInput').value = 'сел';
            document.getElementById('diarySearchBtn').click();
            return document.getElementById('diarySearchBtn').disabled;
        });
        expect(during, 'the control stayed enabled while the search ran').toBe(true);
        await expect(page.locator('#diarySearchBtn')).toBeEnabled();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
    });

    test('an empty box is a request for the whole diary, not a search', async ({ page }) => {
        await withTwoEntries(page);
        await search(page, '   ', { answer: [] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(2);
        expect(searches(await transcript(page)), 'an empty query reached the store').toHaveLength(0);
        await expect(page.locator('#diarySearchEmpty')).toBeHidden();
    });

    test('saving an entry leaves the parent looking at a list that contains it', async ({
        page,
    }) => {
        // The list IS the confirmation (DIA-DL-005 (g)). With a filter still on,
        // a newly saved entry could fall outside it — and the parent would be
        // shown a list without their entry at the exact moment the list is the
        // proof it was saved.
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        await write(page, { day: '2026-02-03', text: 'Ещё одна запись' });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(3);
        await expect(page.locator('#diarySearchInput')).toHaveValue('');
    });
});

test.describe('the three empty cases are three different sentences', () => {
    test('nothing matched says so, and does not say the diary is empty', async ({ page }) => {
        await withTwoEntries(page);
        await search(page, 'слово', { answer: [] });

        await expect(page.locator('#diarySearchEmpty')).toBeVisible();
        await expect(page.locator('#diaryEmpty'), 'a diary with entries was called empty').toBeHidden();
        await expect(page.locator('#diarySearchStatus')).toBeHidden();
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(0);

        // The sentence has to carry the honest-degradation content (ADR-015),
        // not merely exist: what the search cannot do, and what to try instead.
        const said = await page.locator('#diarySearchEmpty').textContent();
        expect(said).toContain('началу слова');
        expect(said).toContain('словоформ');
        expect(said).toContain('покороче');
    });

    test('an empty diary says the source condition and offers no search', async ({ page }) => {
        await bootWithStore(page);
        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryEmpty')).toBeVisible();
        await expect(page.locator('#diarySearchEmpty')).toBeHidden();
        await expect(page.locator('#diarySearchStatus')).toBeHidden();
    });
});

test.describe('a search that did not run never reads as a diary that is empty', () => {
    // The surface logs the failure class by design, which is what this opt-out
    // is for — the same posture `diary-surface.spec.js` takes about refusals.
    test.use({ allowConsoleErrors: true });

    test('the refusal says the search failed and that the entries are still there', async ({
        page,
    }) => {
        await withTwoEntries(page);
        await search(page, TERM, { failWith: 'no such table: record_fts' });

        await expect(page.locator('#diarySearchStatus')).toBeVisible();
        await expect(
            page.locator('#diarySearchEmpty'),
            'a store failure was dressed up as "nothing matched" — which tells a parent'
                + ' they never wrote something they did write'
        ).toBeHidden();

        const said = await page.locator('#diarySearchStatus').textContent();
        expect(said).toContain('Поиск не выполнен');
        expect(said).toContain('на месте');
    });

    test('the console line names the class and never the engine message', async ({ page }) => {
        const lines = watchConsole(page);
        await withTwoEntries(page);
        await search(page, TERM, { failWith: 'no such table: record_fts' });
        await expect(page.locator('#diarySearchStatus')).toBeVisible();

        const failure = lines.filter((line) => line.includes('the search did not run'));
        expect(failure, 'the failure was not reported at all').toHaveLength(1);
        expect(failure[0]).toContain('StoreError');
        // The write path prints the engine message; this one must not, because
        // the value an engine echoes here is built from what the parent typed.
        expect(failure[0], 'the engine message reached the console').not.toContain('record_fts');
    });
});

test.describe('the derived index repairs itself, at most once', () => {
    test('a search that found nothing over a diary with entries rebuilds and answers', async ({
        page,
    }) => {
        const ids = await withTwoEntries(page);
        // Nothing matches; after the rebuild, the entry is found. That pair is
        // the whole observable of a stale index (PDR-026 §4 rule 3).
        await search(page, TERM, { answer: [], answerAfterRebuild: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
        await expect(page.locator('#diarySearchEmpty')).toBeHidden();

        const calls = await transcript(page);
        expect(rebuilds(calls), 'the index was never repaired').toHaveLength(1);
        expect(rebuilds(calls)[0].options.values, 'the rebuild verb is a bound value').toEqual([
            'rebuild',
        ]);
        expect(searches(calls), 'the query was not re-run after the repair').toHaveLength(2);
    });

    test('a second empty search does not rebuild again', async ({ page }) => {
        // An ordinary word-form miss is the COMMON reason a search comes back
        // empty. Rebuilding on each one would make every miss slow for the rest
        // of the session, which is what the once-per-session flag is for.
        await withTwoEntries(page);
        await search(page, TERM, { answer: [], answerAfterRebuild: null });
        await expect(page.locator('#diarySearchEmpty')).toBeVisible();
        expect(rebuilds(await transcript(page))).toHaveLength(1);

        await search(page, 'другое', { answer: [] });
        await expect(page.locator('#diarySearchEmpty')).toBeVisible();
        expect(
            rebuilds(await transcript(page)),
            'every empty search rebuilt the index'
        ).toHaveLength(1);
    });

    test('the repair is not announced to the parent, and is readable in the signal', async ({
        page,
    }) => {
        // A parent cannot tell a stale index from a word-form miss, and there is
        // nothing for them to do about either — so they are told nothing. The
        // owner reads it in the signal during the RUNBOOK smoke instead.
        const lines = watchConsole(page);
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [], answerAfterRebuild: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        const rendered = await page.locator('#diaryListPane').textContent();
        expect(rendered).not.toContain('индекс');
        expect(rendered).not.toContain('перестро');

        const emitted = lines.filter((line) => line.startsWith('[signal] diary.search'));
        expect(emitted, 'the search emitted no signal').toHaveLength(1);
        expect(emitted[0]).toContain('rebuilt=true');
    });
});

/**
 * Asserts that one search left the term on no console line at all.
 *
 * Anti-vacuity is inside, not beside: the `diary.search` signal must have fired,
 * or "no line contains the term" would be trivially true of a page that emitted
 * nothing.
 */
async function expectNoTermOnAnyLine(page, lines) {
    const emitted = lines.filter((line) => line.startsWith('[signal] diary.search'));
    expect(emitted, 'no diary.search signal was emitted at all').toHaveLength(1);

    for (const line of lines) {
        expect(line.toLowerCase(), `a console line carries the term: ${line}`).not.toContain(TERM);
        // And the entries themselves never reach a line either — the search
        // renders them, and rendering is not reporting.
        expect(line).not.toContain(FIRST.text);
        expect(line).not.toContain(SECOND.text);
    }
}

test.describe('DIA-P4-INV-002 — the term a parent types stays in two places', () => {
    test('a search that found something puts no term on any console line', async ({ page }) => {
        const lines = watchConsole(page);
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);
        await expectNoTermOnAnyLine(page, lines);
    });

    test('a search that found nothing puts no term on any console line', async ({ page }) => {
        const lines = watchConsole(page);
        await withTwoEntries(page);
        await search(page, TERM, { answer: [] });
        await expect(page.locator('#diarySearchEmpty')).toBeVisible();
        await expectNoTermOnAnyLine(page, lines);
    });

    test('the emitted signal carries counts, a timing, a boolean and nothing else', async ({
        page,
    }) => {
        const lines = watchConsole(page);
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        const [emitted] = lines.filter((line) => line.startsWith('[signal] diary.search'));
        expect(emitted).toBeTruthy();
        const fields = emitted
            .replace('[signal] diary.search ', '')
            .split(' ')
            .map((pair) => pair.split('=')[0]);
        expect(fields.sort()).toEqual(
            ['failure_class', 'outcome', 'rebuilt', 'results', 'search_ms', 'tokens'].sort()
        );
        expect(emitted).toContain('results=1');
        expect(emitted).toContain('tokens=1');
        expect(emitted).toContain('outcome=complete');
    });

    test('the term reaches the store only as a bound value', async ({ page }) => {
        // The expression is DERIVED from the term and is itself family-derived,
        // so where it may travel matters: into the statement's values, and
        // nowhere else. This asserts the statement text carries no term — it is
        // parameterised — which is what keeps an engine error message from
        // echoing one back.
        const ids = await withTwoEntries(page);
        await search(page, TERM, { answer: [ids[0]] });
        await expect(page.locator('#diaryList .diary-entry')).toHaveCount(1);

        for (const call of await transcript(page)) {
            const statement = call.options?.statement;
            if (typeof statement === 'string') {
                expect(statement.toLowerCase(), 'a term was interpolated into SQL').not.toContain(
                    TERM
                );
            }
        }
    });
});

test.describe('DIA-P4-INV-002 — and a refusal is where a term would most easily leak', () => {
    // The refusal path is the one that HAS an engine message to print, so it is
    // the one worth a leg of its own. The opt-out is for the class line the
    // surface logs by design.
    test.use({ allowConsoleErrors: true });

    test('a search the store refused puts no term on any console line', async ({ page }) => {
        const lines = watchConsole(page);
        await withTwoEntries(page);
        await search(page, TERM, { failWith: 'no such table: record_fts' });
        await expect(page.locator('#diarySearchStatus')).toBeVisible();
        await expectNoTermOnAnyLine(page, lines);
    });
});
