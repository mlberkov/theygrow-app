// Journal primitives: append, read from a cursor, project (L1-P2).
//
// The write path as an INTERACTION ("a mark is an attributed assertion" as
// something a parent does) is P4. What lives here is the mechanism underneath
// it, and the two properties that mechanism has to have:
//
//   - an append writes the spine row and its detail row in ONE transaction, so
//     a half-written assertion cannot exist;
//   - a read resumes from a stored cursor over LOCAL ARRIVAL order, so nothing
//     is skipped when an entry about January arrives in March.

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
    const entryId = id ?? mintId();
    if (!entry.authorParticipantId || !entry.subjectChildId) {
        throw new StoreError(
            'a journal entry needs both an author and a subject (LSC-P2-INV-005)'
        );
    }
    await executeSet(
        [
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
        { transaction: true }
    );
    return entryId;
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
