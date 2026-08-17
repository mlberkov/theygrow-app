// The family's history, and the seam between the two places it can live (A1-P4,
// re-seated on the store in L1-P4).
//
// WHAT THIS MODULE IS NOW. It holds the in-memory model — which children exist,
// which one is current, and which skills are marked — and it picks, once at
// boot, where that model comes from and where a change goes:
//
//   local        localStorage, through core/repo-local.js. The web channel.
//   journal      the encrypted native store, through store/repo-journal.js.
//   unavailable  running natively, but the store did not open.
//
// THE MODEL IS A PROJECTION, NEVER A STORE. On the journal backend the completed
// set is recomputed from the assertions after every write; nothing here is the
// authority for anything. On the localStorage backend it is what it always was.
// The distinction matters because PDR-025 §2 defines a mark as an attributed
// assertion, so "which skills are done" has to be derivable and not remembered.
//
// WHY THE FIVE READERS STAYED SYNCHRONOUS. `getCurrentProfile()` and
// `getCompletedSkills()` are called from inside `buildTableBody()`,
// `createSkillRow()`, `openSkillModal()`, `applyFilter()` and
// `getRelevantUncompletedSkills()` — synchronous DOM builders that return
// elements and strings. Making them async would have rewritten the render path
// and put every parity baseline at risk to no purpose, because what they read is
// a projection either way. So the ASYNC boundary is boot and write only, and it
// is exactly two functions wide.
//
// `profiles` and `currentProfileId` stay exported live bindings, assigned ONLY
// here, because surfaces/profile.js reads them directly.

import * as localRepo from './repo-local.js';
import { emitSignal } from './signals.js';
import { appendChild, appendMark, completedFrom, loadChildren, loadMarks } from '../store/boot.js';

export const BACKEND = Object.freeze({
    local: 'local',
    journal: 'journal',
    unavailable: 'unavailable',
});

// Состояние приложения
export let profiles = [];
export let currentProfileId = null;

let backend = BACKEND.local;
let selfParticipantId = null;
// The projected completed set for the current child. Rebuilt, never accumulated.
let completed = new Set();
// The projected rows behind it, consensus columns and all. Nothing reads the
// consensus yet — L7 owns that surface — but the projection carries it so that
// wiring it up later is wiring rather than a rewrite.
let markRows = [];

export function historyBackend() {
    return backend;
}

/** True when a mark can actually be recorded somewhere. */
export function canRecord() {
    return backend !== BACKEND.unavailable;
}

/**
 * Loads the family, from whichever side of the seam this channel has.
 *
 * `storeOutcome` is what `initNativeStore()` returned. A native run whose store
 * did not open lands on `unavailable` rather than quietly falling back to
 * localStorage: the fallback would re-open the second door this milestone exists
 * to close, and would leave the journal and the browser disagreeing with nothing
 * to reconcile them (ADR-015, ADR-043).
 */
export async function initHistory(storeOutcome = { opened: false, reason: 'not-native' }) {
    reportStoreOpen(storeOutcome);
    if (storeOutcome.opened) {
        backend = BACKEND.journal;
        selfParticipantId = storeOutcome.handle.selfParticipantId;
        profiles = await loadChildren();
    } else if (storeOutcome.reason === 'not-native') {
        backend = BACKEND.local;
        const loaded = localRepo.loadHistory();
        profiles = loaded.profiles;
        currentProfileId = loaded.currentProfileId;
        await refreshMarks();
        return;
    } else {
        backend = BACKEND.unavailable;
        profiles = [];
        currentProfileId = null;
        completed = new Set();
        markRows = [];
        return;
    }

    // The selected child is a POINTER, not history: which profile a parent was
    // last looking at is the same class of thing as the accordion state, and it
    // goes through the same single door (core/storage.js) on both channels. The
    // key is reused rather than added — on this backend its value is a child id.
    const remembered = localRepo.loadSelection();
    currentProfileId = profiles.find((p) => p.id === remembered)
        ? remembered
        : (profiles[0]?.id ?? null);
    await refreshMarks();
}

// The typed store failures, as the closed codes the taxonomy declares. Derived
// from the error CLASS rather than from its message: engine messages carry file
// paths and statement text, which is not what a diagnostic is allowed to keep.
const FAILURE_CLASS = Object.freeze({
    StoreUnavailableError: 'unavailable',
    StoreDiskFullError: 'disk_full',
    StoreCorruptError: 'corrupt',
});

