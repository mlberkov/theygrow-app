// The transitional transfer envelope (DIA-P1).
//
// ONE MODULE, BOTH ENDS. The handoff page builds an envelope out of what it
// reads from the browser's localStorage; the app parses one out of what the
// receiving plugin staged. Both go through here, so there is one shape and one
// version rather than two that agree until they do not.
//
// THIS FORMAT IS TRANSITIONAL. Its only consumer is the L1-P4 importer at the
// other end of this one transfer, and it is NOT the long-lived artefact — see
// the header on ENVELOPE_FORMAT_ID in ./config.js for the full statement of what
// it therefore does not promise (PDR-020 §1/§2). Nothing outside this repository
// is invited to read it, nothing is published about it, and it may change shape
// with a version bump whenever both ends change together.
//
// WHAT PARSING IS ALLOWED TO PRODUCE, and why that is the load-bearing part.
// parseEnvelope() does not hand its input through. It builds a FRESH object
// carrying exactly the four fields the importer reads — id, name, birthdate,
// completedSkills — and drops everything else on the floor. The importer is
// append-only into a journal that can never be edited afterwards
// (LSC-P2-INV-001), and its ids are derived from the values it is given
// (LSC-P4-INV-002), so what reaches it is what the family is permanently stuck
// with. A pass-through would let a field nobody designed for ride into that.
//
// The envelope carries NO checksum and NO byte count of its own. Those belong to
// the TRANSPORT — they are what the receiver checks the staged bytes against
// before it will admit them — and putting them inside the thing they describe
// would make the description unverifiable. See TRANSFER_CONFIG.linkParams.

import { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } from './config.js';
import { TransferFormatError } from './errors.js';

/** Whether a value is a non-empty string. */
function isText(value) {
    return typeof value === 'string' && value.length > 0;
}

/**
 * The envelope for a set of legacy profiles, as JSON text.
 *
 * Only the four fields the importer reads are written out — the same narrowing
 * parseEnvelope applies, done at the other end too so a profile record that has
 * grown a field in the browser does not start travelling by accident.
 */
export function buildEnvelope(profiles) {
    if (!Array.isArray(profiles)) {
        throw new TransferFormatError('the profiles to transfer are not a list', {
            reason: 'format_version',
        });
    }
    return JSON.stringify({
        formatId: ENVELOPE_FORMAT_ID,
        formatVersion: ENVELOPE_FORMAT_VERSION,
        profiles: profiles.map((profile) => ({
            id: profile?.id,
            name: profile?.name ?? null,
            birthdate: profile?.birthdate ?? null,
            completedSkills: Array.isArray(profile?.completedSkills)
                ? profile.completedSkills.filter(isText)
                : [],
        })),
    });
}

/**
 * The profiles an envelope carries, in exactly the shape `runImport` takes.
 *
 * Throws `TransferFormatError` with a closed `reason` rather than returning a
 * partial result: a half-understood envelope is the one state in which nothing
 * may be written, because the journal cannot take it back.
 */
export function parseEnvelope(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new TransferFormatError('the transfer envelope is not readable JSON', {
            reason: 'format_version',
            cause: error,
        });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TransferFormatError('the transfer envelope is not an object', {
            reason: 'format_version',
        });
    }
    if (parsed.formatId !== ENVELOPE_FORMAT_ID) {
        // Named rather than guessed at: bytes that are not ours at all reach
        // here whenever the parent picks the wrong file in the fallback picker,
        // which is a thing parents do and not an error to be cryptic about.
        throw new TransferFormatError('these bytes are not a theygrow transfer', {
            reason: 'format_version',
        });
    }
    // Both directions, deliberately. A NEWER version is refused because this
    // build does not know what it means; an OLDER one because no older version
    // was ever published, so seeing one means something is wrong rather than
    // something is old.
    if (parsed.formatVersion !== ENVELOPE_FORMAT_VERSION) {
        throw new TransferFormatError(
            `this transfer is format version ${parsed.formatVersion};`
                + ` this build reads version ${ENVELOPE_FORMAT_VERSION}`,
            { reason: 'format_version' }
        );
    }
    if (!Array.isArray(parsed.profiles)) {
        throw new TransferFormatError('the transfer envelope carries no profile list', {
            reason: 'format_version',
        });
    }

    const profiles = [];
    for (const profile of parsed.profiles) {
        if (profile === null || typeof profile !== 'object' || !isText(profile.id)) {
            // A profile with no id cannot be given a derived id, so it cannot be
            // made idempotent, so importing it twice would double it. Refuse the
            // whole envelope rather than silently carrying the rest: a transfer
            // that quietly drops a child is worse than one that does nothing.
            throw new TransferFormatError('a profile in the transfer has no id', {
                reason: 'format_version',
            });
        }
        profiles.push({
            id: profile.id,
            name: isText(profile.name) ? profile.name : null,
            birthdate: isText(profile.birthdate) ? profile.birthdate : null,
            completedSkills: Array.isArray(profile.completedSkills)
                ? profile.completedSkills.filter(isText)
                : [],
        });
    }
    return profiles;
}

// --- the wire codec ----------------------------------------------------
//
// base64URL, not base64: the payload rides a URL query parameter, and `+` and
// `/` would each have to be percent-encoded there — inflating the very length
// the ceiling in ./config.js exists to bound, and doing it by a factor that
// depends on the content. Padding is dropped for the same reason and restored on
// the way back.
//
// The 0x8000 stride is the argument limit of String.fromCharCode.apply, a
// property of the JavaScript engine. It is NOT a transfer chunk size and must
// not be confused with one — the same distinction export/sink.js draws.

const STRIDE = 0x8000;

/** The envelope's UTF-8 bytes. This is what `bytes` and `sha256` describe. */
export function envelopeBytes(text) {
    return new TextEncoder().encode(text);
}

export function encodePayload(bytes) {
    let binary = '';
    for (let at = 0; at < bytes.length; at += STRIDE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + STRIDE));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePayload(encoded) {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes;
}

/**
 * SHA-256 of the envelope bytes, lower-case hex.
 *
 * WHAT THIS IS FOR, and what it is not. It is an INTEGRITY check against a
 * transport that can silently shorten what it carries — a browser truncating a
 * long URI is the case this transfer actually has — so the receiver can refuse a
 * partial history instead of importing one. It is not a security boundary and is
 * not treated as one: the whole exchange happens inside one device, between a
 * page the parent opened and an app they installed, and an attacker able to
 * forge the link is already able to do worse.
 */
export async function digestHex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
