// Native-store boot (L1-P2).
//
// This module ships to BOTH channels byte-identically (LSC-P1-INV-002), so on
// the PWA it must do nothing at all: no storage of any kind is touched, no
// request is made, and initNativeStore() returns a stated reason instead of a
// side effect. The PWA keeps its localStorage until an explicit owner action
// imports it (P4) — and that import will not mutate or delete it, because the
// live PWA holds the only copy of this family's history.
//
// P2 opens the store and leaves it open. It deliberately writes NO family data:
// the write path, the localStorage import and the legacy-mark migration are P4.

import { isNativeStore, openStore } from './store.js';
import {
    acknowledgeCursor,
    appendEntries,
    appendEntry,
    existingEntryIds,
    projectSkillState,
    readSince,
} from './journal.js';
import {
    appendChild,
    appendMark,
    childRow,
    completedFrom,
    loadChildren,
    loadMarks,
} from './repo-journal.js';
import { storeFailureCode } from './errors.js';
import { createRecord, loadRecords, overwriteRecord } from './records.js';
import { pendingImport, runImport } from './import-legacy.js';
import {
    discardTransfer,
    drainTransfer,
    isTransferAvailable,
    openHandoff,
    pendingTransfer,
    pickTransfer,
} from './transfer.js';

let handle = null;

/** The open store handle, or null when the store was never opened. */
export function storeHandle() {
    return handle;
}

/**
 * Opens the native store when running inside the Capacitor shell.
 *
 * Never throws: a store that cannot open must not take the app down with it —
 * the tracker still works off localStorage until P4 moves it. The failure is
 * returned as a value and logged once, so it is visible in `adb logcat` during
 * the RUNBOOK smoke without inventing a telemetry surface for it (no child PII
 * can appear here: the reason carries an engine message, never family text).
 */
export async function initNativeStore({ now = () => Date.now() } = {}) {
    if (!isNativeStore()) {
        return { opened: false, reason: 'not-native' };
    }
    // Timed here rather than at the call site: this is the only place that knows
    // where the open began, and L1-P4 declares an `open_ms` signal about it.
    const startedAt = now();
    try {
        handle = await openStore();
        return { opened: true, handle, openMs: now() - startedAt };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[store] the local store did not open:', error.name, error.message);
        return {
            opened: false,
            reason: error.name,
            message: error.message,
            openMs: now() - startedAt,
        };
    }
}

// The journal primitives are re-exported here rather than imported directly by
// their eventual callers, for one structural reason: this module is the store's
// single entry point in the shell's import graph, and a module OUTSIDE that
// graph is a module the storage-seam scan (LSC-P1-INV-001) never reads. P4's
// write path calls these; P2 shipped them unused and proven.
//
// L1-P4 adds the repository half for the same reason: core/state.js reaches the
// journal through this one door, so store/ keeps exactly one entrance from core/
// and the seam scan keeps reaching everything behind it.
// DIA-P1 adds the transfer seam for the same reason: surfaces/import.js reaches
// it through this one door, so store/ keeps exactly one entrance from the
// surfaces layer and the storage-seam scan (LSC-P1-INV-001) keeps reaching
// everything behind it. The seam itself touches no Web Storage at all — it
// drains bytes the native side staged — but a module outside the walked graph
// is a module that guard never reads, and that is the property being kept.
// DIA-P3 adds the diary record path on the same terms: surfaces/diary.js reaches
// createRecord / overwriteRecord / loadRecords through this door and never
// imports store/records.js itself.
export {
    acknowledgeCursor,
    appendChild,
    appendEntries,
    appendEntry,
    appendMark,
    childRow,
    completedFrom,
    createRecord,
    discardTransfer,
    drainTransfer,
    existingEntryIds,
    isTransferAvailable,
    loadChildren,
    loadMarks,
    loadRecords,
    openHandoff,
    overwriteRecord,
    pendingImport,
    pendingTransfer,
    pickTransfer,
    projectSkillState,
    readSince,
    runImport,
    storeFailureCode,
};
