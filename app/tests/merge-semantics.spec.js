'use strict';

// Merge-semantics run for the frozen schema (L1-P2, ADR-046 §2.1).
//
// WHAT THIS IS AND IS NOT. The CRDT library is NOT selected here — that stays
// open to L7 (ADR-040 §3). What is checked is that the SCHEMA converges under
// the merge semantics of BOTH candidates, so that choosing either later creates
// no lock-in and no migration. A shape that converges under one and not the
// other would be a red result to surface, not to work around.
//
// Both libraries appear in devDependencies and in this file only. Nothing in the
// shipped asset set references them, which app/tests/store-supply-chain.spec.js
// proves in the other direction: library code lives in tests, never in the
// runtime or the storage format.
//
// THE MODEL. The journal is a map keyed by the entry id minted at creation
// (slot 16), whose values are IMMUTABLE (slot 10). That is the whole point of
// the design being checked: immutable values keyed by collision-free ids have
// no merge conflict to resolve, in any CRDT, ever. The mutable surfaces are
// exactly two — diary text, edited by overwrite (rule 1), and the quote basis,
// erased on record deletion (slot 15) — and each is checked separately.

const { test, expect } = require('@playwright/test');

// --- the projection under test -------------------------------------------
//
// A port of the winner rule in v_child_skill_state. It is duplicated here on
// purpose: the SQL view cannot be run against a CRDT document, and the property
// being checked is the RULE, not its SQL spelling. app/tests/schema/
// test_store_projections.py pins the SQL side to the same rule.

function laterThan(a, b) {
    if (a.entry_at_utc !== b.entry_at_utc) return a.entry_at_utc > b.entry_at_utc;
    return a.id > b.id;
}

function projectSkillState(entries) {
    const winners = new Map();
    for (const entry of entries) {
        if (entry.kind !== 'assertion' || !entry.skill_id) continue;
        const key = `${entry.subject_child_id}/${entry.skill_id}`;
        const held = winners.get(key);
        if (!held || laterThan(entry, held)) winners.set(key, entry);
    }
    return [...winners.entries()]
        .map(([key, entry]) => `${key}=${entry.state}`)
        .sort()
        .join('|');
}

// The rule a naive design would have used, kept here as the counter-example the
// SQL comment refers to. seq is assigned by ARRIVAL, so it differs per replica.
function projectBySeq(entries) {
    const winners = new Map();
    for (const entry of entries) {
        if (entry.kind !== 'assertion' || !entry.skill_id) continue;
        const key = `${entry.subject_child_id}/${entry.skill_id}`;
        const held = winners.get(key);
        if (!held || entry.seq > held.seq) winners.set(key, entry);
    }
    return [...winners.entries()]
        .map(([key, entry]) => `${key}=${entry.state}`)
        .sort()
        .join('|');
}

function entry(id, skillId, state, entryAtUtc) {
    return {
        id,
        kind: 'assertion',
        subject_child_id: 'c-1',
        author_participant_id: 'p-1',
        visibility_class: 'child_shared',
        origin: 'authored',
        skill_id: skillId,
        state,
        effective_from_date: '2026-01-01',
        entry_at_utc: entryAtUtc,
    };
}

// Local arrival order, assigned per replica exactly as journal_entry.seq is.
function withLocalSeq(entries) {
    return entries.map((e, i) => ({ ...e, seq: i + 1 }));
}

// --- adapters -------------------------------------------------------------
//
// One tiny adapter per library, exposing the same four operations, so every
// assertion below runs identically against both and a divergence is visible as
// a difference between two named results rather than as a second test.

async function automergeAdapter() {
    const A = await import('@automerge/automerge');
    return {
        name: 'automerge',
        create(entries, records = {}, quotes = {}) {
            return A.from({
                journal: Object.fromEntries(entries.map((e) => [e.id, e])),
                records,
                quotes,
            });
        },
        fork(doc) {
            return A.clone(doc);
        },
        append(doc, e) {
            return A.change(doc, (d) => {
                d.journal[e.id] = e;
            });
        },
        setBody(doc, recordId, body) {
            return A.change(doc, (d) => {
                d.records[recordId].body = body;
            });
        },
        eraseQuote(doc, assertionId) {
            return A.change(doc, (d) => {
                delete d.quotes[assertionId];
            });
        },
        merge(left, right) {
            return A.merge(A.clone(left), right);
        },
        read(doc) {
            return A.toJS(doc);
        },
    };
}

