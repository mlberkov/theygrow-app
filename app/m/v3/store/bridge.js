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

export function executeSet(set, { transaction = true } = {}) {
    return callPlugin('executeSet', {
        database: STORE_CONFIG.databaseName,
        set,
        transaction,
    });
}

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
