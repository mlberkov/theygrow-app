// The journal side of the history seam (L1-P4).
//
// A MARK IS AN ATTRIBUTED ASSERTION (PDR-025 §2). Ticking a skill does not
// record the fact "mastered"; it records "this parent asserts: mastered", with
// an author, a subject, an event date and a stable id. The node's state is never
// stored — `loadMarks` projects it back out of the assertions every time.
//
// WHY EVERY MARK CARRIES A CONFIRMATION BY ITS OWN AUTHOR. The owner decision on
// legacy marks is that they migrate as "the author's assertion, CONFIRMED BY
// ONE" — two components, not one — and `schema/001-core.sql` says so at the
// `confirmation` table. If an authored mark carried only the assertion, then the
// same act would produce two different consensus states depending on which
// packet wrote it, and the projection would need a rule to paper over the
// difference. So the pairing is unconditional here, and `origin` is the only
// thing that separates an imported mark from one made this morning.
//
// The alternative — counting the author as an implicit confirmer inside the
// projection — was rejected: it would double-count against the migration shape
// the frozen schema already prescribes, and it would put a consensus rule in a
// projection that every L7 device would then have to reimplement identically.
// A fact written into the journal survives where such a rule drifts between app
// versions, which is the whole posture of an append-only store. The cost is
// accepted rather than incidental: two journal entries per tick, forever, and
// L7 inherits it.
//
// NOTHING HERE BRANCHES ON HOW MANY PARTICIPANTS EXIST. With one equal owner the
// consensus function returns "confirmed by one" because that is what counting
// says, not because a degenerate case was special-cased (PDR-021).

import { appendEntries, projectChildren, projectMarks } from './journal.js';
import { mintId } from './store.js';

/** The local calendar date, which is the date a parent would say out loud. */
function localDate(now) {
    const at = new Date(now);
    const year = at.getFullYear();
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Minutes east of UTC, which is the sign the schema stores. */
function utcOffset(now) {
    return -new Date(now).getTimezoneOffset();
}

/**
 * Appends one mark: the assertion, and its author's confirmation, atomically.
 *
 * `observed` false is a REVOCATION, which is a new assertion on top rather than
 * a delete — the journal is append-only and un-ticking is itself something a
 * parent did, on a date, and may want to see later.
 */
export async function appendMark({
    authorParticipantId,
    subjectChildId,
    skillId,
    observed,
    now = Date.now(),
    today = null,
    utcOffsetMin = null,
}) {
    const eventDateLocal = today ?? localDate(now);
    const offset = utcOffsetMin ?? utcOffset(now);
    const spine = {
        authorParticipantId,
        subjectChildId,
        visibilityClass: 'child_shared',
        origin: 'authored',
        eventDateLocal,
        // An authored mark knows its instant: the parent is ticking it now. A
        // migrated one does not, and says so by leaving these null.
        eventAtUtc: now,
        eventUtcOffsetMin: offset,
        entryAtUtc: now,
        entryUtcOffsetMin: offset,
    };
    const assertionId = mintId();
    const confirmationId = mintId();

    await appendEntries([
        {
            id: assertionId,
            kind: 'assertion',
            entry: spine,
            detail: {
                kind: observed ? 'skill_observed' : 'skill_revoked',
                skillId,
                effectiveFromDate: eventDateLocal,
                prerequisitePropagation: 'none',
            },
        },
        {
            id: confirmationId,
            kind: 'confirmation',
            entry: spine,
            detail: { targetAssertionId: assertionId, status: 'confirmed' },
        },
    ]);

    return { assertionId, confirmationId };
}

/**
 * Appends a new child: the identity row, its name and its birthdate, atomically.
 *
 * The child row goes in the prelude of the same transaction as its attributes,
 * so the journal never holds a child nobody can name.
 */
export async function appendChild({
    authorParticipantId,
    name,
    birthdate,
    now = Date.now(),
    today = null,
    childId = null,
    utcOffsetMin = null,
}) {
    const subjectChildId = childId ?? mintId();
    const eventDateLocal = today ?? localDate(now);
    const offset = utcOffsetMin ?? utcOffset(now);
    const spine = {
        authorParticipantId,
        subjectChildId,
        visibilityClass: 'child_shared',
        origin: 'authored',
        eventDateLocal,
        eventAtUtc: now,
        eventUtcOffsetMin: offset,
        entryAtUtc: now,
        entryUtcOffsetMin: offset,
    };
    const attributes = [
        { attribute: 'name', value: name },
        { attribute: 'birthdate', value: birthdate },
    ].filter((item) => item.value !== null && item.value !== undefined && item.value !== '');

    await appendEntries(
        attributes.map((detail) => ({ kind: 'child_attribute', entry: spine, detail })),
        { prelude: [childRow(subjectChildId, now)] }
    );
    return subjectChildId;
}

/**
 * The `child` row as a statement, for callers assembling a larger transaction.
 *
 * ON CONFLICT DO NOTHING rather than a pre-read: `child` carries no append-only
 * trigger (it is an identity, not a claim), so re-asserting it is a no-op and
 * the import can re-run without checking first.
 */
export function childRow(childId, createdAtUtc) {
    return {
        statement: 'INSERT INTO child (id, created_at_utc) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
        values: [childId, createdAtUtc],
    };
}

/** One child's marks, each with the consensus it currently carries. */
export function loadMarks({ childId }) {
    return projectMarks(childId);
}

/** Every child, in the shape the in-memory model uses on both channels. */
export async function loadChildren() {
    const rows = await projectChildren();
    return rows.map((row) => ({
        id: row.id,
        name: row.name ?? '',
        birthdate: row.birthdate ?? null,
        completedSkills: [],
    }));
}

/**
 * The completed set the render path consumes.
 *
 * A revoked skill is ABSENT rather than present-and-false: the five synchronous
 * readers ask `has()`, and a false-valued member would quietly read as completed
 * at every one of them.
 */
export function completedFrom(rows) {
    return new Set(
        rows.filter((row) => row.state === 'skill_observed').map((row) => row.skill_id)
    );
}
