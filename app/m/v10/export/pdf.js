// A PDF/A-2b writer, hand-written (L1-P3).
//
// WHY HAND-WRITTEN. Two independent reasons, and the second is the load-bearing
// one. First, the web path is buildless in both channels: shipped modules
// import nothing from npm. Second, and this is not a preference — **there is no
// other route to PDF/A on this platform**. Android's own PdfDocument and print
// pipeline emit PDF, not PDF/A: no OutputIntent, no pdfaid metadata, and
// subsetted fonts without the CIDSet a subset requires. A conformant file has
// to be assembled deliberately, so it is assembled here.
//
// WHAT CONFORMANCE COSTS, stated because it is the whole reason the print layer
// is a large piece of work rather than a small one:
//   - every font must be EMBEDDED, and there is no Cyrillic base-14 font, so
//     the artifact carries a font (assets/PTSans-Regular.ttf);
//   - an OutputIntent with an embedded destination profile is mandatory, so it
//     also carries an ICC profile (assets/sRGB-v2-micro.icc);
//   - the XMP packet must declare pdfaid:part/conformance and must agree with
//     the document information dictionary;
//   - nothing may be encrypted, and no reference may point outside the file.
//
// DETERMINISM. Nothing here reads a clock or a random source. `/CreationDate`,
// `/ModDate` and the two `/ID` strings are all derived from the caller's
// `exportedAtUtc` and from the content itself, so two exports of one journal at
// one timestamp are byte-identical — the property app/tests/export/
// test_artifact_deterministic.py asserts across the whole archive.
//
// DECLARED DEGRADATION. A codepoint the font does not cover renders as the
// substitution mark EXPORT_CONFIG.pdfSubstituteCodepoint names — «◊» — in the PDF
// and only there. The text files and index.json always carry the exact
// characters, and declaration.json says which is authoritative. That is the
// ADR-015 shape: degrade visibly and say so, rather than fail the export or
// pretend the character was something else.
//
// AND THE MARK MUST BE ONE THE FONT HAS. This is not a detail; it is where the
// degradation failed for a whole milestone. The substitute used to be U+FFFD,
// which PT Sans does not cover, so `font.glyph(0xfffd)` returned 0 and the
// writer drew .notdef — the one glyph PDF/A-2 forbids from a text-showing
// operator (ISO 19005-2:2011 clause 6.2.11.8, "shall not contain a reference to
// the .notdef glyph … in any content stream"). It stayed invisible until a
// fixture seeded a codepoint the font really lacks, and then it cost a red
// dispatch: run 32530473473, 143 rules passed and one failed, at
// pages[8]/contentStream[0]/operators[9]/usedGlyphs[17]. The substitution now
// resolves through a knob whose own comment carries the constraint, and
// app/tests/export/test_pdf_structure.py asserts on EVERY PUSH that no
// text-showing operator in any content stream of a built artifact references
// glyph 0 — the executor the printed layer did not have.

import { EXPORT_CONFIG } from './config.js';
import { ExportError } from './errors.js';
import { readFont } from './ttf.js';
import { crc32 } from './zip.js';

const ENCODER = new TextEncoder();
// The mark drawn in place of a codepoint the embedded font cannot draw. It
// lives on the config surface because declaration.json quotes it to a reader
// and the two must not drift; see the knob's own comment for the constraint
// that it has to be a codepoint the font covers.
const SUBSTITUTE = EXPORT_CONFIG.pdfSubstituteCodepoint;

// A4 in points, integral so the numbers written into the file are exact.
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

function bytes(text) {
    // PDF syntax and content streams are Latin-1 byte soup; every non-ASCII
    // character reaching this function would be a bug, so it is written as
    // single bytes deliberately rather than UTF-8 encoded.
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function hex(value, width) {
    return value.toString(16).toUpperCase().padStart(width, '0');
}

// PDF text strings carrying non-ASCII must be UTF-16BE with a byte-order mark.
function textString(value) {
    let out = 'FEFF';
    for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp > 0xffff) {
            const v = cp - 0x10000;
            out += hex(0xd800 + (v >> 10), 4) + hex(0xdc00 + (v & 0x3ff), 4);
        } else {
            out += hex(cp, 4);
        }
    }
    return `<${out}>`;
}

// D:YYYYMMDDHHmmSSZ — the only date form PDF/A accepts without an offset.
function pdfDate(utcMillis) {
    const d = new Date(utcMillis);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
        + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
    );
}

function isoDate(utcMillis) {
    return `${new Date(utcMillis).toISOString().slice(0, 19)}Z`;
}

// --- text layout ---------------------------------------------------------

