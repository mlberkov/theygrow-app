'use strict';

// What the diary write path ASKS FOR (DIA-P3).
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It starts no product: it imports
// the shipped store modules under Node and drives them against the recorder in
// app/tests/support/fake-bridge.js, which is deliberately not a database and
// executes no SQL. So what is asserted here is CONTROL FLOW and STATEMENT SHAPE
// — that the area and the first record go in one transaction, that a second
// entry does not create a second diary, that an edit issues an UPDATE and never
// a second INSERT, that a rejected write is classified rather than retried.
//
// The three claims this file must NOT be read as carrying:
//   what the SQL MEANS               app/tests/schema/test_diary_write_path.py,
//                                    against the real frozen DDL
//   that a parent's entry lands      android-instrumented (DIA-P3 C4), on the
//   in the encrypted store           real plugin and the real SQLCipher
//   that the refusal reaches them    the surface specs (DIA-P3 C3) and the same
//                                    device leg
//
// A fake proves the fake; this one is honest about which third of the question
// it answers (store-unit.spec.js:3-18, and the split fake-bridge.js states).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { createFakeBridge, withFakeBridge } = require('./support/fake-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never a literal (EMV-DL-001): a copy-forward
// bump leaves the old generation on disk and shipped, so a pinned version would
// keep guarding bytes nothing runs.
const STORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'store');
const CORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'core');

// The same two pieces of Node plumbing store-unit.spec.js documents: a real
// dynamic module load that Playwright's CommonJS transform will not rewrite, and
// a temp directory carrying the ESM marker that app/m/ cannot carry because
// everything under it ships.
const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let generation = 0;

const AUTHOR = 'p-self-0001';
const CHILD = 'c-0001';
const OTHER_CHILD = 'c-0002';
const AREA = 'area-0001';
const NOW = 1_770_000_000_000;
const MORNING = '2026-02-01';
const ENTRY = 'Впервые сам встал у дивана';

// The area lookup's answer, scripted by the substring of the query that means
// it. An empty answer is "no diary yet", which is the first-write case.
const AREA_FOUND = { 'FROM area a JOIN area_child': [{ id: AREA }] };

test.beforeAll(() => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-diary-'));
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

const write = async (fake, overrides = {}) => {
    let recordId = null;
    await withFakeBridge(fake, async () => {
        const { createRecord } = await load('store/records.js');
        recordId = await createRecord({
            authorParticipantId: AUTHOR,
            subjectChildId: CHILD,
            body: ENTRY,
            eventDateLocal: MORNING,
            now: NOW,
            utcOffsetMin: 180,
            ...overrides,
        });
    });
    return recordId;
};

const mutations = (fake) => fake.transactions();

// The verb and the table a statement acts on, which is what "the shape of the
// act" means here. Read out of the statement rather than compared as a prefix of
// fixed width: a prefix assertion is off by one the moment a column is renamed,
// and it says nothing a reader of the failure could act on. Fails closed — a
// statement whose shape this cannot name throws rather than being skipped.
const shapeOf = (statement) => {
    const match = /^(INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/.exec(statement);
    if (!match) throw new Error(`this spec cannot name the shape of: ${statement}`);
    return `${match[1]} ${match[2]}`;
};
const only = (fake, needle) =>
    fake.statements().filter((s) => s.statement.includes(needle));

test.describe('a diary entry is written with the container it needs', () => {
    test('the first entry brings its area and its child link in ONE transaction', async () => {
        const fake = createFakeBridge();
        await write(fake);

        const transactions = mutations(fake);
        expect(transactions, 'one act, one transaction').toHaveLength(1);
        expect(transactions[0].transaction).toBe(true);
        expect(
            transactions[0].statements.map(shapeOf),
            'area, then its child link, then the record — a record cannot exist without its area'
        ).toEqual(['INSERT INTO area', 'INSERT INTO area_child', 'INSERT INTO record']);
    });

    test('the area it creates is private and owned by the author', async () => {
        const fake = createFakeBridge();
        await write(fake);

        const [area] = only(fake, 'INSERT INTO area (');
        expect(area.values, 'the class PDR-026 2026-08-11 requires of a record').toContain(
            'participant_private'
        );
        expect(area.values, 'a private area has exactly one owner').toContain(AUTHOR);
        expect(area.values, 'the declared title, not a display string').toContain('diary');

        const [link] = only(fake, 'INSERT INTO area_child');
        expect(link.values).toEqual([expect.any(String), CHILD]);
    });

    test('a second entry reuses the diary the lookup finds', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await write(fake);

        const transactions = mutations(fake);
        expect(transactions).toHaveLength(1);
        expect(
            transactions[0].statements.map(shapeOf),
            'no second diary for the same child'
        ).toEqual(['INSERT INTO record']);
        expect(only(fake, 'INSERT INTO record (')[0].values).toContain(AREA);
    });

    test('a second child gets a diary of its own', async () => {
        const fake = createFakeBridge();
        await write(fake, { subjectChildId: OTHER_CHILD });

        const [link] = only(fake, 'INSERT INTO area_child');
        expect(link.values[1], 'the lookup is keyed on the child, so this one misses').toBe(
            OTHER_CHILD
        );
        expect(only(fake, 'INSERT INTO area (')).toHaveLength(1);
    });

    test('the lookup asks about this author, this child and the private class', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await write(fake);

        const lookup = fake.calls.find((c) => c.method === 'query');
        expect(lookup, 'the write path never asked which diary it was writing into').toBeTruthy();
        expect(lookup.options.values).toEqual([AUTHOR, CHILD, 'participant_private']);
    });
});

