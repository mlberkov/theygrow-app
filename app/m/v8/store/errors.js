// Typed store failures (L1-P2).
//
// WHY TYPES AND NOT MESSAGES. A journal that silently fails to record an
// observation breaks the single source of truth invisibly, which is worse than
// a crash (ADR-046 §1). The write path must be able to tell "the disk is full"
// from "the schema is wrong" from "the passphrase is wrong" WITHOUT parsing a
// sentence at the call site — the P4 write path reports the first honestly to
// the parent and must never swallow it.
//
// The wrapper rejects with a plain string message (RetHandler.call.reject), so
// classification happens once, here, and the raw message is preserved on the
// error for the RUNBOOK rather than being thrown away.

export class StoreError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'StoreError';
        this.method = options.method ?? null;
        this.cause = options.cause ?? null;
    }
}

// The disk is full. Named explicitly because it is the failure that must reach
// the parent as itself: their observation was NOT recorded.
export class StoreDiskFullError extends StoreError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'StoreDiskFullError';
    }
}

// The store opened but its bytes are not trustworthy (integrity_check failed).
export class StoreCorruptError extends StoreError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'StoreCorruptError';
    }
}

// The native side is not reachable: no bridge, or the plugin is not registered.
export class StoreUnavailableError extends StoreError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'StoreUnavailableError';
    }
}

// The typed failures above, as the closed codes a diagnostic may carry. Derived
// from the error CLASS, never from its message: engine messages carry file paths
// and statement text, which is not what a diagnostic is allowed to keep.
//
// changed_in: DIA-DL-005 — moved here from core/state.js, where it was a private
// map serving the OPEN path alone. Two write paths need it now — the diary
// entry (DIA-P3) and the mark tick, which collapses every failure into one code
// today — and a second copy of a closed list is a second thing to drift. The
// one-mapping-point rule it states was stated first by store/transfer.js, for
// the transfer plugin's refusal codes; that module was retired at PPR-P2 and the
// rule outlived it.
//
// This list must stay a subset of SIGNAL_CODES.failure_class in
// core/signals.js. It is not imported from there on purpose: store/ has no edge
// into core/ and gaining one for a constant would be a layering change. The two
// are asserted to agree by app/tests/diary-write.spec.js — which since PPR-P2 is
// the only guard left pairing them, the transfer seam's mirrored refusal list
// having gone with the mechanism.
export const STORE_FAILURE_CODES = Object.freeze([
    'unavailable',
    'disk_full',
    'corrupt',
    'other',
]);

const FAILURE_CODE_BY_CLASS = Object.freeze({
    StoreUnavailableError: 'unavailable',
    StoreDiskFullError: 'disk_full',
    StoreCorruptError: 'corrupt',
});

/**
 * The closed code for a store failure, from an error or from its class name.
 *
 * Accepts either because the two callers hold different things: the open path
 * kept only `error.name` across an async boundary (store/boot.js returns it as
 * `reason`), while a write path has the error itself. Shaped as a UNARY function
 * of one value so it can be used directly as a rejection handler —
 * `markSkill(...).catch(storeFailureCode)` — which is how the mark surface will
 * reach it without a second refactor.
 *
 * Anything it cannot name is 'other', never a guess and never a free string.
 */
export function storeFailureCode(reason) {
    const name = typeof reason === 'string' ? reason : reason?.name;
    return FAILURE_CODE_BY_CLASS[name] ?? 'other';
}

const DISK_FULL_MARKERS = ['sqlite_full', 'database or disk is full', 'disk is full'];
const CORRUPT_MARKERS = ['sqlite_corrupt', 'database disk image is malformed', 'file is not a database'];

// Maps a wrapper rejection onto one of the types above. Exported for the unit
// spec: the classifier is the one piece of this module worth testing off-device.
export function classifyStoreFailure(reason, method) {
    const raw = reason instanceof Error ? reason.message : String(reason ?? '');
    const text = raw.toLowerCase();
    const options = { method, cause: reason };

    if (DISK_FULL_MARKERS.some((marker) => text.includes(marker))) {
        return new StoreDiskFullError(raw, options);
    }
    if (CORRUPT_MARKERS.some((marker) => text.includes(marker))) {
        return new StoreCorruptError(raw, options);
    }
    return new StoreError(raw, options);
}
