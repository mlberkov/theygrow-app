// The native bridge seam (L1-P2).
//
// WHY THERE IS NO IMPORT FROM node_modules HERE. Capacitor's native layer
// INJECTS its bridge into the WebView before the app boots: @capacitor/android
// 8.5.0 ships capacitor/src/main/assets/native-bridge.js, which defines
// Capacitor.nativePromise(pluginName, methodName, options), and plugin
// registration happens natively through capacitor.plugins.json. A plugin is
// therefore callable with zero JavaScript from node_modules — which is what
// keeps BOTH delivery channels buildless and byte-identical (LSC-P1-INV-002,
// ADR-037). See LSC-DL-002 for the named exit point from buildless, and why it
// is a vendoring rule rather than a bundler.
//
// On the web this module is inert: isNativeStore() is false, every call throws
// StoreUnavailableError, and nothing here touches WebView storage of any kind
// (LSC-P1-INV-001).

import { ALLOWED_PLUGIN_METHODS, STORE_CONFIG } from './config.js';
import { classifyStoreFailure, StoreError, StoreUnavailableError } from './errors.js';

const PLUGIN_NAME = 'CapacitorSQLite';

function capacitor() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor ?? null;
}

// True only inside the Capacitor WebView, with the injected bridge present.
// Both halves matter: a stubbed Capacitor global without nativePromise would
// otherwise look like a native platform and fail later, deeper, and less legibly.
export function isNativeStore() {
    const cap = capacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    return typeof cap.nativePromise === 'function';
}

// --- the park gate (FIU-P1) -----------------------------------------------
//
// WHY THIS EXISTS. Until L3 the store was opened at boot and left open forever,
// because `closeStore()` was defined and never called (DIA-DL-008 debt 8). It
// is called now, when the app goes to the background — which means there is a
// state this module never had to model: the connection is CLOSED while the page
// is still alive, its module graph loaded and its handlers wired. A parent who
// unlocks their phone and taps the diary must not meet a refusal because the
// store has not been reopened yet, so an ordinary call made in that state waits
// for the reopen instead of failing.
//
// THE GATE IS HERE AND NOT IN store/boot.js FOR ONE CONCRETE REASON. boot.js is
// the door almost every shipped store call path goes through — but not all of
// them: export/readout.js imports `query` from THIS module directly. A gate on
// the door would leave the export path ungated, and the export path is the one
// that reads the whole journal.
//
// HOW A LIFECYCLE TRANSITION AVOIDS DEADLOCKING ON ITS OWN GATE, and why the
// answer is a SEPARATE ENTRY POINT rather than a flag. `openStore()` and
// `closeStore()` are made OF calls to this module, so a gate that made them wait
// for themselves would hang. A module-level "a transition is running" flag does
// not fix that: JavaScript has no dynamic scoping, so such a flag exempts every
// call that happens to run while the transition is awaiting — including an
// ordinary read issued by a render, which would then reach a half-open store.
// The exemption has to be about WHO is calling, and the only way to say that in
// this language is a different function. Hence `lifecycleBridge` below.
//
// It costs nothing to keep honest: store/store.js contains open-path and
// close-path code and NOTHING else — its only other exports, `mintId` and
// `derivedId`, touch no bridge at all — so the whole file switches entry point
// with one import line and not one statement of its body changes. In particular
// the five `run` sites DIA-DL-008 debt 1 names are left exactly as they were,
// including their `transaction = true` default: that debt is inventoried at five
// addresses and a partial fix here would make the inventory false.

// True while the connection is closed and the next ordinary call must reopen it.
let parked = false;

// The lifecycle transition currently holding the bridge, for ordinary callers to
// await. Null when there is none.
let pending = null;

// How many ordinary calls are in flight. `executeSet`'s transaction path counts
// as ONE for its whole begin/execute/commit sequence, not three: between the
// BEGIN resolving and the next statement being issued the count would otherwise
// touch zero, and a park that landed there would ask the wrapper to close a
// database that is still in a transaction — which it refuses, with a message
// about the transaction rather than about the close.
let inFlight = 0;
const idleWaiters = [];

