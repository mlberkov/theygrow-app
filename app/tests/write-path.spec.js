'use strict';

// The write path: a mark is an attributed assertion (L1-P4).
//
// PDR-025 §2 — ticking a skill is not the fact "mastered", it is "parent X
// asserts: mastered". So what is asserted here is the SHAPE of the act: what the
// app appends, that it appends it atomically, that it never overwrites, and that
// consensus of one falls out of the same act rather than out of a branch.
//
// The SQL's MEANING is not tested here — that is app/tests/schema/
// test_write_path_projection.py, against real SQLite carrying the frozen DDL.
// See app/tests/support/fake-bridge.js for why the two are kept apart.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { createFakeBridge, withFakeBridge } = require('./support/fake-bridge');

const STORE_DIR = path.resolve(__dirname, '..', 'm', 'v1', 'store');
const CORE_DIR = path.resolve(__dirname, '..', 'm', 'v1', 'core');

// Same two pieces of Node plumbing store-unit.spec.js documents: a real dynamic
// import that Playwright's CommonJS transform will not rewrite, and a temp
// directory carrying the ESM marker that app/m/ cannot carry because everything
// under it ships.
const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let generation = 0;

const AUTHOR = 'p-self-0001';
const CHILD = 'c-0001';
const NOW = 1_770_000_000_000;
const TODAY = '2026-02-01';

test.beforeAll(() => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-write-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    for (const [dir, sub] of [[STORE_DIR, 'store'], [CORE_DIR, 'core']]) {
        fs.mkdirSync(path.join(loadRoot, sub), { recursive: true });
        for (const name of fs.readdirSync(dir)) {
            const from = path.join(dir, name);
            if (!fs.statSync(from).isFile()) continue;
            const to = path.join(loadRoot, sub, name);
            fs.copyFileSync(from, to);
            expect(
                fs.readFileSync(to).equals(fs.readFileSync(from)),
                `${sub}/${name} was not copied verbatim — this spec would test a different file`
            ).toBeTruthy();
        }
    }
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

// A fresh module instance per test: these modules are stateless by design, and
// the cache-buster is what keeps that a property rather than a hope.
const load = (rel) => {
    generation += 1;
    return dynamicImport(`${pathToFileURL(path.join(loadRoot, rel)).href}?g=${generation}`);
};

const sqlOf = (statements) => statements.map((s) => s.statement).join('\n');

test.describe('a tick appends an attributed assertion and its confirmation', () => {
    test('both entries go in ONE transaction, so a half-written mark cannot exist', async () => {
        const fake = createFakeBridge();
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            await appendMark({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                skillId: 'GM_005',
                observed: true,
                now: NOW,
                today: TODAY,
            });
        });

        const transactions = fake.transactions();
        expect(transactions, 'one act, one transaction').toHaveLength(1);
        expect(transactions[0].transaction).toBe(true);
        expect(
            transactions[0].statements,
            'two spine rows and two detail rows: assertion + confirmation'
        ).toHaveLength(4);
    });

    test('the assertion carries its author, its subject and its skill', async () => {
        const fake = createFakeBridge();
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            await appendMark({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                skillId: 'GM_005',
                observed: true,
                now: NOW,
                today: TODAY,
            });
        });

        const statements = fake.statements();
        const spine = statements.find((s) => s.statement.includes('INSERT INTO journal_entry'));
        expect(spine.values).toContain(AUTHOR);
        expect(spine.values).toContain(CHILD);
        expect(spine.values).toContain('authored');
        expect(spine.values).toContain(TODAY);

        const detail = statements.find((s) => s.statement.includes('INSERT INTO assertion'));
        expect(detail.values).toContain('skill_observed');
        expect(detail.values).toContain('GM_005');
        expect(detail.values).toContain('none');
    });

    test('the confirmation is by the same author and targets that assertion', async () => {
        const fake = createFakeBridge();
        let result = null;
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            result = await appendMark({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                skillId: 'GM_005',
                observed: true,
                now: NOW,
                today: TODAY,
            });
        });

        const statements = fake.statements();
        const confirmation = statements.find((s) => s.statement.includes('INSERT INTO confirmation'));
        expect(confirmation.values).toContain(result.assertionId);
        expect(confirmation.values).toContain('confirmed');

        const spines = statements.filter((s) => s.statement.includes('INSERT INTO journal_entry'));
        expect(spines).toHaveLength(2);
        for (const spine of spines) {
            expect(spine.values, 'both halves of the act are by the same parent').toContain(AUTHOR);
        }
    });

    test('confirmed-by-one is produced by the act, not by a branch on participant count', async () => {
        // The reason this is a source-level assertion: the degenerate case is
        // correct here precisely because nothing special-cases it (PDR-021), and
        // a runtime test cannot show the absence of a branch it never reaches.
        const source = fs.readFileSync(path.join(STORE_DIR, 'repo-journal.js'), 'utf8');
        expect(source).not.toMatch(/participants?\s*\.\s*length/);
        expect(source).not.toMatch(/===\s*1\b.*participant/i);
        expect(
            source,
            'the confirmation is unconditional: an authored mark and a migrated one are one shape'
        ).toMatch(/status:\s*'confirmed'|'confirmed'/);
    });
});

