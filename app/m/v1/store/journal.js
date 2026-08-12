// Journal primitives: append, read from a cursor, project (L1-P2, extended L1-P4).
//
// The write path as an INTERACTION ("a mark is an attributed assertion" as
// something a parent does) is P4. What lives here is the mechanism underneath
// it, and the two properties that mechanism has to have:
//
//   - an append writes the spine row and its detail row in ONE transaction, so
//     a half-written assertion cannot exist;
//   - a read resumes from a stored cursor over LOCAL ARRIVAL order, so nothing
//     is skipped when an entry about January arrives in March.
//
// L1-P4 adds two things and changes nothing that was here.
//
// appendEntries() generalises the first property from one entry to N. A mark is
// an assertion AND its author's confirmation, and those two entries must not be
// separable: an assertion with no confirmation is a different claim about the
// family from the one the parent made. The import needs the same guarantee one
// level up — a child row and its name arrive together or not at all — which is
// what `prelude` carries.
//
// MARKS_SQL is the projection the app reads. It is a JOIN rather than a view
// because the schema is FROZEN (LSC-DL-002): `v_child_skill_state` carries no
// consensus column, `v_assertion_consensus` is keyed by assertion, and adding
// `v_child_skill_consensus` would be a schema change on a store that already
// holds a family's history. app/tests/schema/test_write_path_projection.py reads
// this constant out of this file and runs it against the real frozen DDL, so the
// query that is verified is the query that ships.

import { STORE_CONFIG } from './config.js';
import { executeSet, query, run } from './bridge.js';
import { StoreError } from './errors.js';
import { mintId } from './store.js';

const ENTRY_SQL =
    'INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,'
    + ' visibility_class, origin, event_date_local, event_at_utc, event_utc_offset_min,'
    + ' entry_at_utc, entry_utc_offset_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const DETAIL_SQL = Object.freeze({
    assertion:
        'INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,'
        + ' prerequisite_propagation, source_record_id, supersedes_assertion_id)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    confirmation:
        'INSERT INTO confirmation (journal_id, target_assertion_id, status, note)'
        + ' VALUES (?, ?, ?, ?)',
    child_attribute:
        'INSERT INTO child_attribute (journal_id, attribute, value, sensitive) VALUES (?, ?, ?, ?)',
});

// Slot 2 plus slot 9, read together. The consensus columns are projected even
// though no surface reads them yet: P4 must EXPRESS the half-confirmed state and
// L7 owns the behaviour, and a projection that dropped them would make that a
// rewrite rather than a wiring. COALESCE is defensive — `v_assertion_consensus`
// has a row per assertion today, and an absent one must read as "nobody has
// confirmed this" rather than as a missing skill.
const MARKS_SQL =
    'SELECT s.child_id AS child_id, s.skill_id AS skill_id, s.state AS state,'
    + ' s.visibility_class AS visibility_class, s.asserted_by AS asserted_by,'
    + ' s.effective_from_date AS effective_from_date,'
    + ' s.prerequisite_propagation AS prerequisite_propagation,'
    + ' s.assertion_id AS assertion_id, je.origin AS origin,'
    + ' COALESCE(c.confirmed_by, 0) AS confirmed_by,'
    + ' COALESCE(c.disputed_by, 0) AS disputed_by,'
    + ' COALESCE(c.needs_refresh_by, 0) AS needs_refresh_by'
    + ' FROM v_child_skill_state s'
    + ' JOIN journal_entry je ON je.id = s.assertion_id'
    + ' LEFT JOIN v_assertion_consensus c ON c.assertion_id = s.assertion_id'
    + ' WHERE s.child_id = ?'
    + ' ORDER BY s.skill_id';

// The child's current attributes, which is how a profile exists at all on the
// native side: a child row is an identity, and its name is a journal entry.
const CHILDREN_SQL =
    'SELECT c.id AS id, c.created_at_utc AS created_at_utc,'
    + ' MAX(CASE WHEN v.attribute = ? THEN v.value END) AS name,'
    + ' MAX(CASE WHEN v.attribute = ? THEN v.value END) AS birthdate'
    + ' FROM child c LEFT JOIN v_child_attribute_current v ON v.child_id = c.id'
    + ' GROUP BY c.id, c.created_at_utc ORDER BY c.created_at_utc, c.id';

