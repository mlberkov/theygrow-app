// A deterministic ZIP writer (L1-P3).
//
// WHY THIS IS HAND-WRITTEN RATHER THAN A LIBRARY. The web path is buildless in
// both channels (ADR-037): shipped modules import nothing from node_modules, and
// the named exit from that is vendoring, which has not been taken. A zip of
// STORED entries is about a hundred lines of header arithmetic, so vendoring a
// compressor to avoid writing them would add a supply-chain surface and a
// second thing that must still behave identically in 2044.
//
// WHY NOTHING IS COMPRESSED. Three reasons, in order of weight. DEFLATE output
// is not byte-stable across implementations or versions, so two devices holding
// the same journal would produce different archives and the determinism promise
// would be unstateable. A STORED archive is recoverable by hand from a hex
// editor if the central directory is ever damaged; a compressed one is not.
// And media does not travel this channel (PDR-020 §4), so the bytes saved would
// be small.
//
// Entry timestamps are pinned to the DOS epoch rather than the wall clock, for
// the same determinism reason: the export time lives in MANIFEST.json, in one
// named place, and nowhere else.

import { EXPORT_CONFIG } from './config.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

// Version 2.0: the floor that understands a directory entry and STORED data.
const VERSION = 20;
// Bit 11 — the filename is UTF-8. Every path this writer emits is ASCII by
// decision (see build.js), but declaring the encoding costs two bits and removes
// a class of mojibake from any reader that guesses a legacy code page.
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function ascii(text) {
    // Fail closed rather than silently emitting a path a legacy reader will
    // mangle: artifact paths are ASCII by decision, and a non-ASCII one would be
    // a design change smuggled in as data.
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code > 0x7f) {
            throw new Error(`zip entry name "${text}" is not ASCII`);
        }
        bytes[i] = code;
    }
    return bytes;
}

/**
 * Writes a ZIP archive from an ordered list of `{ path, bytes }` entries.
 *
 * The order given is the order written: the caller owns it, because entry order
 * is part of the determinism guarantee and hiding a sort in here would make that
 * guarantee depend on a locale-sensitive comparison.
 */
export function writeZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = ascii(entry.path);
        const crc = crc32(entry.bytes);
        const size = entry.bytes.length;

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
        local.setUint16(4, VERSION, true);
        local.setUint16(6, FLAG_UTF8, true);
        local.setUint16(8, EXPORT_CONFIG.zipCompressionMethod, true);
        local.setUint16(10, EXPORT_CONFIG.zipEntryDosTime, true);
        local.setUint16(12, EXPORT_CONFIG.zipEntryDosDate, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true);
        local.setUint32(22, size, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);

        chunks.push(new Uint8Array(local.buffer), name, entry.bytes);

        const directory = new DataView(new ArrayBuffer(46));
        directory.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
        directory.setUint16(4, VERSION, true);
        directory.setUint16(6, VERSION, true);
        directory.setUint16(8, FLAG_UTF8, true);
        directory.setUint16(10, EXPORT_CONFIG.zipCompressionMethod, true);
        directory.setUint16(12, EXPORT_CONFIG.zipEntryDosTime, true);
        directory.setUint16(14, EXPORT_CONFIG.zipEntryDosDate, true);
        directory.setUint32(16, crc, true);
        directory.setUint32(20, size, true);
        directory.setUint32(24, size, true);
        directory.setUint16(28, name.length, true);
        directory.setUint16(30, 0, true);
        directory.setUint16(32, 0, true);
        directory.setUint16(34, 0, true);
        directory.setUint16(36, 0, true);
        directory.setUint32(38, 0, true);
        directory.setUint32(42, offset, true);

        central.push(new Uint8Array(directory.buffer), name);
        offset += 30 + name.length + size;
    }

    const centralOffset = offset;
    const centralSize = central.reduce((total, part) => total + part.length, 0);

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOffset, true);
    end.setUint16(20, 0, true);

    const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
        out.set(part, cursor);
        cursor += part.length;
    }
    return out;
}

export { crc32 };