// Supplied by store/boot.js, which owns the handle a reopen has to refresh.
// Null on the web, where nothing ever parks.
let reopener = null;

/** Registers what a reopen means. Called once, by store/boot.js. */
export function registerStoreReopener(fn) {
    reopener = fn;
}

/** True when the connection is closed and awaiting its first call back. */
export function storeIsParked() {
    return parked;
}

/** Records that the connection is now closed (or open again). */
export function setStoreParked(value) {
    parked = Boolean(value);
}

/** Resolves once no ordinary call is in flight. */
export function whenBridgeIdle() {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
        idleWaiters.push(resolve);
    });
}

function enterCall() {
    inFlight += 1;
}

function leaveCall() {
    inFlight -= 1;
    if (inFlight === 0) {
        while (idleWaiters.length > 0) {
            idleWaiters.pop()();
        }
    }
}

/**
 * Runs one lifecycle transition with the bridge reserved.
 *
 * Serialised against every other transition: two parks, or a park racing an
 * unpark, would otherwise interleave `close` and `createConnection` on the same
 * database — and the wrapper answers the second `createConnection` with
 * "Connection theygrow already exists", which reaches a parent as a store that
 * did not open.
 */
export async function reserveBridge(transition) {
    while (pending) {
        await pending;
    }
    let settle;
    pending = new Promise((resolve) => {
        settle = resolve;
    });
    try {
        return await transition();
    } finally {
        const done = settle;
        pending = null;
        done();
    }
}

// What an ordinary call does before it reaches the plugin. Lifecycle traffic
// never arrives here — it uses `lifecycleBridge` — so there is no exemption to
// get wrong: wait out any transition, and if the connection is parked, reopen it
// once and let everyone waiting on that reopen through together.
async function passGate(method) {
    while (pending) {
        await pending;
    }
    if (!parked) return;
    if (typeof reopener !== 'function') {
        throw new StoreUnavailableError(
            `the store is parked and no reopener was registered (method "${method}")`,
            { method }
        );
    }
    await reserveBridge(async () => {
        await reopener();
        parked = false;
    });
}

// The ungated core. Everything below it, and `lifecycleBridge`, are shapes.
async function dispatch(method, options) {
    if (!ALLOWED_PLUGIN_METHODS.includes(method)) {
        throw new StoreError(`plugin method "${method}" is outside the declared allowlist`);
    }
    const cap = capacitor();
    if (!isNativeStore()) {
        throw new StoreUnavailableError(
            `the native store is unavailable on this platform (method "${method}")`,
            { method }
        );
    }
    try {
        return await cap.nativePromise(PLUGIN_NAME, method, options);
    } catch (reason) {
        throw classifyStoreFailure(reason, method);
    }
}

export async function callPlugin(method, options = {}) {
    await passGate(method);
    enterCall();
    try {
        return await dispatch(method, options);
    } finally {
        leaveCall();
    }
}

/**
 * The same four shapes, for the open and close paths only.
 *
 * Not a second bridge and not a wider capability: identical dispatch, identical
 * allowlist, identical failure classification. The single difference is that
 * these do not consult the park gate, because they are what the gate opens and
 * closes. `store/store.js` imports them under the plain names, so its body reads
 * as it always did; nothing else in the shipped tree may import them.
 */
export const lifecycleBridge = Object.freeze({
    call: (method, options = {}) => dispatch(method, options),

    execute: (statements, { transaction = true } = {}) =>
        dispatch('execute', { database: STORE_CONFIG.databaseName, statements, transaction }),

    run: (statement, values = [], { transaction = true } = {}) =>
        dispatch('run', {
            database: STORE_CONFIG.databaseName,
            statement,
            values,
            transaction,
        }),

    query: async (statement, values = []) => {
        const result = await dispatch('query', {
            database: STORE_CONFIG.databaseName,
            statement,
            values,
        });
        return result?.values ?? [];
    },

    pragma: async (statement) => {
        const result = await dispatch('query', {
            database: STORE_CONFIG.databaseName,
            statement,
            values: [],
        });
        const rows = result?.values ?? [];
        return rows.length > 0 ? Object.values(rows[0])[0] : null;
    },
});

