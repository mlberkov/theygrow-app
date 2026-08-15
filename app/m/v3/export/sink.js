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
// allowlist-first ordering, same "inert on the web" posture. Every allowed
// method only stages or writes; none of them can read, list or delete.
//
// WHY THE BYTES TRAVEL SEPARATELY FROM THE PICKER (XPT-P1, measured).
//
// Until this packet saveArtifact() passed the whole archive as the `base64`
// option of the SAME call that opens ACTION_CREATE_DOCUMENT. That call is the
// one Capacitor records as the "last plugin call for an activity", and when the
// picker comes to the front and the activity is stopped, Bridge.saveInstanceState
// writes that call's options JSON into the saved instance state TWICE — once
// directly and once inside the plugin's own bundle. On the family device, on
// 2026-08-15, with 1.73 MB of archive, that produced a 4 630 924-byte parcel and
// TransactionTooLargeException killed the process at the ~1 MB binder limit —
// AFTER the system had already created the empty document with the chosen name
// and BEFORE any byte was written. The parent got a 0-byte file, every time,
// with no error to read.
//
// So the archive is staged first, in chunks small enough that no single call
// could ever approach that limit, and the call that opens the picker carries
// four small values and nothing else. The plugin refuses that call if it
// carries anything more (see EXPORT_CONFIG.sinkLaunchOptionsMaxBytes), so the
// defect cannot be reintroduced by an edit that looks harmless here.
//
// Nothing is written to a temporary file on the way, then or now: the staged
// bytes live in the app's own memory until they go to the document the parent
// picked, so there is still no moment where an unencrypted copy of the family's
// history sits somewhere nobody chose.

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
//
// The 0x8000 stride here is NOT the transfer chunk size and the two must not be
// merged: this one is the argument limit of String.fromCharCode.apply, a
// property of the JavaScript engine, and it applies within one call's payload.
// The transfer chunk size is EXPORT_CONFIG.sinkChunkBytes, a declared knob about
// how much rides one bridge call. One is a language limit, the other is a
// contract with the native side.
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
 * Three steps, in this order and never another: stage the bytes, then open the
 * picker, then — inside the plugin, on the result — write them. The picker is
 * opened LAST on purpose. The plugin refuses to open it unless the bytes it
 * holds are exactly as many as this call says it sent, so the parent is never
 * shown a save dialog for an archive that is not fully in hand; the system
 * creates the document the moment they press Save, and a document created for a
 * transfer that then fails is precisely the 0-byte file this packet exists to
 * end.
 *
 * Returns `{ saved: true, uri, chunks }`, or throws `ExportCancelledError` if the
 * parent closed the picker — a closed picker is a decision, and the caller says
 * nothing rather than reporting a failure the parent did not cause.
 */
export async function saveArtifact(bytes, filename) {
    const { transferId } = await callSink('beginTransfer', { totalBytes: bytes.length });

    const stride = EXPORT_CONFIG.sinkChunkBytes;
    let chunks = 0;
    for (let at = 0; at < bytes.length; at += stride) {
        await callSink('appendChunk', {
            transferId,
            base64: toBase64(bytes.subarray(at, at + stride)),
        });
        chunks += 1;
    }

    // FOUR VALUES, ALL SMALL, AND totalBytes IS THE ONE THAT MATTERS: it is what
    // the plugin checks its staged buffer against before it will open anything.
    // Adding a fifth key here — a payload above all — is refused by the plugin
    // rather than silently accepted; see the header.
    const result = await callSink('createDocument', {
        transferId,
        filename,
        mimeType: EXPORT_CONFIG.mimeType,
        totalBytes: bytes.length,
    });
    if (result?.saved !== true) {
        throw new ExportCancelledError('the file picker was closed');
    }
    return { ...result, chunks };
}

export { toBase64 };