test.describe('un-ticking is a new assertion, never an erasure', () => {
    test('a revocation appends skill_revoked with its own confirmation', async () => {
        const fake = createFakeBridge();
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            await appendMark({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                skillId: 'GM_005',
                observed: false,
                now: NOW,
                today: TODAY,
            });
        });

        const statements = fake.statements();
        const detail = statements.find((s) => s.statement.includes('INSERT INTO assertion'));
        expect(detail.values).toContain('skill_revoked');
        expect(
            statements.filter((s) => s.statement.includes('INSERT INTO confirmation'))
        ).toHaveLength(1);
    });

    test('the write path issues no UPDATE and no DELETE against the journal', async () => {
        const fake = createFakeBridge();
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            for (const observed of [true, false, true]) {
                await appendMark({
                    authorParticipantId: AUTHOR,
                    subjectChildId: CHILD,
                    skillId: 'GM_005',
                    observed,
                    now: NOW,
                    today: TODAY,
                });
            }
        });

        const sql = sqlOf(fake.statements()).toUpperCase();
        expect(sql).not.toMatch(/\bDELETE\b/);
        expect(sql).not.toMatch(/UPDATE\s+JOURNAL_ENTRY/);
        expect(sql).not.toMatch(/UPDATE\s+ASSERTION/);
        expect(
            fake.transactions(),
            'three acts, three transactions — a correction is a new act'
        ).toHaveLength(3);
    });
});

test.describe('honest degradation on the write path (ADR-015)', () => {
    test('with no subject the mark is refused, and nothing is appended', async () => {
        const fake = createFakeBridge();
        let refusal = null;
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            refusal = await appendMark({
                authorParticipantId: AUTHOR,
                subjectChildId: null,
                skillId: 'GM_005',
                observed: true,
                now: NOW,
                today: TODAY,
            }).catch((error) => error);
        });

        expect(refusal).toBeInstanceOf(Error);
        expect(refusal.message).toMatch(/subject|LSC-P2-INV-005/i);
        expect(fake.mutationCount(), 'a refused mark writes nothing at all').toBe(0);
    });

    test('with no author the mark is refused too — a fact with no one behind it is not a fact', async () => {
        const fake = createFakeBridge();
        let refusal = null;
        await withFakeBridge(fake, async () => {
            const { appendMark } = await load('store/repo-journal.js');
            refusal = await appendMark({
                authorParticipantId: null,
                subjectChildId: CHILD,
                skillId: 'GM_005',
                observed: true,
                now: NOW,
                today: TODAY,
            }).catch((error) => error);
        });

        expect(refusal).toBeInstanceOf(Error);
        expect(fake.mutationCount()).toBe(0);
    });
});

test.describe('the projection is read, never stored', () => {
    test('the completed set is derived from the projected rows', async () => {
        const { completedFrom } = await load('store/repo-journal.js');
        const set = completedFrom([
            { skill_id: 'GM_001', state: 'skill_observed' },
            { skill_id: 'GM_002', state: 'skill_revoked' },
            { skill_id: 'GM_003', state: 'skill_observed' },
        ]);
        expect(set instanceof Set, 'the render path consumes a Set and keeps doing so').toBe(true);
        expect([...set].sort()).toEqual(['GM_001', 'GM_003']);
    });

    test('a revoked skill is absent rather than present-and-false', async () => {
        const { completedFrom } = await load('store/repo-journal.js');
        expect(completedFrom([{ skill_id: 'GM_002', state: 'skill_revoked' }]).size).toBe(0);
    });

    test('loading marks runs the shipped projection query and binds the child', async () => {
        const fake = createFakeBridge({
            answer: {
                v_child_skill_state: [
                    { skill_id: 'GM_001', state: 'skill_observed', confirmed_by: 1 },
                ],
            },
        });
        let rows = null;
        await withFakeBridge(fake, async () => {
            const { loadMarks } = await load('store/repo-journal.js');
            rows = await loadMarks({ childId: CHILD });
        });

        expect(rows).toHaveLength(1);
        const read = fake.calls.find((call) => call.method === 'query');
        expect(read.options.statement).toContain('v_child_skill_state');
        expect(read.options.statement).toContain('v_assertion_consensus');
        expect(read.options.values, 'scoped to one child').toEqual([CHILD]);
    });

    test('the projection carries the consensus columns the surface will need at L7', async () => {
        // P4 must EXPRESS the half-confirmed state even though no surface reads
        // it yet; L7 owns the behaviour. A projection that dropped the columns
        // would make that a rewrite instead of a wiring.
        const journal = fs.readFileSync(path.join(STORE_DIR, 'journal.js'), 'utf8');
        for (const column of ['confirmed_by', 'disputed_by', 'needs_refresh_by', 'origin']) {
            expect(journal, `the projection drops ${column}`).toContain(column);
        }
    });
});
