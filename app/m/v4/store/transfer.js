// The transfer seam: draining what the native side staged (DIA-P1).
//
// The mirror image of export/sink.js, and deliberately built to the same shape:
// same injected-bridge call, same allowlist-first ordering, same "inert on the
// web" posture. There the app STAGES bytes into the plugin in bounded chunks and
// the launching call carries a reference; here the plugin has staged bytes from
// an Intent and the app DRAINS them in bounded chunks, having been told only a
// reference. One direction each, one rule for both: no bridge call carries a
// payload, whatever the size of the history.
//
// WHY THE PAYLOAD IS NEVER ON A CALL, restated because the file it protects is
// this one. On 2026-08-15 an archive rode as an option of a plugin call that
// Capacitor persists into saved instance state — twice — and a 4 630 924-byte
// parcel killed the process at the ~1 MB binder limit (XPT-DL-001). Nothing
// about that is specific to exporting: a bridge RESPONSE crosses the same
// transaction an argument does, so the drain is chunked at
// TRANSFER_CONFIG.transferChunkBytes and the plugin refuses a longer one.
//
// WHAT THIS MODULE VERIFIES, AND WHY IT VERIFIES IT AGAIN. The plugin already
// checked the declared byte count and the digest before it staged anything. This
// side checks them again on what it actually received, because the two questions
// are different: the plugin's check is "did the browser deliver what it said",
// and this one is "did the drain reassemble what the plugin holds". A chunk lost
// or repeated between them would satisfy the first and fail the second.
//
// On the web this module is inert: isTransferAvailable() is false, every call
// throws, and nothing here touches Web Storage of any kind (LSC-P1-INV-001).

import { ALLOWED_TRANSFER_METHODS, TRANSFER_CONFIG } from '../transfer/config.js';
import { TransferFormatError } from '../transfer/errors.js';
import { digestHex, parseEnvelope } from '../transfer/format.js';

const PLUGIN_NAME = 'TheyGrowTransfer';

function capacitor() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor ?? null;
}

/**
 * True only inside the Capacitor shell, with the injected bridge present.
 *
 * Both halves matter for the reason store/bridge.js gives: a stubbed Capacitor
 * global would otherwise look like a native platform and fail later, deeper, and
 * less legibly.
 */
export function isTransferAvailable() {
    const cap = capacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    return typeof cap.nativePromise === 'function';
}

// The closed refusal vocabulary, mirrored from core/signals.js.
//
// ONE MAPPING POINT, AND THIS IS IT. Everything past this function reads
// `error.reason` and finds a declared code there, whether the failure came from
// this module or from the plugin. Without that, a caller would have to know
// which side threw — a rejection from Java carries `code`, a refusal from here
// carries `reason` — and the two would be read by different branches that drift.
// A code the plugin sends that is not declared here degrades to `format_version`
// rather than travelling as itself: the signal surface accepts only declared
// codes, so an undeclared one would be refused and the whole event would vanish
// (LSC-P4-INV-003). app/tests/transfer-seam.spec.js asserts this list and the
// plugin's own set are the same, so the degradation is a backstop rather than
// the normal path.
const REFUSAL_CODES = Object.freeze([
    'none',
    'no_handler',
    'foreign_key',
    'options_ceiling',
    'size_mismatch',
    'checksum_mismatch',
    'format_version',
    'cancelled',
    'handoff_unconfigured',
    'handoff_foreign_url',
    'no_browser',
    'unreadable',
    'bad_range',
    'no_transfer',
]);

async function callTransfer(method, options = {}) {
    if (!ALLOWED_TRANSFER_METHODS.includes(method)) {
        throw new TransferFormatError(
            `transfer method "${method}" is outside the declared allowlist`,
            { reason: 'foreign_key' }
        );
    }
    if (!isTransferAvailable()) {
        throw new TransferFormatError(
            `the history transfer is unavailable on this platform (method "${method}")`,
            { reason: 'no_handler' }
        );
    }
    try {
        return await capacitor().nativePromise(PLUGIN_NAME, method, options);
    } catch (reason) {
        const code = REFUSAL_CODES.includes(reason?.code) ? reason.code : 'format_version';
        // The plugin's message is kept for the device console — it carries the
        // bounded evidence the refusal printed, which is what a smoke reads —
        // and the CODE is what anything countable uses.
        throw new TransferFormatError(String(reason?.message ?? reason), {
            reason: code,
            cause: reason,
        });
    }
}

/**
 * Opens the handoff page in the parent's browser.
 *
 * The URL is passed for the plugin to CHECK, not to obey: it builds its own from
 * its own constant and refuses anything else. Passing it at all is what makes
 * the two declarations comparable at run time as well as off-device.
 */
