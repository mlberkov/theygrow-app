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
//
// L3-P1 GIVES "LEAVES IT OPEN" AN END (FIU-DL-001). `closeStore()` had been
// defined and never called since L1-P2, which is not the tidiness item it reads
// as: `openStore()` clears `clean_shutdown` on every open and only `closeStore()`
// ever set it back, so `integrityCheckPolicy: 'after-unclean-shutdown'` meant
// "always" and every launch paid a full `PRAGMA integrity_check` over the
// family's whole history. The call site is `parkNativeStore()` below, driven by
// the page going hidden — which is the disposition DIA-DL-008 debt 8 asked for,
// one that does NOT rest on whether the Android WebView fires `pagehide` before
// the process dies. What it rests on instead is measured on a device by
// `StoreLifecycleTest`, not assumed here.

import { closeStore, isNativeStore, openStore } from './store.js';
import {
    registerStoreReopener,
    reserveBridge,
    setStoreParked,
    storeIsParked,
    whenBridgeIdle,
} from './bridge.js';
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
import { createRecord, loadRecords, overwriteRecord, searchRecords } from './records.js';
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

/**
 * The store handle, or null when the store was never opened.
 *
 * A PARKED STORE STILL ANSWERS WITH ITS HANDLE, and that is deliberate. Four
 * shipped call sites treat a null handle as "this device has no store" and take
 * a different branch entirely — export/run.js, and three in surfaces/import.js.
 * Nulling the handle on a park would make a backgrounded app look, for a moment
 * after it came back, like an app that had never had a store. What the handle
 * describes is the store this device HAS; whether its connection is open right
 * now is `storeIsParked()`, and no surface needs to ask.
 */
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

// Who hears about a reopen. See onStoreReopened below for why it is handed down
// rather than reached up for.
let reopenReporter = null;

/**
 * Reopens the store after a park, and refreshes the handle with what it says.
 *
 * Registered with the bridge at module load rather than called from anywhere:
 * the gate down there is what decides a reopen is owed, because it is what sees
 * the first call that needs one. Registration is unconditional and harmless on
 * the web, where nothing ever parks.
 *
 * The reopen is TIMED and reported on the same terms as the boot open, so the
 * cost of this design is on the record rather than argued about: every resume
 * that touches the store puts an `open_ms` on the device log beside a
 * `previous_run_clean` that should now read true.
 */
registerStoreReopener(async () => {
    const startedAt = Date.now();
    handle = await openStore();
    if (typeof reopenReporter === 'function') {
        reopenReporter({ opened: true, handle, openMs: Date.now() - startedAt });
    }
});

/**
 * Closes the store cleanly, for a page that is going away.
 *
 * WHAT THE CLOSE IS FOR, in one sentence, because "closing a connection" sounds
 * like housekeeping and is not: `closeStore()` sets `clean_shutdown = 1`, and
 * that marker is the whole input to the next open's decision about whether
 * `PRAGMA integrity_check` — a full scan of the family's history — is owed.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE. The bridge is reserved first, so no new
 * ordinary call can start; then the calls already in flight are allowed to
 * finish (`whenBridgeIdle`), because closing under a live transaction is
 * refused by the wrapper with a message about the transaction; then the store is
 * closed; and only THEN is the parked flag raised. A close that throws leaves
 * the flag down, which is the truthful state: the connection is still open, and
 * the app carries on exactly as it did before this packet.
 *
 * Never throws, for the reason initNativeStore never throws — a lifecycle
 * housekeeping failure must not take the page down. It returns what happened.
 */
export async function parkNativeStore({ now = () => Date.now() } = {}) {
    if (!isNativeStore()) return { parked: false, reason: 'not-native' };
    if (handle === null) return { parked: false, reason: 'never-opened' };
    if (storeIsParked()) return { parked: false, reason: 'already-parked' };

    const startedAt = now();
    try {
        await reserveBridge(async () => {
            await whenBridgeIdle();
            await closeStore();
            setStoreParked(true);
        });
        return { parked: true, closeMs: now() - startedAt };
    } catch (error) {
        return {
            parked: false,
            reason: error.name,
            message: error.message,
            closeMs: now() - startedAt,
        };
    }
}

/**
 * Registers who hears about a reopen.
 *
 * The reopen happens deep in the gate, under whichever call happened to need the
 * store first, and the module that reports store lifecycle to the signal channel
 * is core/state.js. Rather than let store/ reach up into core/ for an emitter,
 * the reporter is handed down. Optional by construction: a build that registers
 * nothing still reopens.
 */
export function onStoreReopened(report) {
    reopenReporter = typeof report === 'function' ? report : null;
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
// imports store/records.js itself. DIA-P4 adds searchRecords beside them — the
// same door, and deliberately not a second one, because the storage-seam scan
// walks THIS graph and a module reached any other way is a module it never
// reads.
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
    searchRecords,
    storeFailureCode,
};
