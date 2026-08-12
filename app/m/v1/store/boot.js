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
    appendEntry,
    projectSkillState,
    readSince,
} from './journal.js';

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
export async function initNativeStore() {
    if (!isNativeStore()) {
        return { opened: false, reason: 'not-native' };
    }
    try {
        handle = await openStore();
        return { opened: true, handle };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[store] the local store did not open:', error.name, error.message);
        return { opened: false, reason: error.name, message: error.message };
    }
}

// The journal primitives are re-exported here rather than imported directly by
// their eventual callers, for one structural reason: this module is the store's
// single entry point in the shell's import graph, and a module OUTSIDE that
// graph is a module the storage-seam scan (LSC-P1-INV-001) never reads. P4's
// write path calls these; P2 ships them unused and proven.
export { acknowledgeCursor, appendEntry, projectSkillState, readSince };