export async function openHandoff() {
    const { handoffOrigin, handoffPath } = TRANSFER_CONFIG;
    return callTransfer('openHandoff', { url: `${handoffOrigin}${handoffPath}` });
}

/**
 * What the native side is holding, as small metadata — or why it is holding
 * nothing.
 *
 * Returns `{ present, refusal, transferId?, totalBytes?, sha256? }`. `refusal`
 * is a closed code, so a caller can report it in a signal without any free
 * string existing on the path (LSC-P4-INV-003).
 */
export async function pendingTransfer() {
    if (!isTransferAvailable()) return { present: false, refusal: 'no_handler' };
    try {
        const result = await callTransfer('pendingTransfer');
        return {
            present: result?.present === true,
            refusal: typeof result?.refusal === 'string' ? result.refusal : 'none',
            transferId: result?.transferId ?? null,
            totalBytes: Number(result?.totalBytes ?? 0),
            sha256: result?.sha256 ?? null,
        };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[transfer] the pending check failed:', error?.name, error?.message);
        return { present: false, refusal: 'no_handler' };
    }
}

/** Opens the system document picker so the parent can hand over the file. */
export async function pickTransfer() {
    const result = await callTransfer('pickTransfer');
    return {
        present: result?.present === true,
        refusal: typeof result?.refusal === 'string' ? result.refusal : 'none',
        transferId: result?.transferId ?? null,
        totalBytes: Number(result?.totalBytes ?? 0),
        sha256: result?.sha256 ?? null,
    };
}

/** Drops whatever the native side is holding. */
export async function discardTransfer(transferId) {
    if (!isTransferAvailable()) return;
    try {
        await callTransfer('discardTransfer', { transferId });
    } catch (error) {
        // A transfer that could not be dropped is not a reason to fail the
        // import that already succeeded; it is dropped on destroy regardless.
        // eslint-disable-next-line no-console
        console.error('[transfer] the staged transfer was not dropped:', error?.name);
    }
}

function decodeBase64(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes;
}

/**
 * Reads the staged transfer across in bounded chunks and returns its profiles.
 *
 * THE ORDER OF THE CHECKS IS THE CONTRACT. Bytes are counted, then the digest is
 * compared, and only then is anything parsed — so a transfer that arrived
 * incomplete never reaches the envelope parser, and one that fails to parse
 * never reaches the importer. The journal at the end of this path is append-only
 * (LSC-P2-INV-001): what it is handed cannot be corrected afterwards, which is
 * why every check here happens before it is handed anything.
 *
 * Returns `{ profiles, bytes, chunks }`. Throws `TransferFormatError` with a
 * closed `reason` on any mismatch.
 */
export async function drainTransfer({ transferId, totalBytes, sha256 }) {
    const stride = TRANSFER_CONFIG.transferChunkBytes;
    const received = new Uint8Array(totalBytes);
    let at = 0;
    let chunks = 0;

    while (at < totalBytes) {
        const chunk = await callTransfer('readChunk', {
            transferId,
            offset: at,
            length: Math.min(stride, totalBytes - at),
        });
        const bytes = decodeBase64(chunk?.base64 ?? '');
        if (bytes.length === 0) {
            throw new TransferFormatError(
                `the transfer stalled at ${at} of ${totalBytes} bytes: a chunk came back empty`,
                { reason: 'size_mismatch' }
            );
        }
        if (at + bytes.length > totalBytes) {
            throw new TransferFormatError(
                `the transfer sent more than it declared: ${at + bytes.length} bytes past`
                    + ` an offset of ${at}, against a declared ${totalBytes}`,
                { reason: 'size_mismatch' }
            );
        }
        received.set(bytes, at);
        at += bytes.length;
        chunks += 1;
    }

    if (at !== totalBytes) {
        throw new TransferFormatError(
            `the transfer reassembled to ${at} bytes where ${totalBytes} were declared`,
            { reason: 'size_mismatch' }
        );
    }

    const digest = await digestHex(received);
    if (sha256 && digest !== sha256) {
        // Neither digest is named in the message: a digest of a family history
        // is a stable identifier for that history. The comparison result and the
        // byte count are what a reader needs.
        throw new TransferFormatError(
            `the ${totalBytes} bytes that arrived do not match the digest the transfer`
                + ' declared — nothing was imported',
            { reason: 'checksum_mismatch' }
        );
    }

    return {
        profiles: parseEnvelope(new TextDecoder().decode(received)),
        bytes: totalBytes,
        chunks,
    };
}
