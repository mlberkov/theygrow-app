// The client-side signal surface (L1-P4).
//
// READ THIS BEFORE ADDING A SIGNAL. Three facts about this module are the whole
// reason it looks the way it does, and the third one is the one that will matter
// to you:
//
//   1. THIS PACKET CREATED THIS SURFACE. There was no client-side signal
//      taxonomy before L1-P4. `emitted_now` existed only in
//      api/theygrow_api/signals.py, which belongs to the server side this
//      milestone does not touch, and the only telemetry in app/ was the inline
//      GA4 shim in index.html. So there is no precedent here to follow except
//      what is written down in this file.
//
//   2. ITS ONLY SINK IS THE DEVICE CONSOLE. Nothing here leaves the device.
//      A signal is a line in `adb logcat` during the RUNBOOK smoke, and that is
//      all it is.
//
//   3. GIVING IT A NETWORK SINK IS A SEPARATE OWNER DECISION, AND IT IS ON THE
//      ESCALATION LIST (PDR-027 §2 — public exposure and egress). It is not a
//      refactor, it is not an implementation detail of "wiring up telemetry",
//      and it is not yours or mine to take while adding a signal. If you are
//      here because you want these signals somewhere you can read them
//      remotely: stop, and ask. app/tests/signal-payload.spec.js asserts the
//      absence of a network leg, so the guard will stop you anyway — this
//      paragraph exists so that you know it is a decision rather than an
//      obstacle.
//
// WHY THE PAYLOAD GUARD IS STRUCTURAL RATHER THAN A REVIEW HABIT. §4 says a
// signal carries counts, ids and timings and never family text. A rule like that
// survives exactly as long as everyone remembers it. So this module does not
// accept a value it cannot prove safe: a value must be a number, a boolean,
// null, or a member of the closed code list declared for its field. There is no
// code path that accepts a free string, which means a payload CANNOT carry a
// child's name or anything a parent wrote — not "does not", cannot.
//
// A REFUSAL IS SILENT TO THE CALLER AND LOUD TO THE TESTS. emitSignal never
// throws: a telemetry bug must not take the write path down with it. It returns
// false and counts the refusal, and the counter is what the spec asserts on.

// Closed code lists, keyed by FIELD. A field named here may only ever carry one
// of these strings; any other string is refused.
export const SIGNAL_CODES = Object.freeze({
    outcome: Object.freeze([
        'opened',
        'not_native',
        'failed',
        'complete',
        'interrupted',
        'nothing_selected',
    ]),
    // The typed store failures from store/errors.js, as codes. Derived from the
    // control-flow class rather than from an exception message, because engine
    // messages carry file paths and statement text.
    failure_class: Object.freeze([
        'none',
        'unavailable',
        'disk_full',
        'corrupt',
        'other',
    ]),
    reason: Object.freeze(['no_subject', 'store_unavailable', 'write_failed']),
});

