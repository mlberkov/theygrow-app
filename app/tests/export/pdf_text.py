"""Reading the words back out of the print layer (FIU-P4).

WHY THIS EXISTS. The print layer is where the diary becomes something a person
can hold, and until this packet nothing in the suite could say what it says. The
PDF encodes text as GLYPH IDS — `<04D0 0456 …> Tj` — so a substring search over
the bytes for a parent's sentence finds nothing whether the sentence is in the
file or not. An absence assertion written that way would have been vacuous, and
the assertion that matters most in this packet is an absence: another
participant's diary text must not be in the printed layer either.

So this module does what a reader does: it inverts the file's own `/ToUnicode`
CMap and reads the page content streams back through it. That map is not a
convenience for tests — it is what makes the print layer searchable and
copy-pasteable in a real PDF reader, and `test_pdf_structure.py` already asserts
it is present. Decoding through it means these tests read the printed page the
way a person's PDF viewer reads it, rather than the way the writer wrote it.

FIU-P5 adds `content_streams` and `glyph_runs` beside it. They read the same
thing at a lower level — the glyph IDS a text-showing operator references, before
any attempt to turn them back into characters — because the property that failed
PDF/A is about the ids themselves and not about the words they spell. Reading the
page and auditing the page belong in one module: both rest on knowing exactly how
this writer spells a text-showing operator, and two copies of that knowledge is
one copy too many.

Standard library only, for the reason `blind_reader.py` gives about itself.
"""

from __future__ import annotations

import re

# The writer emits one `Tj` per laid-out line, and `pdf.js` never joins two input
# lines into one, so a decoded line here is a line on the page.
_TJ = re.compile(rb"<([0-9A-F]+)> Tj")
_BFCHAR = re.compile(rb"<([0-9A-F]{4})> <([0-9A-F]{4})>")

REPLACEMENT = "�"


def pdf_lines(pdf_bytes: bytes) -> list[str]:
    """Every line of the printed page, in page order, as text."""
    to_unicode = {
        int(glyph, 16): int(codepoint, 16) for glyph, codepoint in _BFCHAR.findall(pdf_bytes)
    }
    lines = []
    for match in _TJ.finditer(pdf_bytes):
        glyphs = match.group(1).decode("ascii")
        lines.append(
            "".join(
                # A glyph with no entry in the map is one the reader cannot turn
                # back into a character either; it is reported as THIS READER's
                # own replacement rather than dropped. It is deliberately NOT the
                # mark the writer draws (EXPORT_CONFIG.pdfSubstituteCodepoint):
                # the writer substitutes when the FONT lacks a character, this
                # substitutes when the FILE lacks a mapping, and a test that
                # cannot tell the two apart would pass on either.
                chr(to_unicode.get(int(glyphs[at : at + 4], 16), 0xFFFD))
                for at in range(0, len(glyphs), 4)
            )
        )
    return lines


def pdf_text(pdf_bytes: bytes) -> str:
    """The printed page as one string, lines joined in page order."""
    return "\n".join(pdf_lines(pdf_bytes))


# --- the glyph ids themselves (FIU-P5) -----------------------------------
#
# A PDF/A-2 file may not reference glyph 0 (.notdef) from a text-showing
# operator, in any content stream, whatever the rendering mode — ISO 19005-2:2011
# clause 6.2.11.8. Reading that property needs the ids, not the text, so these
# two helpers stop one level short of `pdf_lines`.

# `N 0 obj\n<< … /Length N >>\nstream\n` — every stream object this writer
# emits. The dict is sliced at the first `>>`, which is exact here because none
# of this writer's stream dictionaries nests one.
_STREAM_OBJECT = re.compile(rb"(\d+) 0 obj\n(<<.*?>>)\nstream\n", re.S)
_LENGTH = re.compile(rb"/Length (\d+)")

# An operand followed by a text-showing operator: `<hex> Tj`, `(literal) Tj`,
# `[ … ] TJ`, `<hex> '`, `<hex> "`. This writer emits the first form only, and
# the others are read anyway — a scanner that knows one spelling goes blind the
# day a later edit uses another, and a conformance guard that can go blind is
# the failure this packet exists to close.
_TEXT_SHOWING = re.compile(rb"(\[[^\]]*\]|<[0-9A-Fa-f]*>|\([^)]*\))\s*(TJ|Tj|'|\")")
# The same operators as bare tokens, for the census below.
_TEXT_SHOWING_TOKEN = re.compile(rb"(?<![A-Za-z0-9*])(TJ|Tj|'|\")")
_HEX_STRING = re.compile(rb"<([0-9A-Fa-f]*)>")


def content_streams(pdf_bytes: bytes) -> list[bytes]:
    """Every page content stream in the file, as raw bytes.

    Sliced by the stream's own declared `/Length` rather than searched for an
    `endstream` keyword, so an embedded font program carrying those bytes cannot
    confuse the boundary. A content stream is identified as one whose payload
    starts a text object: this writer's pages are `BT … ET` and nothing else,
    which also keeps the ToUnicode CMap stream — written through the same
    helper, with the same dictionary shape — out of the result.
    """
    streams: list[bytes] = []
    for match in _STREAM_OBJECT.finditer(pdf_bytes):
        length = _LENGTH.search(match.group(2))
        if not length:
            continue
        start = match.end()
        payload = pdf_bytes[start : start + int(length.group(1))]
        if payload.startswith(b"BT"):
            streams.append(payload)
    return streams


def glyph_runs(stream_bytes: bytes) -> list[list[int]]:
    """Every glyph id a text-showing operator in this stream references.

    One list per operator. Identity-H encodes two bytes per glyph, so a hex
    string is read in pairs of pairs and a literal string in pairs of bytes.

    FAILS CLOSED, and this is the load-bearing half: every text-showing operator
    token in the stream must have produced a run. If one did not — a spelling
    this parser does not know — it raises rather than returning a short list,
    because a silent short list is exactly how a guard reports "no offences
    found" about bytes it never looked at.
    """
    runs: list[list[int]] = []
    for operand, _operator in _TEXT_SHOWING.findall(stream_bytes):
        pieces = (
            _HEX_STRING.findall(operand) if operand.startswith(b"[") else [operand.strip(b"<>()")]
        )
        glyphs: list[int] = []
        for piece in pieces:
            if operand.startswith(b"("):
                glyphs.extend(
                    (piece[at] << 8) | piece[at + 1] for at in range(0, len(piece) - 1, 2)
                )
            else:
                text = piece.decode("ascii")
                glyphs.extend(int(text[at : at + 4], 16) for at in range(0, len(text) - 3, 4))
        runs.append(glyphs)

    tokens = len(_TEXT_SHOWING_TOKEN.findall(stream_bytes))
    if tokens != len(runs):
        raise AssertionError(
            f"{tokens} text-showing operators in the stream, {len(runs)} parsed —"
            " this scanner does not understand one of them and would report a"
            " clean page about bytes it never read"
        )
    return runs
