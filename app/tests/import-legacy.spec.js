'use strict';

// The localStorage → journal import (L1-P4).
//
// This is the packet's highest-stakes code: the live PWA holds the ONLY copy of
// this family's history, and moving it is irreversible because the journal is
// append-only. So the four properties below are not nice-to-haves, they are the
// conditions under which the import is allowed to run at all:
//
//   1. running it twice appends nothing the second time;
//   2. an interrupted run leaves a state the next run COMPLETES, never corrupts;
//   3. it cannot write to localStorage, structurally rather than by discipline;
//   4. re-running after a native revocation does not resurrect the mark.
//
// Property 3 is asserted against the source rather than at runtime, and that is
// the stronger form: a module that never imports a writer cannot write, whatever
// any future edit to its body does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { createFakeBridge, withFakeBridge } = require('./support/fake-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const STORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'store');
const CORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'core');
const SURFACES_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'surfaces');

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let generation = 0;

const AUTHOR = 'p-self-0001';
const NOW = 1_770_000_000_000;
const TODAY = '2026-08-13';

// Two profiles, because a single-profile fixture cannot show that per-profile
// selection selects anything.
const PROFILES = [
    {
        id: 'profile_1700000000000',
        name: 'Мия',
        birthdate: '2024-09-15',
        completedSkills: ['GM_001', 'GM_002'],
    },
    {
        id: 'profile_1700000009999',
        name: 'Лев',
        birthdate: '2022-03-02',
        completedSkills: ['GM_001'],
    },
];

test.beforeAll(() => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-import-'));
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
                `${sub}/${name} was not copied verbatim`
            ).toBeTruthy();
        }
    }
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

const load = (rel) => {
    generation += 1;
    return dynamicImport(`${pathToFileURL(path.join(loadRoot, rel)).href}?g=${generation}`);
};

/** Every journal id the recorder saw appended, in order. */
function appendedIds(fake) {
    return fake
        .statements()
        .filter((s) => s.statement.includes('INSERT INTO journal_entry'))
        .map((s) => s.values[0]);
}

// The trailing space and paren matter: `INSERT INTO child_attribute` shares a
// prefix with `INSERT INTO child`, and a looser match counts every attribute row
// as a child row and double-counts its journal id.
function childIds(fake) {
    return fake
        .statements()
        .filter((s) => s.statement.includes('INSERT INTO child ('))
        .map((s) => s.values[0]);
}

/** The read the import performs to find out what it has already done. */
function probeAnswer(ids) {
    return { 'FROM journal_entry WHERE id IN': ids.map((id) => ({ id })) };
}

async function runImport(options, { answer = {}, failOn = null } = {}) {
    const fake = createFakeBridge({ answer, failOn });
    let summary = null;
    let error = null;
    await withFakeBridge(fake, async () => {
        const { runImport: run } = await load('store/import-legacy.js');
        try {
            summary = await run({
                authorParticipantId: AUTHOR,
                profiles: PROFILES,
                selectedProfileIds: PROFILES.map((p) => p.id),
                now: NOW,
                today: TODAY,
                ...options,
            });
        } catch (reason) {
            error = reason;
        }
    });
    return { fake, summary, error };
}

test.describe('property 1 — running the import twice is running it once', () => {
    test('the second run appends nothing', async () => {
        const first = await runImport({});
        expect(first.error).toBe(null);
        const ids = appendedIds(first.fake);
        expect(ids.length, 'the first run did something to be idempotent about').toBeGreaterThan(0);

        const second = await runImport({}, { answer: probeAnswer(ids) });
        expect(second.error).toBe(null);
        expect(appendedIds(second.fake), 'nothing is appended twice').toEqual([]);
        expect(second.summary.assertions).toBe(0);
        expect(second.summary.confirmations).toBe(0);
        expect(second.summary.skipped, 'and it says what it skipped').toBeGreaterThan(0);
    });

    test('the ids are derived from the data, so two runs compute the same ones', async () => {
        const a = await runImport({});
        const b = await runImport({});
        expect(appendedIds(b.fake)).toEqual(appendedIds(a.fake));
        expect(childIds(b.fake)).toEqual(childIds(a.fake));
    });

    test('a derived id is shaped like a minted one and leaks nothing readable', async () => {
        const { fake } = await runImport({});
        const ids = [...appendedIds(fake), ...childIds(fake)];
        expect(ids.length).toBeGreaterThan(4);
        for (const id of ids) {
            expect(id, `${id} is not UUID-shaped`).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
            );
        }
        const joined = ids.join(' ');
        for (const secret of ['Мия', 'Лев', '2024-09-15', 'GM_001', 'profile_1700000000000']) {
            expect(joined, 'a derived id must not carry the value it was derived from').not.toContain(
                secret
            );
        }
        expect(new Set(ids).size, 'and no two entries collide').toBe(ids.length);
    });
});

