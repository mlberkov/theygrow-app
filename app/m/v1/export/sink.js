// Where the bytes land (L1-P3).
//
// The artifact is UNENCRYPTED family data, so where it is written is a privacy
// decision, not a plumbing one. The rule this module enforces:
//
//   written on an explicit human action only, to a location that human picked
//   in that moment, never automatically, never on a schedule, never as a side
//   effect of anything else, and never transmitted anywhere by us.
//
// That is why the sink is Android's Storage Access Framework rather than a
// filesystem plugin. ACTION_CREATE_DOCUMENT needs NO storage permission at all:
// the system file picker hands back a URI for the one document the parent chose,
// and the app can write that document and nothing else. A general filesystem
// plugin would grant a capability far wider than this packet needs, and would
// add an npm dependency to a shipped surface that currently has none.
//
// The seam mirrors store/bridge.js deliberately: same injected-bridge call, same
// allowlist-first ordering, same "inert on the web" posture. There is exactly one
// allowed method and it only writes.

import { ALLOWED_SINK_METHODS, EXPORT_CONFIG } from './config.js';
import { ExportCancelledError, ExportError, ExportUnavailableError } from './errors.js';

const PLUGIN_NAME = 'TheyGrowExport';

function capacitor() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor ?? null;
}

/**
 * True only inside the Capacitor shell, with the sink plugin actually present.
 *
 * Both halves matter for the same reason store/bridge.js gives: a stubbed
 * Capacitor global would otherwise look like a native platform and fail later,
 * deeper, and less legibly.
 */
export function isExportSinkAvailable() {
    const cap = capacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    return typeof cap.nativePromise === 'function';
}

async function callSink(method, options = {}) {
    if (!ALLOWED_SINK_METHODS.includes(method)) {
        throw new ExportError(`sink method "${method}" is outside the declared allowlist`, {
            method,
        });
    }
    if (!isExportSinkAvailable()) {
        throw new ExportUnavailableError(
            `the export sink is unavailable on this platform (method "${method}")`,
            { method }
        );
    }
    try {
        return await capacitor().nativePromise(PLUGIN_NAME, method, options);
    } catch (reason) {
        const message = String(reason?.message ?? reason);
        if (/cancel/i.test(message)) {
            throw new ExportCancelledError('the file picker was closed', { method, cause: reason });
        }
        throw new ExportError(message, { method, cause: reason });
    }
}

// Base64 rather than a byte array because the Capacitor bridge carries JSON.
// Chunked because String.fromCharCode.apply blows the argument limit somewhere
// around a hundred thousand bytes, and an artifact is comfortably larger than
// that once a family has a few years of history in it.
function toBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Offers the artifact to the system file picker and writes it where the parent says.
 *
 * Returns `{ saved: true, uri }`, or throws `ExportCancelledError` if the parent
 * closed the picker — a closed picker is a decision, and the caller says nothing
 * rather than reporting a failure the parent did not cause.
 */
export async function saveArtifact(bytes, filename) {
    const result = await callSink('createDocument', {
        filename,
        mimeType: EXPORT_CONFIG.mimeType,
        base64: toBase64(bytes),
    });
    if (result?.saved !== true) {
        throw new ExportCancelledError('the file picker was closed');
    }
    return result;
}

export { toBase64 };