function detailValues(kind, id, detail) {
    if (kind === 'assertion') {
        return [
            id,
            detail.kind,
            detail.skillId ?? null,
            detail.effectiveFromDate,
            detail.prerequisitePropagation ?? 'none',
            detail.sourceRecordId ?? null,
            detail.supersedesAssertionId ?? null,
        ];
    }
    if (kind === 'confirmation') {
        return [id, detail.targetAssertionId, detail.status, detail.note ?? null];
    }
    if (kind === 'child_attribute') {
        // The three declarative markers are sensitive by construction, not by
        // the caller remembering to say so (PDR-033). The schema CHECK refuses
        // the row if this is ever got wrong, so the two agree by force.
        const sensitive = detail.attribute.startsWith('marker_') ? 1 : 0;
        return [id, detail.attribute, detail.value ?? null, sensitive];
    }
    throw new StoreError(`unknown journal entry kind "${kind}"`);
}

/**
 * Appends one journal entry and its detail row atomically.
 *
 * `entry` carries the spine fields; `detail` carries the kind-specific ones.
 * The id is minted here unless the caller supplies one (the P4 import supplies
 * ids so that a re-run of the import is idempotent).
 */
export async function appendEntry({ kind, entry, detail, id = null }) {
    const [entryId] = await appendEntries([{ kind, entry, detail, id }]);
    return entryId;
}

/** The two statements one journal entry is, with its id resolved. */
function entryStatements({ kind, entry, detail, id = null }) {
    const entryId = id ?? mintId();
    if (!entry.authorParticipantId || !entry.subjectChildId) {
        throw new StoreError(
            'a journal entry needs both an author and a subject (LSC-P2-INV-005)'
        );
    }
    if (!DETAIL_SQL[kind]) {
        throw new StoreError(`unknown journal entry kind "${kind}"`);
    }
    return {
        entryId,
        statements: [
            {
                statement: ENTRY_SQL,
                values: [
                    entryId,
                    kind,
                    entry.authorParticipantId,
                    entry.subjectChildId,
                    entry.visibilityClass ?? 'child_shared',
                    entry.origin ?? 'authored',
                    entry.eventDateLocal,
                    entry.eventAtUtc ?? null,
                    entry.eventUtcOffsetMin ?? null,
                    entry.entryAtUtc,
                    entry.entryUtcOffsetMin,
                ],
            },
            { statement: DETAIL_SQL[kind], values: detailValues(kind, entryId, detail) },
        ],
    };
}

/**
 * Appends N journal entries in ONE transaction, and returns their ids in order.
 *
 * Every entry is validated BEFORE anything is sent, so a batch with one bad
 * entry writes nothing rather than a prefix — a refusal has to be a refusal, not
 * a partial success (ADR-015).
 *
 * `prelude` carries non-journal statements that belong to the same act: today
 * that is the `child` row a first entry about a new child needs to exist before
 * its foreign key can resolve. It runs first, inside the same transaction, so a
 * child cannot appear in the journal without the entries that say who they are.
 *
 * ORDER IS LOAD-BEARING. Foreign keys are enforced immediately (store.js turns
 * `foreign_keys` ON), so a confirmation must follow the assertion it targets
 * within the array, not merely within the transaction.
 */
export async function appendEntries(entries, { prelude = [] } = {}) {
    const prepared = entries.map(entryStatements);
    await executeSet(
        [...prelude, ...prepared.flatMap((item) => item.statements)],
        { transaction: true }
    );
    return prepared.map((item) => item.entryId);
}

/**
 * Which journal ids out of `ids` are already in the store.
 *
 * The import's whole idempotence rests on this being a read: what has already
 * been imported is derived from the journal itself rather than from a ledger
 * that could disagree with it (L1-P4).
 */
export async function existingEntryIds(ids) {
    if (!ids.length) return new Set();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await query(
        `SELECT id FROM journal_entry WHERE id IN (${placeholders})`,
        ids
    );
    return new Set(rows.map((row) => row.id));
}