async function loroAdapter() {
    const { LoroDoc } = await import('loro-crdt');
    const build = (entries, records, quotes) => {
        const doc = new LoroDoc();
        const journal = doc.getMap('journal');
        for (const e of entries) journal.set(e.id, e);
        const recordMap = doc.getMap('records');
        for (const [id, value] of Object.entries(records)) recordMap.set(id, value);
        const quoteMap = doc.getMap('quotes');
        for (const [id, value] of Object.entries(quotes)) quoteMap.set(id, value);
        doc.commit();
        return doc;
    };
    return {
        name: 'loro',
        create(entries, records = {}, quotes = {}) {
            return build(entries, records, quotes);
        },
        fork(doc) {
            const copy = new LoroDoc();
            copy.import(doc.export({ mode: 'snapshot' }));
            return copy;
        },
        append(doc, e) {
            doc.getMap('journal').set(e.id, e);
            doc.commit();
            return doc;
        },
        setBody(doc, recordId, body) {
            const records = doc.getMap('records');
            records.set(recordId, { ...records.get(recordId), body });
            doc.commit();
            return doc;
        },
        eraseQuote(doc, assertionId) {
            doc.getMap('quotes').delete(assertionId);
            doc.commit();
            return doc;
        },
        merge(left, right) {
            const merged = new LoroDoc();
            merged.import(left.export({ mode: 'snapshot' }));
            merged.import(right.export({ mode: 'snapshot' }));
            merged.commit();
            return merged;
        },
        read(doc) {
            return doc.toJSON();
        },
    };
}

const ADAPTERS = [automergeAdapter, loroAdapter];

for (const load of ADAPTERS) {
    test.describe(`schema converges under ${load.name.replace('Adapter', '')}`, () => {
        let crdt;

        test.beforeAll(async () => {
            crdt = await load();
        });

        test('concurrent appends on two devices lose nothing', async () => {
            const base = crdt.create([entry('j-1', 'sit', 'skill_observed', 100)]);
            let left = crdt.fork(base);
            let right = crdt.fork(base);

            left = crdt.append(left, entry('j-2', 'walk', 'skill_observed', 200));
            right = crdt.append(right, entry('j-3', 'crawl', 'skill_observed', 201));

            const merged = crdt.merge(left, right);
            const ids = Object.keys(crdt.read(merged).journal).sort();
            expect(ids, `${crdt.name}: a concurrent append was lost`).toEqual([
                'j-1',
                'j-2',
                'j-3',
            ]);
        });

        test('merge order does not change the merged journal', async () => {
            const base = crdt.create([entry('j-1', 'sit', 'skill_observed', 100)]);
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.append(left, entry('j-2', 'walk', 'skill_observed', 200));
            right = crdt.append(right, entry('j-3', 'crawl', 'skill_observed', 201));

            const leftFirst = crdt.read(crdt.merge(left, right)).journal;
            const rightFirst = crdt.read(crdt.merge(right, left)).journal;
            expect(Object.keys(leftFirst).sort()).toEqual(Object.keys(rightFirst).sort());
        });

        test('the projection is identical on both devices after merge', async () => {
            // The same assertion superseded concurrently on both devices — the
            // case where a projection keyed on arrival order would disagree.
            const base = crdt.create([entry('j-1', 'sit', 'skill_observed', 100)]);
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.append(left, entry('j-2', 'sit', 'skill_revoked', 300));
            right = crdt.append(right, entry('j-3', 'walk', 'skill_observed', 200));

            const onLeft = Object.values(crdt.read(crdt.merge(left, right)).journal);
            const onRight = Object.values(crdt.read(crdt.merge(right, left)).journal);

            expect(projectSkillState(onLeft)).toBe(projectSkillState(onRight));
            expect(projectSkillState(onLeft)).toBe(
                'c-1/sit=skill_revoked|c-1/walk=skill_observed'
            );
        });

        test('diary text edited by overwrite converges to one value', async () => {
            const base = crdt.create([], { 'r-1': { id: 'r-1', body: 'первый вариант' } });
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.setBody(left, 'r-1', 'левая правка');
            right = crdt.setBody(right, 'r-1', 'правая правка');

            const a = crdt.read(crdt.merge(left, right)).records['r-1'].body;
            const b = crdt.read(crdt.merge(right, left)).records['r-1'].body;
            expect(a, `${crdt.name}: overwrite did not converge`).toBe(b);
            expect(['левая правка', 'правая правка']).toContain(a);
        });

        test('erasing a quote converges and leaves the assertion standing', async () => {
            const base = crdt.create(
                [entry('j-1', 'sit', 'skill_observed', 100)],
                { 'r-1': { id: 'r-1', body: 'сел сам' } },
                { 'j-1': { assertion_id: 'j-1', quote_text: 'сел сам' } }
            );
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.eraseQuote(left, 'j-1');
            right = crdt.append(right, entry('j-2', 'walk', 'skill_observed', 200));

            const merged = crdt.read(crdt.merge(left, right));
            expect(merged.quotes['j-1'] ?? null, `${crdt.name}: erasure did not converge`).toBe(
                null
            );
            expect(merged.journal['j-1']).toBeTruthy();
            expect(Object.keys(merged.journal).sort()).toEqual(['j-1', 'j-2']);
        });

        test('an id minted at creation survives the merge as the key', async () => {
            // Slot 16 — ids cannot be handed out retroactively, and the merge
            // must not renumber them. A schema that keyed entries on a local
            // counter would fail this outright.
            const base = crdt.create([entry('j-1', 'sit', 'skill_observed', 100)]);
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.append(left, entry('j-same', 'walk', 'skill_observed', 200));
            right = crdt.append(right, entry('j-same', 'walk', 'skill_observed', 200));

            const merged = crdt.read(crdt.merge(left, right));
            expect(Object.keys(merged.journal).sort()).toEqual(['j-1', 'j-same']);
            expect(merged.journal['j-same'].skill_id).toBe('walk');
        });
    });
}

