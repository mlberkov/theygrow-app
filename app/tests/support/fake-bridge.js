'use strict';

// A recorder standing in for the injected Capacitor bridge (L1-P4).
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. `app/tests/store-unit.spec.js` says
// outright that pretending to cover the bridge with a fake would prove the fake
// rather than the plugin, and that rule is not relaxed here. This is deliberately
// NOT a database: it never executes SQL and it has no opinion about what a
// statement means. It records what the app ASKED for — which statements, with
// which values, grouped into which transactions, in which order — and answers
// reads from a script.
//
// So the split of duties across the suite is:
//
//   app/tests/schema/*.py   what the SQL MEANS, against real SQLite carrying the
//                           real frozen DDL (including the shipped projection
//                           query, read out of journal.js rather than retyped)
//   this recorder           what the app asks for, and its control flow: the
//                           append is one transaction; a re-run skips what is
//                           already there; an interrupted run resumes
//   android-instrumented    that the plugin and SQLCipher actually do it
//
// A claim that needs the second and third boxes at once does not belong in a
// spec that uses this file.

/**
 * Builds a fake `window.Capacitor`.
 *
 * `answer` maps a substring of a SQL statement to the rows a `query` returns, so
 * a test scripts reads by naming the query it means rather than by position.
 * `failOn` interrupts the Nth mutating call — the interruption the import has to
 * survive — and the recorder keeps every call made BEFORE the failure, because
 * what the next run must resume from is exactly that prefix.
 *
 * `rollbackFailsWith` makes the ROLLBACK fail too, with its OWN message. That is
 * not a curiosity: it is the shape a full disk actually produces, because SQLite
 * aborts the transaction itself on SQLITE_FULL and the ROLLBACK that follows
 * finds nothing to roll back (DIA-DL-007). A seam that reported the rollback's
 * message would tell a parent to retry when they need to free space.
 */
function createFakeBridge({
    answer = {},
    failOn = null,
    failWith = 'SQLITE_BUSY: interrupted',
    rollbackFailsWith = null,
} = {}) {
    const calls = [];
    let mutations = 0;

    const rowsFor = (statement) => {
        for (const [needle, rows] of Object.entries(answer)) {
            if (statement.includes(needle)) return rows;
        }
        return [];
    };

    const bridge = {
        isNativePlatform: () => true,
        nativePromise: async (plugin, method, options) => {
            calls.push({ plugin, method, options });
            if (method === 'query') {
                return { values: rowsFor(options.statement) };
            }
            if (method === 'rollbackTransaction' && rollbackFailsWith !== null) {
                calls[calls.length - 1].failed = true;
                throw new Error(rollbackFailsWith);
            }
            if (method === 'executeSet' || method === 'run' || method === 'execute') {
                mutations += 1;
                if (failOn !== null && mutations === failOn) {
                    // Recorded before it throws: the call was attempted, and a
                    // resumption test has to be able to see that it was.
                    calls[calls.length - 1].failed = true;
                    throw new Error(failWith);
                }
                return { changes: { changes: 1 } };
            }
            // beginTransaction / commitTransaction and anything else the seam
            // asks for resolve quietly; only the calls above carry an outcome a
            // spec reads.
            return {};
        },
    };

    return {
        bridge,
        calls,
        /** Every statement the app issued, flattened out of its transactions. */
        statements() {
            const out = [];
            for (const call of calls) {
                if (call.failed) continue;
                if (call.method === 'executeSet') {
                    for (const item of call.options.set) {
                        out.push({ statement: item.statement, values: item.values });
                    }
                } else if (call.method === 'run') {
                    out.push({ statement: call.options.statement, values: call.options.values });
                }
            }
            return out;
        },
        /**
         * One entry per transaction, so "these went together" is assertable.
         *
         * `transaction` answers "was this set atomic", which since DIA-DL-007 is
         * no longer the same question as "what flag did the app pass". The seam
         * now drives the transaction itself — beginTransaction, the set with
         * `transaction: false`, commitTransaction — so atomicity is read off the
         * ENVELOPE the app issued, and reads true only if the envelope actually
         * committed. A set the app sent with the wrapper's own flag still counts,
         * which is what keeps the `run`-driven call sites readable here too.
         */
        transactions() {
            const out = [];
            let open = false;
            for (const call of calls) {
                if (call.method === 'beginTransaction' && !call.failed) open = true;
                if (call.method === 'executeSet' && !call.failed) {
                    out.push({
                        transaction: open || call.options.transaction === true,
                        statements: call.options.set.map((item) => item.statement),
                        values: call.options.set.map((item) => item.values),
                        committed: false,
                    });
                }
                if (call.method === 'commitTransaction' && !call.failed) {
                    open = false;
                    if (out.length > 0) out[out.length - 1].committed = true;
                }
                if (call.method === 'rollbackTransaction') open = false;
            }
            return out;
        },
        mutationCount() {
            return calls.filter(
                (call) => ['executeSet', 'run', 'execute'].includes(call.method) && !call.failed
            ).length;
        },
    };
}

/**
 * Runs `fn` with the fake bridge installed as `window.Capacitor`, then removes it.
 *
 * Restoring is not tidiness: `store-unit.spec.js` asserts the store modules are
 * import-safe with NO `window` at all, and Playwright reuses a worker process
 * across spec files. A leaked global would turn that assertion red in a file
 * that never mentioned it.
 */
async function withFakeBridge(fake, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previous = globalThis.window;
    globalThis.window = { Capacitor: fake.bridge };
    try {
        return await fn();
    } finally {
        if (had) {
            globalThis.window = previous;
        } else {
            delete globalThis.window;
        }
    }
}

module.exports = { createFakeBridge, withFakeBridge };
