// Just enough TrueType to embed a font in a PDF (L1-P3).
//
// This reads six tables and nothing else: `head` (units per em, bounding box,
// index-to-loc format), `hhea` + `hmtx` (advance widths), `maxp` (glyph count),
// `cmap` (Unicode -> glyph id) and `OS/2` + `post` (the descriptor values a PDF
// font dictionary is required to carry). It does not parse `glyf`, does not
// subset, and does not rewrite the file: the font travels into the PDF byte for
// byte as `FontFile2`.
//
// WHY NO SUBSETTING. A subset font must carry a `CIDSet` and a six-letter
// subset prefix, and getting either wrong is a PDF/A conformance failure that
// only a validator would catch. Embedding the whole file is unambiguously
// correct, and the cost — the font is a fixed ~443 KB per artifact — is paid
// once per export rather than per page.
//
// Only cmap formats 4 and 12 are read. Format 4 covers the Basic Multilingual
// Plane, which is every character this product can produce today; format 12 is
// read when present so an astral codepoint resolves rather than silently
// mapping to glyph 0. A font offering neither throws instead of producing a PDF
// whose text is uniformly .notdef.

import { ExportError } from './errors.js';

function u8(d, p) {
    return d[p];
}
function u16(d, p) {
    return (d[p] << 8) | d[p + 1];
}
function i16(d, p) {
    const v = u16(d, p);
    return v & 0x8000 ? v - 0x10000 : v;
}
function u32(d, p) {
    return ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
}

function tableDirectory(data) {
    const tag = u32(data, 0);
    // 0x00010000 is TrueType outlines; 'ttcf' and 'OTTO' (CFF) are refused
    // rather than half-handled — a CFF font in a FontFile2 stream is invalid.
    if (tag !== 0x00010000 && tag !== 0x74727565) {
        throw new ExportError(`unsupported font format 0x${tag.toString(16)} — TrueType expected`);
    }
    const count = u16(data, 4);
    const tables = new Map();
    for (let i = 0; i < count; i += 1) {
        const p = 12 + i * 16;
        const name = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
        tables.set(name, { offset: u32(data, p + 8), length: u32(data, p + 12) });
    }
    return tables;
}

function required(tables, name) {
    const t = tables.get(name);
    if (!t) throw new ExportError(`the font has no "${name}" table`);
    return t;
}

// Unicode -> glyph id, from the best subtable the font offers.
function readCmap(data, tables) {
    const cmap = required(tables, 'cmap');
    const base = cmap.offset;
    const n = u16(data, base + 2);
    let best = null;
    for (let i = 0; i < n; i += 1) {
        const rec = base + 4 + i * 8;
        const platform = u16(data, rec);
        const encoding = u16(data, rec + 2);
        const offset = base + u32(data, rec + 4);
        const format = u16(data, offset);
        const unicode =
            (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
        if (!unicode) continue;
        // Format 12 wins when present: it reaches beyond the BMP.
        if (format === 12) best = { format, offset };
        else if (format === 4 && (!best || best.format !== 12)) best = { format, offset };
    }
    if (!best) throw new ExportError('the font has no Unicode cmap subtable (format 4 or 12)');

    const map = new Map();
    if (best.format === 4) {
        const segX2 = u16(data, best.offset + 6);
        const seg = segX2 / 2;
        const ends = best.offset + 14;
        const starts = ends + segX2 + 2;
        const deltas = starts + segX2;
        const ranges = deltas + segX2;
        for (let s = 0; s < seg; s += 1) {
            const end = u16(data, ends + s * 2);
            const start = u16(data, starts + s * 2);
            const delta = u16(data, deltas + s * 2);
            const rangeOffset = u16(data, ranges + s * 2);
            if (start === 0xffff) continue;
            for (let c = start; c <= end && c !== 0x10000; c += 1) {
                let gid;
                if (rangeOffset === 0) {
                    gid = (c + delta) & 0xffff;
                } else {
                    const p = ranges + s * 2 + rangeOffset + (c - start) * 2;
                    gid = u16(data, p);
                    if (gid !== 0) gid = (gid + delta) & 0xffff;
                }
                if (gid !== 0) map.set(c, gid);
            }
        }
    } else {
        const groups = u32(data, best.offset + 12);
        for (let g = 0; g < groups; g += 1) {
            const p = best.offset + 16 + g * 12;
            const start = u32(data, p);
            const end = u32(data, p + 4);
            const startGid = u32(data, p + 8);
            for (let c = start; c <= end; c += 1) {
                map.set(c, startGid + (c - start));
            }
        }
    }
    return map;
}

/**
 * Reads a TrueType font into everything the PDF writer needs.
 *
 * `advance(gid)` is in font units; the caller scales by unitsPerEm. `.notdef`
 * (glyph 0) is deliberately reachable: an unmapped codepoint maps to it, and
 * the caller decides what to do about that rather than this module guessing.
 */
export function readFont(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const tables = tableDirectory(data);

    const head = required(tables, 'head').offset;
    const unitsPerEm = u16(data, head + 18);
    const indexToLocFormat = i16(data, head + 50);
    const bbox = [
        i16(data, head + 36),
        i16(data, head + 38),
        i16(data, head + 40),
        i16(data, head + 42),
    ];

    const maxp = required(tables, 'maxp').offset;
    const numGlyphs = u16(data, maxp + 4);

    const hhea = required(tables, 'hhea').offset;
    const ascent = i16(data, hhea + 4);
    const descent = i16(data, hhea + 6);
    const numberOfHMetrics = u16(data, hhea + 34);

    const hmtx = required(tables, 'hmtx').offset;
    const advances = new Uint16Array(numGlyphs);
    let last = 0;
    for (let g = 0; g < numGlyphs; g += 1) {
        if (g < numberOfHMetrics) last = u16(data, hmtx + g * 4);
        advances[g] = last;
    }

    // The PDF font descriptor needs these; both tables are optional in
    // TrueType, so sane, declared fallbacks rather than a throw.
    let capHeight = Math.round(ascent * 0.7);
    let italicAngle = 0;
    let flags = 32; // non-symbolic
    const os2 = tables.get('OS/2');
    if (os2) {
        const version = u16(data, os2.offset);
        if (version >= 2) capHeight = i16(data, os2.offset + 88) || capHeight;
        // usWeightClass 700+ marks the descriptor ForceBold; unused here (the
        // packet ships one regular weight) but read so the value is not invented.
        const fsSelection = u16(data, os2.offset + 62);
        if (fsSelection & 0x01) flags |= 64; // italic
    }
    const post = tables.get('post');
    if (post) {
        const raw = u32(data, post.offset + 4);
        italicAngle = (raw & 0x80000000 ? raw - 0x100000000 : raw) / 65536;
        if (u8(data, post.offset + 16) !== 0) flags |= 1; // fixed pitch
    }

    const cmap = readCmap(data, tables);

    return Object.freeze({
        bytes: data,
        unitsPerEm,
        indexToLocFormat,
        numGlyphs,
        bbox,
        ascent,
        descent,
        capHeight,
        italicAngle,
        flags,
        /** Glyph id for a codepoint, or 0 (.notdef) when the font lacks it. */
        glyph(codepoint) {
            return cmap.get(codepoint) ?? 0;
        },
        /** Advance width in font units. */
        advance(gid) {
            return advances[gid] ?? 0;
        },
        /** True when every codepoint of the string has a glyph. */
        covers(text) {
            for (const ch of text) {
                if (!cmap.has(ch.codePointAt(0))) return false;
            }
            return true;
        },
    });
}