export const SIGNAL_TAXONOMY = Object.freeze({
    // changed_in: LSC-DL-004 — the store-open outcome. LSC-DL-002 declined to
    // declare this one, on the stated grounds that there was no write path yet
    // for a signal to describe. There is now.
    //
    // `previous_run_clean` will report false on every launch but the first,
    // because closeStore() is defined and never called, so clean_shutdown is
    // never set back to 1. That is a true fact about the store and the signal
    // reports it; the cause is recorded as a side-find rather than fixed here.
    'store.open': Object.freeze({
        fields: Object.freeze([
            'outcome',
            'failure_class',
            'freshly_created',
            'previous_run_clean',
            'schema_version',
            'open_ms',
        ]),
        boolean: Object.freeze(['freshly_created', 'previous_run_clean']),
        numeric: Object.freeze([]),
        producingStage: 'L1-P4',
        emittedNow: true,
    }),

    // changed_in: LSC-DL-004 — what the legacy import did. Counts only: how many
    // children, attributes, assertions and confirmations were appended and how
    // many were skipped because they were already there. Never a skill id, never
    // a name, never which child.
    'history.import': Object.freeze({
        fields: Object.freeze([
            'outcome',
            'children',
            'attributes',
            'assertions',
            'confirmations',
            'skipped',
            'import_ms',
        ]),
        boolean: Object.freeze([]),
        numeric: Object.freeze([
            'children',
            'attributes',
            'assertions',
            'confirmations',
            'skipped',
        ]),
        producingStage: 'L1-P4',
        emittedNow: true,
    }),

    // changed_in: LSC-DL-004 — a mark that was refused rather than recorded
    // (ADR-015). The reason is a closed code; the skill it was about is
    // deliberately absent, because which skills a parent is trying to mark is
    // exactly the shape of family data a diagnostic must not accumulate.
    'write.refused': Object.freeze({
        fields: Object.freeze(['reason']),
        boolean: Object.freeze([]),
        numeric: Object.freeze([]),
        producingStage: 'L1-P4',
        emittedNow: true,
    }),

    // changed_in: XPT-DL-001 — what one export did. It exists because the defect
    // XPT-P1 repairs was INVISIBLE from the device: the process died while the
    // file picker was in front, so the app printed nothing, the surface showed
    // nothing, and the only evidence was a 0-byte file with the right name. The
    // owner-run device smoke is the one leg no test can automate (nothing here
    // drives the system picker), and this line is what that leg reads.
    //
    // Counts and timings only. `archive_bytes` is a size, not content; `chunks`
    // is how many bridge calls the archive travelled in, which is the number
    // that says the transfer went in pieces rather than in one parcel. There is
    // deliberately no filename and no URI: both name a place in the parent's
    // filesystem, and a document they picked is not ours to describe out loud.
    'export.run': Object.freeze({
        fields: Object.freeze(['outcome', 'archive_bytes', 'chunks', 'export_ms']),
        boolean: Object.freeze([]),
        numeric: Object.freeze(['archive_bytes', 'chunks', 'export_ms']),
        producingStage: 'XPT-P1',
        emittedNow: true,
    }),
});

let refusals = 0;

/** How many payloads have been refused. The spec asserts on this. */
export function signalRefusals() {
    return refusals;
}

/** Whether one value is something this surface is willing to say out loud. */
function valueIsSafe(field, value) {
    if (value === null) return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') {
        const codes = SIGNAL_CODES[field];
        return Array.isArray(codes) && codes.includes(value);
    }
    // Objects, arrays, functions, undefined, symbols: refused. An object is how
    // free text arrives without looking like free text.
    return false;
}

function payloadIsSafe(descriptor, payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
    for (const field of Object.keys(payload)) {
        if (!descriptor.fields.includes(field)) return false;
        if (!valueIsSafe(field, payload[field])) return false;
    }
    return true;
}

/**
 * The default sink: one line on the device console, and nowhere else.
 *
 * See fact 3 in this module's header before changing this.
 */
function consoleSink(line) {
    // eslint-disable-next-line no-console
    console.info(line);
}

/**
 * Emits one signal, or refuses it.
 *
 * Returns true when the signal was handed to the sink, false when it was
 * refused. Never throws — not for an undeclared kind, not for an unsafe
 * payload, and not when the sink itself fails.
 */
export function emitSignal(kind, payload, { sink = consoleSink } = {}) {
    const descriptor = SIGNAL_TAXONOMY[kind];
    if (!descriptor || !descriptor.emittedNow || !payloadIsSafe(descriptor, payload)) {
        refusals += 1;
        return false;
    }
    try {
        const parts = descriptor.fields
            .filter((field) => Object.prototype.hasOwnProperty.call(payload, field))
            .map((field) => `${field}=${payload[field]}`);
        sink(`[signal] ${kind} ${parts.join(' ')}`);
        return true;
    } catch (error) {
        // A sink that throws is a broken sink, not a broken write path.
        return false;
    }
}