export function readSince(cursorName, limit = STORE_CONFIG.cursorBatchSize) {
    return query(
        'SELECT je.seq AS seq, je.id AS id, je.kind AS kind, je.subject_child_id AS subject_child_id,'
        + ' je.entry_at_utc AS entry_at_utc FROM journal_entry je'
        + ' WHERE je.seq > COALESCE((SELECT c.last_seq FROM journal_cursor c WHERE c.name = ?), 0)'
        + ' ORDER BY je.seq LIMIT ?',
        [cursorName, limit]
    );
}

// Acknowledging is separate from reading on purpose: an interrupted consumer
// must re-read the batch it never finished, not skip it.
export function acknowledgeCursor(cursorName, lastSeq, nowUtc) {
    return run(
        'INSERT INTO journal_cursor (name, last_seq, updated_at_utc) VALUES (?, ?, ?)'
        + ' ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq,'
        + ' updated_at_utc = excluded.updated_at_utc',
        [cursorName, lastSeq, nowUtc]
    );
}

/**
 * Slot 7 — backward propagation, applied at PROJECTION time.
 *
 * A pure function on purpose: implied prerequisites must never be written back
 * into the journal, because slot 1 defines a mark as an ATTRIBUTED assertion and
 * materialising an implication would fabricate an assertion the parent never
 * made. So an implied skill is returned as a DERIVED row — no author, and a
 * pointer to the authored assertion it came from (ADR-015 honest degradation
 * applies to provenance here too).
 *
 * `prerequisitesOf` is injected rather than imported: the prerequisite graph
 * lives in the KB artifact, and the store has no business knowing about it.
 */
export function applyPrerequisitePropagation(rows, prerequisitesOf) {
    const observed = new Set(
        rows.filter((row) => row.state === 'skill_observed').map((row) => row.skill_id)
    );
    const out = rows.map((row) => ({ ...row, derived: false, derived_from: null }));
    const seen = new Set(rows.map((row) => row.skill_id));

    for (const row of rows) {
        if (row.state !== 'skill_observed') continue;
        if (row.prerequisite_propagation !== 'implies_prerequisites') continue;
        for (const skillId of prerequisitesOf(row.skill_id)) {
            if (seen.has(skillId) || observed.has(skillId)) continue;
            seen.add(skillId);
            out.push({
                child_id: row.child_id,
                skill_id: skillId,
                state: 'skill_observed',
                visibility_class: row.visibility_class,
                asserted_by: null,
                effective_from_date: row.effective_from_date,
                prerequisite_propagation: 'none',
                assertion_id: null,
                derived: true,
                derived_from: row.assertion_id,
            });
        }
    }
    return out;
}

/**
 * Skill state as of a date, reconstructed from the journal (rule 3).
 *
 * Binding the date through projection_context rather than through a query
 * parameter keeps ONE definition of the projection — the view — shared by the
 * app, the desktop tests and anything that later reads the store directly.
 */
export async function projectSkillState({ asOfDate = '9999-12-31', prerequisitesOf = null } = {}) {
    await run('UPDATE projection_context SET as_of_date = ? WHERE id = 1', [asOfDate]);
    const rows = await query('SELECT * FROM v_child_skill_state', []);
    return prerequisitesOf ? applyPrerequisitePropagation(rows, prerequisitesOf) : rows;
}

/**
 * One child's marks, with the consensus each one currently carries (L1-P4).
 *
 * The as-of date is written before the read rather than assumed: the view reads
 * it out of `projection_context`, which is one mutable row anything else could
 * have moved, and a live view silently showing last February would be the worst
 * kind of wrong — plausible.
 */
export async function projectMarks(childId, { asOfDate = '9999-12-31' } = {}) {
    await run('UPDATE projection_context SET as_of_date = ? WHERE id = 1', [asOfDate]);
    return query(MARKS_SQL, [childId]);
}

/** Every child the store knows about, with their current name and birthdate. */
export function projectChildren() {
    return query(CHILDREN_SQL, ['name', 'birthdate']);
}