test.describe('both candidates agree — no lock-in either way', () => {
    test('the merged journal and its projection match across libraries', async () => {
        const scenario = (crdt) => {
            const base = crdt.create([entry('j-1', 'sit', 'skill_observed', 100)]);
            let left = crdt.fork(base);
            let right = crdt.fork(base);
            left = crdt.append(left, entry('j-2', 'sit', 'skill_revoked', 300));
            right = crdt.append(right, entry('j-3', 'walk', 'skill_observed', 200));
            const merged = crdt.read(crdt.merge(left, right));
            return {
                ids: Object.keys(merged.journal).sort(),
                projection: projectSkillState(Object.values(merged.journal)),
            };
        };

        const fromAutomerge = scenario(await automergeAdapter());
        const fromLoro = scenario(await loroAdapter());

        expect(
            fromLoro,
            'the two candidate libraries disagree about this schema — a red result, '
                + 'not something to work around'
        ).toEqual(fromAutomerge);
    });
});

test.describe('device-local columns stay out of the merged document', () => {
    test('a projection keyed on arrival order diverges — which is why seq is not used', () => {
        // Two replicas holding the SAME entries in different arrival orders.
        const entries = [
            entry('j-1', 'sit', 'skill_observed', 100),
            entry('j-2', 'sit', 'skill_revoked', 300),
        ];
        const deviceA = withLocalSeq(entries);
        const deviceB = withLocalSeq([...entries].reverse());

        expect(projectBySeq(deviceA)).not.toBe(projectBySeq(deviceB));
        expect(projectSkillState(deviceA)).toBe(projectSkillState(deviceB));
        expect(projectSkillState(deviceA)).toBe('c-1/sit=skill_revoked');
    });

    test('seq and the filing cursor are absent from every merged value', async () => {
        for (const load of ADAPTERS) {
            const crdt = await load();
            const merged = crdt.read(
                crdt.create([entry('j-1', 'sit', 'skill_observed', 100)])
            );
            const keys = Object.keys(merged.journal['j-1']);
            expect(keys, `${crdt.name}: seq leaked into the merged document`).not.toContain(
                'seq'
            );
            expect(Object.keys(merged)).not.toContain('journal_cursor');
        }
    });
});
