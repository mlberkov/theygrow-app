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

export async function callPlugin(method, options = {}) {
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
    await callPlugin('beginTransaction', { database });
    try {
        const result = await callPlugin('executeSet', options);
        await callPlugin('commitTransaction', { database });
        return result;
    } catch (failure) {
        await callPlugin('rollbackTransaction', { database }).catch(() => {});
        throw failure;
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
