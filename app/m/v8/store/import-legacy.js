// Carrying this family's history out of localStorage (L1-P4).
//
// THIS IS THE MOST CONSEQUENTIAL CODE IN THE MILESTONE, and the reason is not
// its difficulty. The live PWA holds the ONLY copy of this family's history, and
// the journal it moves into is append-only: nothing written here can later be
// edited, pruned or taken back. So the import is built around four properties,
// each of which is a condition on it being allowed to run at all
// (app/tests/import-legacy.spec.js):
//
//   1. Running it twice is running it once.
//   2. An interrupted run leaves a state the next run COMPLETES, never corrupts.
//   3. It cannot write to localStorage — structurally, not by discipline.
//   4. Re-running does not undo what happened natively afterwards.
//
// HOW 1 AND 2 ARE ACHIEVED, in one sentence: every id is DERIVED from what it
// identifies rather than minted, so a second run computes the same ids, reads
// back which of them the store already holds, and appends only the remainder.
// There is no ledger and no "already imported" flag — the journal is the only
// record of what has been imported, so there is no second truth to drift.
//
// HOW 3 IS ACHIEVED: this module imports no writer. `core/storage.js` is the one
// declared Web Storage door (LSC-P1-INV-001) and this file does not import from
// it at all — the caller reads the profiles and hands them in. A module that
// never imports a writer cannot become one by a later edit to its body, which is
// a stronger guarantee than any amount of care, and the spec asserts exactly
// that. CLEARING THE SOURCE IS A SEPARATE, EXPLICIT OWNER ACTION AND IS NOT HERE.
//
// HOW 4 IS ACHIEVED: it falls out of 1. A mark revoked on the device is a NEW
// assertion on top; the imported one is still in the journal under its derived
// id, so the import sees it as done and appends nothing, and the later
// revocation still wins the projection by (entry_at_utc, id).
//
// WHAT A MIGRATED ENTRY LOOKS LIKE, and why it is honest. A legacy mark carries
// no date at all. `journal_entry.event_date_local` is NOT NULL, so something has
// to go in it; the import date goes in, `event_at_utc` stays NULL — the schema's
// own way of saying only the date is known — and `origin` is 'migrated_legacy'.
// The three together say "recorded on import day, event time unknown", which is
// true. The archive is then required to SAY so rather than print the import date
// beside three hundred skills as though they were observed that afternoon; that
// is `export/declaration.json`'s `event_date_basis` column.

import { STORE_CONFIG } from './config.js';
import { appendEntries, existingEntryIds } from './journal.js';
import { childRow } from './repo-journal.js';
import { derivedId } from './store.js';

/** The local calendar date, as the parent's device reckons it. */
function localDate(now) {
    const at = new Date(now);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
        + `-${String(at.getDate()).padStart(2, '0')}`;
}

function utcOffset(now) {
    return -new Date(now).getTimezoneOffset();
}

/**
 * The spine every imported entry shares.
 *
 * `eventAtUtc` and `eventUtcOffsetMin` are absent together, which the schema's
 * paired CHECK requires and which is the whole point: we do not know when this
 * happened, and saying so is the only honest option available (ADR-015).
 */
function migratedSpine({ authorParticipantId, subjectChildId, eventDateLocal, now }) {
    return {
        authorParticipantId,
        subjectChildId,
        visibilityClass: 'child_shared',
        origin: 'migrated_legacy',
        eventDateLocal,
        eventAtUtc: null,
        eventUtcOffsetMin: null,
        entryAtUtc: now,
        entryUtcOffsetMin: utcOffset(now),
    };
}

/**
 * What the import WOULD write for one profile, with every id already derived.
 *
 * Pure apart from the hashing: it reads nothing and writes nothing, so the modal
 * can show the parent exactly what is about to happen before they press.
 */
async function planProfile(profile, { authorParticipantId, eventDateLocal, now }) {
    const subjectChildId = await derivedId('child', profile.id);
    const spine = migratedSpine({ authorParticipantId, subjectChildId, eventDateLocal, now });

    const attributes = [];
    for (const [attribute, value] of [
        ['name', profile.name],
        ['birthdate', profile.birthdate],
    ]) {
        if (value === null || value === undefined || value === '') continue;
        attributes.push({
            // The VALUE is part of the id, so a rename made on the web later
            // imports as a new attribute entry rather than being silently lost
            // behind an id that already exists.
            id: await derivedId('attribute', profile.id, attribute, String(value)),
            kind: 'child_attribute',
            entry: spine,
            detail: { attribute, value: String(value) },
        });
    }

    // A mark is a PAIR — the assertion and its author's confirmation — and the
    // pair is the unit of both writing and skipping. Splitting it would let a
    // resumed run append a confirmation whose assertion it had skipped.
    const marks = [];
    for (const skillId of profile.completedSkills || []) {
        const assertionId = await derivedId('assertion', profile.id, skillId);
        marks.push({
            assertionId,
            entries: [
                {
                    id: assertionId,
                    kind: 'assertion',
                    entry: spine,
                    detail: {
                        kind: 'skill_observed',
                        skillId,
                        effectiveFromDate: eventDateLocal,
                        prerequisitePropagation: 'none',
                    },
                },
                {
                    id: await derivedId('confirmation', assertionId),
                    kind: 'confirmation',
                    entry: spine,
                    // The owner decision, written into the data rather than
                    // inferred by a projection: a legacy mark migrates as the
                    // author's assertion, CONFIRMED BY ONE.
                    detail: { targetAssertionId: assertionId, status: 'confirmed' },
                },
            ],
        });
    }

    return { profile, subjectChildId, attributes, marks };
}