function reportStoreOpen(storeOutcome) {
    const handle = storeOutcome.handle;
    if (storeOutcome.opened) {
        emitSignal('store.open', {
            outcome: 'opened',
            failure_class: 'none',
            freshly_created: handle.freshlyCreated,
            previous_run_clean: handle.previousRunClean,
            schema_version: handle.schemaVersion,
            open_ms: storeOutcome.openMs ?? null,
        });
        return;
    }
    if (storeOutcome.reason === 'not-native') {
        emitSignal('store.open', { outcome: 'not_native', failure_class: 'none' });
        return;
    }
    const failureClass = FAILURE_CLASS[storeOutcome.reason] ?? 'other';
    emitSignal('store.open', {
        outcome: 'failed',
        failure_class: failureClass,
        open_ms: storeOutcome.openMs ?? null,
    });
}

/** Recomputes the completed set for the current child from the journal. */
async function refreshMarks() {
    if (backend === BACKEND.journal) {
        markRows = currentProfileId ? await loadMarks({ childId: currentProfileId }) : [];
        completed = completedFrom(markRows);
        return;
    }
    const profile = getCurrentProfile();
    markRows = [];
    completed = new Set(profile ? profile.completedSkills || [] : []);
}

export function getCurrentProfile() {
    return profiles.find((p) => p.id === currentProfileId) || null;
}

/** The projected rows, for anything that needs more than "is it done". */
export function getMarkRows() {
    return markRows;
}

export function getCompletedSkills() {
    return new Set(completed);
}

/**
 * Records one mark, and returns whether it was actually recorded.
 *
 * Returns false rather than throwing when there is nowhere to put it, because
 * the caller has a checkbox to put back and a parent to tell (ADR-015). The two
 * ways it can fail — no child, and no store — are distinguished by
 * `canRecord()`, so the surface can say which one happened.
 */
export async function markSkill(skillId, observed) {
    if (backend === BACKEND.unavailable) return false;
    const profile = getCurrentProfile();
    if (!profile) return false;

    if (backend === BACKEND.journal) {
        await appendMark({
            authorParticipantId: selfParticipantId,
            subjectChildId: profile.id,
            skillId,
            observed,
        });
        await refreshMarks();
        return true;
    }

    completed = await localRepo.markSkill(profiles, profile, skillId, observed);
    return true;
}

/**
 * Writes a whole completed set at once.
 *
 * Kept because it is the parity suite's persist seam (app.js re-exports it and
 * app/tests/visual.spec.js drives it). On the journal backend it is expressed as
 * marks, one assertion each, because there is no other way to say it there — a
 * set is not something a parent asserts.
 */
export async function saveCompletedSkills(completedSet) {
    if (backend === BACKEND.unavailable) return false;
    const profile = getCurrentProfile();
    if (!profile) return false;

    if (backend === BACKEND.journal) {
        const wanted = new Set(completedSet);
        for (const skillId of wanted) {
            if (!completed.has(skillId)) await markSkill(skillId, true);
        }
        for (const skillId of completed) {
            if (!wanted.has(skillId)) await markSkill(skillId, false);
        }
        return true;
    }

    profile.completedSkills = [...completedSet];
    await localRepo.saveHistory(profiles);
    completed = new Set(completedSet);
    return true;
}

export async function createProfile(name, birthdate) {
    if (backend === BACKEND.unavailable) return null;
    if (backend === BACKEND.journal) {
        const childId = await appendChild({
            authorParticipantId: selfParticipantId,
            name,
            birthdate,
        });
        profiles = await loadChildren();
        return profiles.find((p) => p.id === childId) ?? null;
    }
    return localRepo.createChild(profiles, name, birthdate);
}

/** Assigns the current child and persists the choice; UI refreshes are the caller's. */
export async function setCurrentProfile(profileId) {
    currentProfileId = profileId;
    await localRepo.saveCurrent(profileId);
    await refreshMarks();
}

/** Re-reads the model after something outside this module changed the journal. */
export async function reloadHistory() {
    if (backend !== BACKEND.journal) return;
    profiles = await loadChildren();
    if (!profiles.find((p) => p.id === currentProfileId)) {
        currentProfileId = profiles[0]?.id ?? null;
        if (currentProfileId) await localRepo.saveCurrent(currentProfileId);
    }
    await refreshMarks();
}