// --- the four shapes every caller uses -----------------------------------

export function execute(statements, { transaction = true } = {}) {
    return callPlugin('execute', {
        database: STORE_CONFIG.databaseName,
        statements,
        transaction,
    });
}

// THE SEAM DRIVES THE TRANSACTION, AND THE WRAPPER IS TOLD NOT TO.
//
// changed_in: DIA-DL-007. The wrapper's executeSet ends like this
// (@capacitor-community/sqlite, android/…/SQLite/Database.java:483-487):
//
//     } catch (Exception e) {
//         throw new Exception(e.getMessage());
//     } finally {
//         if (_db != null && transaction && _db.inTransaction()) rollbackTransaction();
//     }
//
// A `finally` that throws DISCARDS the exception the `catch` was carrying. And
// on a full disk the rollback is exactly what throws: SQLite aborts the
// transaction itself on SQLITE_FULL, so the ROLLBACK that follows finds no
// transaction and fails with code 1. What crosses the bridge is then
// "ExecuteSet: Failed in rollbackTransaction…", which carries none of
// DISK_FULL_MARKERS — measured, run 31979084821, 23:30:40.036-40.038.
//
// Nothing else survives to classify from. The bridge payload has exactly one
// field under `error` — a message; the wrapper rethrows with `new
// Exception(e.getMessage())`, so no cause is chained; and there is no code.
//
// So the rule this function exists to enforce: THE FAILURE THAT CAUSED THE
// ROLLBACK OUTRANKS THE ROLLBACK'S OWN FAILURE. We keep the atomicity — the
// diary's area and its first record still go together, a mark's entries still
// go together — and we keep the engine's own words, because our rollback's
// failure is swallowed rather than allowed to speak for the write.
//
// `beginTransaction` is outside the try on purpose: if BEGIN itself fails there
// is no transaction to roll back, and attempting one would reintroduce exactly
// the masking this removes.
export async function executeSet(set, { transaction = true } = {}) {
    const options = { database: STORE_CONFIG.databaseName, set, transaction: false };
    if (!transaction) return callPlugin('executeSet', options);

    const database = STORE_CONFIG.databaseName;
    // Counted as ONE in-flight unit for the whole sequence — see the comment on
    // `inFlight` above for what a park landing between the statements would do.
    enterCall();
    try {
        await callPlugin('beginTransaction', { database });
        try {
            const result = await callPlugin('executeSet', options);
            await callPlugin('commitTransaction', { database });
            return result;
        } catch (failure) {
            await callPlugin('rollbackTransaction', { database }).catch(() => {});
            throw failure;
        }
    } finally {
        leaveCall();
    }
}

// `transaction` defaults true for the shape's sake, but a single statement is
// already atomic — SQLite wraps it in an implicit transaction — so asking the
// wrapper for one buys nothing and re-opens the masking window documented above:
// runSQL carries the identical `finally` (Database.java:637). Callers that write
// one statement should pass `{ transaction: false }`.
//
// NAMED DEBT, DIA-DL-007: store/store.js still relies on the default at
// store.js:133, 160, 164, 172 and 238. Those are writes on the OPEN path, so a
// masked failure there makes `store.open`'s failure_class wrong at boot — the
// same harm one layer earlier. Deferred, not lost.
export function run(statement, values = [], { transaction = true } = {}) {
    return callPlugin('run', {
        database: STORE_CONFIG.databaseName,
        statement,
        values,
        transaction,
    });
}

// The wrapper requires `values` even when there are none, and returns
// { values: [...] }. Both quirks are absorbed here so no call site repeats them.
export async function query(statement, values = []) {
    const result = await callPlugin('query', {
        database: STORE_CONFIG.databaseName,
        statement,
        values,
    });
    return result?.values ?? [];
}

// PRAGMAs that return a row (journal_mode, integrity_check, user_version) must
// go through query(): the wrapper hands execute() to execSQL, which refuses a
// statement that yields rows.
export async function pragma(statement) {
    const rows = await query(statement);
    return rows.length > 0 ? Object.values(rows[0])[0] : null;
}
