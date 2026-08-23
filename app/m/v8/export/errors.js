// Typed export failures (L1-P3).
//
// The same reasoning store/errors.js gives: a caller that has to match on
// message text is a caller that breaks when the message is reworded, and the
// difference between "this platform cannot write files" and "the parent closed
// the picker" is the difference between an apology and silence.
//
// No message here ever carries family text. What reaches the console is the
// engine's own words plus a reason code.

export class ExportError extends Error {
    constructor(message, { method = null, cause = null } = {}) {
        super(message);
        this.name = 'ExportError';
        this.method = method;
        this.cause = cause;
    }
}

/** The sink is not reachable — the web channel, or a shell without the plugin. */
export class ExportUnavailableError extends ExportError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'ExportUnavailableError';
    }
}

/** The parent closed the file picker. Not a failure; a decision. */
export class ExportCancelledError extends ExportError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'ExportCancelledError';
    }
}