function layout(font, size, maxWidth, lines) {
    const scale = size / font.unitsPerEm;
    const width = (glyphs) => glyphs.reduce((w, g) => w + font.advance(g) * scale, 0);
    const out = [];

    for (const raw of lines) {
        const line = raw.replace(/\t/g, '    ');
        if (!line.trim()) {
            out.push([]);
            continue;
        }
        // Leading spaces are structure in these files (the field legends are
        // indented), so they are preserved rather than trimmed away.
        const indent = line.length - line.trimStart().length;
        const prefix = ' '.repeat(indent);
        let current = prefix;
        let currentGlyphs = toGlyphs(font, prefix);

        for (const word of line.trimStart().split(/\s+/)) {
            const candidate = current.length > indent ? `${current} ${word}` : `${current}${word}`;
            const glyphs = toGlyphs(font, candidate);
            if (width(glyphs) > maxWidth && current.trim()) {
                out.push(currentGlyphs);
                current = `${prefix}${word}`;
                currentGlyphs = toGlyphs(font, current);
            } else {
                current = candidate;
                currentGlyphs = glyphs;
            }
        }
        out.push(currentGlyphs);
    }
    return out;
}

function toGlyphs(font, text) {
    const out = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        let gid = font.glyph(cp);
        if (gid === 0) {
            // Declared degradation, not a silent drop — and not .notdef either.
            // `SUBSTITUTE` is a codepoint the font covers, so this branch can
            // never hand a 0 back; when it could, it did, and the file stopped
            // being PDF/A. See DECLARED DEGRADATION at the top of this file.
            gid = font.glyph(SUBSTITUTE);
        }
        out.push(gid);
    }
    return out;
}

// --- the writer ----------------------------------------------------------

/**
 * Renders the artifact's print layer.
 *
 * `sections` is an ordered list of `{ title, body }`; the body is the SAME text
 * the archive's `text/` files carry, so the PDF is the printable form of those
 * files rather than a second rendering with its own opinions.
 */