test.describe('property 2 — an interrupted run is completed, not corrupted', () => {
    test('the next run appends exactly the remainder', async () => {
        const clean = await runImport({});
        const everything = appendedIds(clean.fake);

        // Interrupt partway: the recorder keeps the transactions that committed
        // before the failure, which is precisely the prefix a real crash leaves.
        const interrupted = await runImport({}, { failOn: 2 });
        expect(interrupted.error, 'the failure is reported, not swallowed').not.toBe(null);
        const written = appendedIds(interrupted.fake);
        expect(written.length, 'some of it landed').toBeGreaterThan(0);
        expect(written.length, 'but not all of it').toBeLessThan(everything.length);

        const resumed = await runImport({}, { answer: probeAnswer(written) });
        expect(resumed.error).toBe(null);

        expect(
            [...written, ...appendedIds(resumed.fake)].sort(),
            'the interrupted run plus its resumption equals an uninterrupted run'
        ).toEqual([...everything].sort());
        expect(
            new Set([...written, ...appendedIds(resumed.fake)]).size,
            'and nothing was written twice'
        ).toBe(everything.length);
    });

    test('a child is never left in the journal without its name', async () => {
        // The atomicity that matters to a reader: an entry that says a child
        // exists and nothing that says who they are is worse than no entry.
        const { fake } = await runImport({});
        const transactions = fake.transactions();
        const childTx = transactions.find((tx) =>
            tx.statements.some((s) => s.includes('INSERT INTO child ('))
        );
        expect(childTx, 'the child row is written inside a transaction').toBeTruthy();
        expect(childTx.transaction).toBe(true);
        expect(
            childTx.statements.filter((s) => s.includes('INSERT INTO child_attribute')).length,
            'the child arrives with its name and its birthdate or not at all'
        ).toBeGreaterThanOrEqual(2);
    });

    test('an assertion and its confirmation are never split across transactions', async () => {
        const { fake } = await runImport({});
        for (const tx of fake.transactions()) {
            const assertions = tx.statements.filter((s) => s.includes('INSERT INTO assertion')).length;
            const confirmations = tx.statements.filter((s) =>
                s.includes('INSERT INTO confirmation')
            ).length;
            expect(
                confirmations,
                'every assertion in a transaction is confirmed inside that same transaction'
            ).toBe(assertions);
        }
    });
});

test.describe('property 3 — the import cannot touch localStorage', () => {
    const IMPORT_PATH_FILES = [
        path.join(STORE_DIR, 'import-legacy.js'),
        path.join(STORE_DIR, 'repo-journal.js'),
    ];

    test('no module in the import path writes to Web Storage', async () => {
        for (const file of IMPORT_PATH_FILES) {
            const source = fs.readFileSync(file, 'utf8');
            for (const forbidden of ['setItem', 'removeItem', '.clear(']) {
                expect(source, `${path.basename(file)} can write to storage`).not.toContain(
                    forbidden
                );
            }
        }
    });

    test('no module in the import path even imports a storage writer', async () => {
        // The structural half. storage.js is the single door (LSC-P1-INV-001);
        // a module that never imports one of its writers cannot become a second
        // one by a later edit to its body.
        const writers = ['writeProfilesJson', 'writeCurrentProfileId', 'writeAccordionStatesJson'];
        for (const file of IMPORT_PATH_FILES) {
            const source = fs.readFileSync(file, 'utf8');
            for (const writer of writers) {
                expect(source, `${path.basename(file)} imports ${writer}`).not.toContain(writer);
            }
        }
    });

    test('the surface that triggers the import reads the legacy keys and writes none', async () => {
        const source = fs.readFileSync(path.join(SURFACES_DIR, 'import.js'), 'utf8');
        expect(source, 'it reads the profiles it is about to carry across').toContain(
            'readProfilesRaw'
        );
        for (const writer of ['writeProfilesJson', 'writeCurrentProfileId', 'setItem', 'removeItem']) {
            expect(source, 'clearing the source is a separate owner act, not this one').not.toContain(
                writer
            );
        }
    });
});

test.describe('property 4 — a re-run does not undo what happened natively', () => {
    test('a mark revoked on the device is not resurrected by importing again', async () => {
        const first = await runImport({});
        const ids = appendedIds(first.fake);

        // The parent later un-ticks that skill on the phone. That is a NEW
        // assertion on top; the imported one is still in the journal under its
        // derived id, so the import must see it as already done.
        const second = await runImport({}, { answer: probeAnswer(ids) });
        expect(appendedIds(second.fake)).toEqual([]);
        expect(
            second.summary.assertions,
            'the import re-asserts nothing, so the later revocation still wins the projection'
        ).toBe(0);
    });
});

