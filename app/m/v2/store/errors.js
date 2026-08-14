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