export function renderPdf({ font: fontBytes, icc, sections, title, exportedAtUtc }) {
    if (!fontBytes || !icc) {
        throw new ExportError('the print layer needs both the font and the ICC profile');
    }
    const font = readFont(fontBytes);
    const size = EXPORT_CONFIG.pdfFontSize;
    const leading = EXPORT_CONFIG.pdfLineLeading;
    const margin = EXPORT_CONFIG.pdfMarginPt;
    const maxWidth = PAGE_WIDTH - margin * 2;
    const linesPerPage = Math.floor((PAGE_HEIGHT - margin * 2) / leading);

    // Lay every section out, then page it. Titles are kept with at least one
    // line of their body so a heading never ends a page alone.
    const flowed = [];
    for (const section of sections) {
        flowed.push(...layout(font, size, maxWidth, [section.title, '']));
        flowed.push(...layout(font, size, maxWidth, section.body.split('\n')));
        flowed.push([]);
    }

    const pages = [];
    for (let i = 0; i < flowed.length; i += linesPerPage) {
        pages.push(flowed.slice(i, i + linesPerPage));
    }
    if (!pages.length) pages.push([]);

    const used = new Set([font.glyph(SUBSTITUTE)]);
    for (const page of pages) for (const line of page) for (const g of line) used.add(g);

    // --- objects ---------------------------------------------------------
    const objects = [];
    const obj = (body) => {
        objects.push(body);
        return objects.length; // 1-based object numbers
    };

    const catalogId = objects.length + 1;
    objects.push(null); // reserved: written last, needs the ids below
    const metadataId = obj(null);
    const iccId = obj(null);
    const outputIntentId = obj(null);
    const pagesId = obj(null);
    const fontId = obj(null);
    const descendantId = obj(null);
    const descriptorId = obj(null);
    const fontFileId = obj(null);
    const toUnicodeId = obj(null);
    const infoId = obj(null);
    const pageIds = pages.map(() => obj(null));
    const contentIds = pages.map(() => obj(null));

    const stream = (dict, data) =>
        concat([bytes(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, bytes('\nendstream')]);

    objects[catalogId - 1] = bytes(
        `<< /Type /Catalog /Pages ${pagesId} 0 R /Metadata ${metadataId} 0 R`
            + ` /OutputIntents [${outputIntentId} 0 R] >>`
    );

    const xmp =
        `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
        + `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n`
        + `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n`
        + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n`
        + `<pdfaid:part>2</pdfaid:part>\n<pdfaid:conformance>B</pdfaid:conformance>\n`
        + `</rdf:Description>\n`
        + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n`
        + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li>`
        + `</rdf:Alt></dc:title>\n</rdf:Description>\n`
        + `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n`
        + `<xmp:CreateDate>${isoDate(exportedAtUtc)}</xmp:CreateDate>\n`
        + `<xmp:ModifyDate>${isoDate(exportedAtUtc)}</xmp:ModifyDate>\n`
        + `</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
    // Deliberately unfiltered: PDF/A requires the metadata stream to be
    // readable without applying a filter.
    objects[metadataId - 1] = stream('/Type /Metadata /Subtype /XML', ENCODER.encode(xmp));

    objects[iccId - 1] = stream('/N 3', icc instanceof Uint8Array ? icc : new Uint8Array(icc));
    objects[outputIntentId - 1] = bytes(
        `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB)`
            + ` /Info (sRGB IEC61966-2.1) /DestOutputProfile ${iccId} 0 R >>`
    );

    objects[pagesId - 1] = bytes(
        `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
    );

    const baseFont = EXPORT_CONFIG.pdfFontName;
    objects[fontId - 1] = bytes(
        `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H`
            + ` /DescendantFonts [${descendantId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`
    );

    const scale = 1000 / font.unitsPerEm;
    const widths = [...used]
        .filter((g) => g !== 0)
        .sort((a, b) => a - b)
        .map((g) => `${g} [${Math.round(font.advance(g) * scale)}]`)
        .join(' ');
    objects[descendantId - 1] = bytes(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont}`
            + ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
            + ` /FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}]`
            + ` /CIDToGIDMap /Identity >>`
    );

    const bbox = font.bbox.map((v) => Math.round(v * scale)).join(' ');
    objects[descriptorId - 1] = bytes(
        `<< /Type /FontDescriptor /FontName /${baseFont} /Flags ${font.flags}`
            + ` /FontBBox [${bbox}] /ItalicAngle ${Math.round(font.italicAngle)}`
            + ` /Ascent ${Math.round(font.ascent * scale)}`
            + ` /Descent ${Math.round(font.descent * scale)}`
            + ` /CapHeight ${Math.round(font.capHeight * scale)}`
            + ` /StemV ${EXPORT_CONFIG.pdfStemV} /FontFile2 ${fontFileId} 0 R >>`
    );
    objects[fontFileId - 1] = stream(`/Length1 ${font.bytes.length}`, font.bytes);

    objects[toUnicodeId - 1] = stream('', ENCODER.encode(toUnicodeCMap(font, used)));

    objects[infoId - 1] = bytes(
        `<< /Title ${textString(title)} /Producer ${textString(EXPORT_CONFIG.pdfProducer)}`
            + ` /CreationDate (${pdfDate(exportedAtUtc)}) /ModDate (${pdfDate(exportedAtUtc)}) >>`
    );

    pages.forEach((lines, i) => {
        objects[pageIds[i] - 1] = bytes(
            `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`
                + ` /Resources << /Font << /F1 ${fontId} 0 R >> >>`
                + ` /Contents ${contentIds[i]} 0 R >>`
        );
        const body = [
            'BT',
            `/F1 ${size} Tf`,
            `${leading} TL`,
            `${margin} ${PAGE_HEIGHT - margin} Td`,
            '0 g',
        ];
        for (const line of lines) {
            body.push(line.length ? `<${line.map((g) => hex(g, 4)).join('')}> Tj T*` : 'T*');
        }
        body.push('ET');
        objects[contentIds[i] - 1] = stream('', bytes(body.join('\n')));
    });

    // --- file body -------------------------------------------------------
    // %PDF-1.7 then four bytes >127, which marks the file as binary for
    // transfer agents. PDF/A requires the comment; it is not decoration.
    const parts = [bytes('%PDF-1.7\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    const offsets = [];
    let position = parts.reduce((n, p) => n + p.length, 0);

    objects.forEach((body, index) => {
        const head = bytes(`${index + 1} 0 obj\n`);
        const tail = bytes('\nendobj\n');
        offsets.push(position);
        parts.push(head, body, tail);
        position += head.length + body.length + tail.length;
    });

    // /ID is derived from the bytes written so far plus the export time, so it
    // is stable for identical input and different for different content —
    // which is what it is for. No random source is involved.
    const digest = crc32(concat(parts));
    const id = `<${hex(digest, 8)}${hex(exportedAtUtc % 0xffffffff, 8)}>`;

    const xrefAt = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    xref +=
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R`
        + ` /ID [${id} ${id}] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    parts.push(bytes(xref));

    return concat(parts);
}

function toUnicodeCMap(font, used) {
    // One entry per used glyph. Built by inverting the cmap over the glyphs
    // actually drawn, so a reader can extract the text — which is what makes
    // the print layer searchable rather than a picture of words.
    //
    // The substitution mark needs no special case here: it is a codepoint inside
    // the scanned range, so the loop below maps it like any other glyph the page
    // uses. There used to be one, mapping GLYPH 0 to U+FFFD — a bfchar entry for
    // .notdef, written because the substitution resolved to .notdef. It went out
    // with the defect that produced it (FIU-DL-005).
    const pairs = [];
    for (let cp = 0x20; cp <= 0x2fff; cp += 1) {
        const gid = font.glyph(cp);
        if (gid && used.has(gid)) pairs.push([gid, cp]);
    }

    const seen = new Set();
    const unique = pairs.filter(([g]) => (seen.has(g) ? false : seen.add(g)));
    unique.sort((a, b) => a[0] - b[0]);

    const chunks = [];
    for (let i = 0; i < unique.length; i += 100) {
        const slice = unique.slice(i, i + 100);
        chunks.push(
            `${slice.length} beginbfchar\n`
                + slice.map(([g, cp]) => `<${hex(g, 4)}> <${hex(cp, 4)}>`).join('\n')
                + '\nendbfchar\n'
        );
    }

    return (
        '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
        + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
        + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
        + '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
        + chunks.join('')
        + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
    );
}

function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export { PAGE_HEIGHT, PAGE_WIDTH };