test.describe('per-profile selection', () => {
    test('an unselected profile is not imported', async () => {
        const { fake, summary } = await runImport({
            selectedProfileIds: [PROFILES[0].id],
        });
        expect(summary.children).toBe(1);
        expect(childIds(fake)).toHaveLength(1);

        const values = fake.statements().flatMap((s) => s.values ?? []);
        expect(values, 'the selected child came across').toContain('Мия');
        expect(values, 'the unselected one did not').not.toContain('Лев');
    });

    test('an unselected profile can be imported later, and only it', async () => {
        const first = await runImport({ selectedProfileIds: [PROFILES[0].id] });
        const later = await runImport(
            { selectedProfileIds: PROFILES.map((p) => p.id) },
            { answer: probeAnswer(appendedIds(first.fake)) }
        );
        const values = later.fake.statements().flatMap((s) => s.values ?? []);
        expect(values).toContain('Лев');
        expect(values, 'and the first child is not written a second time').not.toContain('Мия');
    });

    test('selecting nothing writes nothing', async () => {
        const { fake, summary } = await runImport({ selectedProfileIds: [] });
        expect(fake.mutationCount()).toBe(0);
        expect(summary.children).toBe(0);
    });
});

test.describe('what the import writes, and how it is marked', () => {
    test('every imported entry says it was migrated, not authored', async () => {
        const { fake } = await runImport({});
        const spines = fake
            .statements()
            .filter((s) => s.statement.includes('INSERT INTO journal_entry'));
        expect(spines.length).toBeGreaterThan(0);
        for (const spine of spines) {
            expect(spine.values).toContain('migrated_legacy');
            expect(spine.values, 'and never claims to be authored').not.toContain('authored');
        }
    });

    test('an imported mark carries the import date and no event instant', async () => {
        const { fake } = await runImport({});
        const spines = fake
            .statements()
            .filter((s) => s.statement.includes('INSERT INTO journal_entry'));
        for (const spine of spines) {
            expect(spine.values, 'the NOT NULL date is the day it was imported').toContain(TODAY);
            // The paired instant columns are the schema's way of saying only the
            // date is known. Both null, or the CHECK refuses the row.
            const nulls = spine.values.filter((v) => v === null).length;
            expect(nulls, 'event_at_utc and event_utc_offset_min are both absent').toBeGreaterThanOrEqual(2);
        }
    });

    test('every imported mark is confirmed by its author — the owner decision, in the data', async () => {
        const { fake, summary } = await runImport({});
        expect(summary.assertions).toBe(3);
        expect(summary.confirmations, 'one confirmation per assertion, by the same parent').toBe(3);

        const confirmations = fake
            .statements()
            .filter((s) => s.statement.includes('INSERT INTO confirmation'));
        for (const confirmation of confirmations) {
            expect(confirmation.values).toContain('confirmed');
        }
    });

    test('the name and the birthdate come across as attributes, so the child has a history', async () => {
        const { fake, summary } = await runImport({});
        const attributes = fake
            .statements()
            .filter((s) => s.statement.includes('INSERT INTO child_attribute'));
        const named = attributes.flatMap((s) => s.values);
        expect(named).toContain('name');
        expect(named).toContain('birthdate');
        expect(named).toContain('Мия');
        expect(summary.attributes).toBe(4);
    });

    test('no marker attribute is invented — the modifier slot has no web surface to import', async () => {
        const { fake } = await runImport({});
        const values = fake.statements().flatMap((s) => s.values ?? []);
        for (const attribute of [
            'marker_bilingual',
            'marker_atypical_development',
            'marker_unknown_early_history',
            'gestational_age_weeks',
            'gestational_age_days',
        ]) {
            expect(values, `the import invented ${attribute}`).not.toContain(attribute);
        }
    });
});

test.describe('what is still waiting to come across', () => {
    test('the offer is keyed on what is missing, so it can be made again', async () => {
        const fake = createFakeBridge();
        let pending = null;
        await withFakeBridge(fake, async () => {
            const { pendingImport } = await load('store/import-legacy.js');
            pending = await pendingImport({ profiles: PROFILES, now: NOW, today: TODAY });
        });
        expect(pending.profiles).toHaveLength(2);
        expect(pending.total, 'three marks across two profiles').toBe(3);
    });

    test('once everything is across, there is nothing left to offer', async () => {
        const first = await runImport({});
        const fake = createFakeBridge({ answer: probeAnswer(appendedIds(first.fake)) });
        let pending = null;
        await withFakeBridge(fake, async () => {
            const { pendingImport } = await load('store/import-legacy.js');
            pending = await pendingImport({ profiles: PROFILES, now: NOW, today: TODAY });
        });
        expect(pending.profiles).toEqual([]);
        expect(pending.total).toBe(0);
    });
});