test.describe('what the record row is asked to hold', () => {
    test('the entry carries its author, its text and the day it is about', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        const recordId = await write(fake);

        const [record] = only(fake, 'INSERT INTO record (');
        expect(record.values[0], 'the id the caller is handed is the id that was written').toBe(
            recordId
        );
        expect(record.values).toContain(AUTHOR);
        expect(record.values).toContain(ENTRY);
        expect(record.values).toContain(MORNING);
        expect(record.values).toContain('text');
    });

    test('the two times stay apart: the day is the parent\'s, the instant is now', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await write(fake);

        const [record] = only(fake, 'INSERT INTO record (');
        // Positional, because this is the statement's contract: id, area, author,
        // kind, body, event_date_local, entry_at_utc, entry_utc_offset_min,
        // updated_at_utc.
        expect(record.values).toEqual([
            expect.any(String),
            AREA,
            AUTHOR,
            'text',
            ENTRY,
            MORNING,
            NOW,
            180,
            NOW,
        ]);
    });

    test('the instant of the EVENT and the sensitivity are NULL in the statement itself', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await write(fake);

        const [record] = only(fake, 'INSERT INTO record (');
        // Not bound values that happen to be null — literal NULLs in the SQL, so
        // no caller can pass something else by accident. The event instant is
        // unknown because the surface collects a day; the sensitivity is
        // undeclared because the parent was never asked (PDR-026 §4 item 3).
        expect(record.statement).toContain('VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?)');
        expect(record.statement).not.toContain('not_sensitive');
    });

    test('an entry with no text is refused before it reaches the store', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        let failure = null;
        await withFakeBridge(fake, async () => {
            const { createRecord } = await load('store/records.js');
            failure = await createRecord({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                body: '   ',
                eventDateLocal: MORNING,
                now: NOW,
            }).catch((error) => error);
        });

        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toContain('no text');
        expect(fake.mutationCount(), 'nothing was written for an empty entry').toBe(0);
    });

    test('an entry with no subject is refused, and says which half is missing', async () => {
        const fake = createFakeBridge();
        let failure = null;
        await withFakeBridge(fake, async () => {
            const { createRecord } = await load('store/records.js');
            failure = await createRecord({
                authorParticipantId: AUTHOR,
                subjectChildId: null,
                body: ENTRY,
                now: NOW,
            }).catch((error) => error);
        });

        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toContain('LSC-P2-INV-005');
        expect(fake.mutationCount()).toBe(0);
    });
});

test.describe('an entry is edited by OVERWRITE, and nothing is appended', () => {
    test('the edit is an UPDATE of that row, and no second record appears', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await withFakeBridge(fake, async () => {
            const { overwriteRecord } = await load('store/records.js');
            await overwriteRecord({
                recordId: 'r-1',
                body: 'Не у дивана, а у стула',
                eventDateLocal: '2026-01-31',
                now: NOW + 600_000,
            });
        });

        const statements = fake.statements();
        expect(statements).toHaveLength(1);
        expect(statements[0].statement).toContain('UPDATE record SET');
        expect(only(fake, 'INSERT INTO record ('), 'an overwrite is not an append').toHaveLength(0);
        expect(
            only(fake, 'INSERT INTO journal_entry'),
            'editing a diary entry writes nothing to the append-only journal'
        ).toHaveLength(0);
    });

    test('the edit moves updated_at_utc and never entry_at_utc', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        await withFakeBridge(fake, async () => {
            const { overwriteRecord } = await load('store/records.js');
            await overwriteRecord({
                recordId: 'r-1',
                body: 'исправлено',
                eventDateLocal: MORNING,
                now: NOW + 600_000,
            });
        });

        const [update] = only(fake, 'UPDATE record SET');
        expect(update.statement).toContain('updated_at_utc = ?');
        expect(
            update.statement.includes('entry_at_utc'),
            'the entry time is when the text was first written; only updated_at_utc moves'
        ).toBe(false);
        expect(update.values).toEqual(['исправлено', MORNING, NOW + 600_000, 'r-1']);
    });

    test('an edit that names nothing is refused rather than reported as saved', async () => {
        const fake = createFakeBridge({ answer: AREA_FOUND });
        let failure = null;
        await withFakeBridge(fake, async () => {
            const { overwriteRecord } = await load('store/records.js');
            failure = await overwriteRecord({
                recordId: '',
                body: 'исправлено',
                eventDateLocal: MORNING,
                now: NOW,
            }).catch((error) => error);
        });

        expect(failure).toBeInstanceOf(Error);
        expect(fake.mutationCount()).toBe(0);
    });
});

