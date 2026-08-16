// Typed failures of the history transfer (DIA-P1).
//
// Same shape and same reason as store/errors.js and export/errors.js: the
// control-flow CLASS is what callers branch on and what a signal may carry,
// never an engine message. A message can hold a path, a URI or a fragment of
// what a parent wrote; a closed code cannot (AGENTS.md §4, LSC-P4-INV-003).
//
// Every `reason` below is a member of the closed `refusal` code list declared in
// core/signals.js. That is not a coincidence to preserve by hand — the codes are
// the payload vocabulary, and a reason with no code is a reason no signal can
// report.

/**
 * The transfer envelope could not be read, or is not one.
 *
 * `reason` is the closed code; `message` is for the device console only and is
 * never handed to a signal.
 */
export class TransferFormatError extends Error {
    constructor(message, { reason = 'format_version', ...rest } = {}) {
        super(message);
        this.name = 'TransferFormatError';
        this.reason = reason;
        Object.assign(this, rest);
    }
}
