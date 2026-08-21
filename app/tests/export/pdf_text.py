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
                # back into a character either; it is reported as the same
                # replacement the writer would have drawn, never dropped.
                chr(to_unicode.get(int(glyphs[at : at + 4], 16), 0xFFFD))
                for at in range(0, len(glyphs), 4)
            )
        )
    return lines


def pdf_text(pdf_bytes: bytes) -> str:
    """The printed page as one string, lines joined in page order."""
    return "\n".join(pdf_lines(pdf_bytes))