/** The whole plan, for the selected profiles, in a stable order. */
async function planImport({ profiles, selectedProfileIds, authorParticipantId, now, today }) {
    const eventDateLocal = today ?? localDate(now);
    const selected = new Set(selectedProfileIds);
    const plans = [];
    for (const profile of profiles) {
        if (!selected.has(profile.id)) continue;
        plans.push(await planProfile(profile, { authorParticipantId, eventDateLocal, now }));
    }
    return plans;
}

/** Which of the plan's ids the store already holds, probed in bounded batches. */
async function alreadyPresent(plans) {
    const ids = [];
    for (const plan of plans) {
        for (const attribute of plan.attributes) ids.push(attribute.id);
        for (const mark of plan.marks) ids.push(mark.assertionId);
    }
    const present = new Set();
    const size = STORE_CONFIG.legacyImportProbeBatch;
    for (let at = 0; at < ids.length; at += size) {
        for (const id of await existingEntryIds(ids.slice(at, at + size))) present.add(id);
    }
    return present;
}

/**
 * What has not been carried across yet.
 *
 * The import offer is keyed on this rather than on a "have we imported" flag,
 * which is what lets the offer be made again — after an interruption, and after
 * a parent has gone on marking things in the browser.
 */
export async function pendingImport({ profiles, authorParticipantId = 'probe', now, today }) {
    const plans = await planImport({
        profiles,
        selectedProfileIds: profiles.map((p) => p.id),
        authorParticipantId,
        now,
        today,
    });
    const present = await alreadyPresent(plans);

    const remaining = [];
    let total = 0;
    for (const plan of plans) {
        const marks = plan.marks.filter((mark) => !present.has(mark.assertionId)).length;
        const attributes = plan.attributes.filter((a) => !present.has(a.id)).length;
        if (marks === 0 && attributes === 0) continue;
        remaining.push({ id: plan.profile.id, name: plan.profile.name, marks, attributes });
        total += marks;
    }
    return { profiles: remaining, total };
}

/**
 * Carries the selected profiles across, and returns what it did.
 *
 * TRANSACTION SHAPE, which is what property 2 rests on. Per profile: the child
 * row and its attributes go in one transaction, so the journal never holds a
 * child nobody can name; then the marks go in batches, each its own transaction,
 * each pair whole. An interruption therefore leaves a complete child and a
 * PREFIX of their marks — a state the next run finishes, because it recomputes
 * the same ids and skips what it finds.
 */
export async function runImport({
    profiles,
    selectedProfileIds,
    authorParticipantId,
    now = Date.now(),
    today = null,
}) {
    const summary = {
        children: 0,
        attributes: 0,
        assertions: 0,
        confirmations: 0,
        skipped: 0,
    };
    if (!selectedProfileIds || selectedProfileIds.length === 0) return summary;

    const plans = await planImport({
        profiles,
        selectedProfileIds,
        authorParticipantId,
        now,
        today,
    });
    const present = await alreadyPresent(plans);

    for (const plan of plans) {
        const attributes = plan.attributes.filter((entry) => {
            if (!present.has(entry.id)) return true;
            summary.skipped += 1;
            return false;
        });
        const marks = plan.marks.filter((mark) => {
            if (!present.has(mark.assertionId)) return true;
            summary.skipped += mark.entries.length;
            return false;
        });
        if (attributes.length === 0 && marks.length === 0) continue;

        summary.children += 1;
        // The child row rides in the prelude of whichever transaction comes
        // first for this profile, so it exists before any foreign key needs it
        // and never lands in a transaction of its own.
        let prelude = [childRow(plan.subjectChildId, now)];

        if (attributes.length > 0) {
            await appendEntries(attributes, { prelude });
            summary.attributes += attributes.length;
            prelude = [];
        }

        const size = STORE_CONFIG.legacyImportProbeBatch;
        for (let at = 0; at < marks.length; at += size) {
            const batch = marks.slice(at, at + size);
            await appendEntries(
                batch.flatMap((mark) => mark.entries),
                { prelude }
            );
            prelude = [];
            summary.assertions += batch.length;
            summary.confirmations += batch.length;
        }
    }

    return summary;
}