test.describe('a store failure is classified, not swallowed and not retried', () => {
    // The wrapper rejects with a plain string carrying the engine's own words —
    // `RetHandler.call.reject`, prefixed by the plugin method. These are the
    // shapes store-unit.spec.js already pins the classifier against; what is
    // added here is that the DIARY path lets them through as themselves.
    const WRAPPER_DISK_FULL = 'ExecuteSet: database or disk is full (code 13 SQLITE_FULL)';

    test('a full disk surfaces as StoreDiskFullError from the write path', async () => {
        const fake = createFakeBridge({ failOn: 1, failWith: WRAPPER_DISK_FULL });
        let failure = null;
        await withFakeBridge(fake, async () => {
            const { createRecord } = await load('store/records.js');
            failure = await createRecord({
                authorParticipantId: AUTHOR,
                subjectChildId: CHILD,
                body: ENTRY,
                eventDateLocal: MORNING,
                now: NOW,
            }).catch((error) => error);
        });

        expect(failure).toBeInstanceOf(Error);
        expect(failure.name, 'the parent must be told their entry was NOT recorded').toBe(
            'StoreDiskFullError'
        );
        expect(failure.message, 'the raw engine message survives for the RUNBOOK').toContain(
            'SQLITE_FULL'
        );
        // Counted off `calls` rather than mutationCount(), which excludes the
        // failed call by design: what is being asserted is that the write was
        // ATTEMPTED once and not attempted again behind the parent's back.
        const attempts = fake.calls.filter((call) => call.method === 'executeSet');
        expect(attempts, 'a refused write is not retried behind the parent').toHaveLength(1);
        expect(attempts[0].failed, 'and the one attempt is the one that was refused').toBe(true);
    });

    test('storeFailureCode turns that into the closed code the taxonomy declares', async () => {
        const { storeFailureCode, StoreDiskFullError } = await load('store/errors.js');
        expect(storeFailureCode(new StoreDiskFullError('x'))).toBe('disk_full');
        // Usable directly as a rejection handler, which is how the mark surface
        // reaches it: markSkill(...).catch(storeFailureCode).
        const code = await Promise.reject(new StoreDiskFullError('x')).catch(storeFailureCode);
        expect(code).toBe('disk_full');
    });

    test('it also reads the class NAME, which is all the open path kept', async () => {
        const { storeFailureCode } = await load('store/errors.js');
        expect(storeFailureCode('StoreUnavailableError')).toBe('unavailable');
        expect(storeFailureCode('StoreCorruptError')).toBe('corrupt');
    });

    test('anything it cannot name is "other", never a guess and never a free string', async () => {
        const { storeFailureCode } = await load('store/errors.js');
        for (const unknown of [null, undefined, 'SomethingElse', new Error('boom'), 42, {}]) {
            expect(storeFailureCode(unknown)).toBe('other');
        }
    });
});

test.describe('the closed codes agree with the signal taxonomy', () => {
    // One mapping point, asserted across the two modules that hold it. The rule
    // came from transfer-seam.spec.js, which applied it to the transfer plugin's
    // refusal list; that spec and that list are retired (PPR-P2) and this is the
    // only pairing left. store/ has no import edge into core/, so the lists
    // cannot be shared by construction; this is what keeps them from drifting
    // instead.
    test('every store failure code is a declared failure_class value', async () => {
        const { STORE_FAILURE_CODES } = await load('store/errors.js');
        const { SIGNAL_CODES } = await load('core/signals.js');

        expect(STORE_FAILURE_CODES.length, 'the scan reaches a non-trivial list').toBeGreaterThan(3);
        for (const code of STORE_FAILURE_CODES) {
            expect(
                SIGNAL_CODES.failure_class,
                `store/errors.js can produce "${code}", which no signal may carry`
            ).toContain(code);
        }
    });

    test('and the taxonomy adds exactly one value the store never produces', async () => {
        const { STORE_FAILURE_CODES } = await load('store/errors.js');
        const { SIGNAL_CODES } = await load('core/signals.js');
        // 'none' means "nothing failed", which is a fact about the CALL and not a
        // failure the store can classify. Naming the difference is what makes the
        // subset check above a real constraint rather than a coincidence.
        expect(
            SIGNAL_CODES.failure_class.filter((code) => !STORE_FAILURE_CODES.includes(code))
        ).toEqual(['none']);
    });
});
