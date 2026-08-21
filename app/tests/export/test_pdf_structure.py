"""The print layer's PDF/A-2b structure, checked without a validator.

WHAT THIS IS AND IS NOT. These assertions are a *structural* check written in
the standard library, so they run in the free per-push gate. They are not a
conformance verdict: the certifying one is veraPDF, which runs in the
`android-instrumented` job (`pull_request` and `workflow_dispatch` only, the
same spend trade already accepted for the device layer). What lives here is
everything that can be established by reading the bytes — and it is the half
that catches an ordinary mistake, while veraPDF catches the exotic one.

The claim `PDF/A-2b` is written into the artifact's own declaration and into the
XMP packet. A file that claims conformance it does not have is worse than one
that claims nothing, which is why the claim is checked from two directions
rather than trusted.
"""

from __future__ import annotations

import io
import re
import zipfile

from .harness import EXPORT_DIR
from .pdf_text import content_streams, glyph_runs

PDF_PATH = "print/archive.pdf"


def pdf(artifact: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        return archive.read(PDF_PATH)


def test_the_archive_carries_a_print_layer(artifact: bytes) -> None:
    body = pdf(artifact)
    assert body.startswith(b"%PDF-1.7"), "not a PDF 1.7 file"
    # The binary comment on line two: transfer agents use it to decide the file
    # is not text. PDF/A requires it.
    second = body.split(b"\n", 2)[1]
    assert any(b > 127 for b in second), "the binary marker comment is missing"
    assert body.rstrip().endswith(b"%%EOF"), "the file does not end at %%EOF"


def test_the_file_is_not_encrypted(artifact: bytes) -> None:
    """PDF/A forbids encryption outright — a keyed file is unreadable later."""
    assert b"/Encrypt" not in pdf(artifact)


def test_the_conformance_claim_is_declared_in_the_metadata(artifact: bytes) -> None:
    body = pdf(artifact)
    assert b"<pdfaid:part>2</pdfaid:part>" in body
    assert b"<pdfaid:conformance>B</pdfaid:conformance>" in body
    # The metadata stream must be readable without applying a filter.
    match = re.search(rb"/Type\s*/Metadata\s*/Subtype\s*/XML[^>]*>>", body)
    assert match, "no XMP metadata stream"
    assert b"/Filter" not in match.group(0), "the XMP packet is filtered"


def test_the_xmp_dates_agree_with_the_document_information(artifact: bytes) -> None:
    """PDF/A requires the two to say the same thing, and they are easy to drift."""
    body = pdf(artifact)
    xmp = re.search(rb"<xmp:CreateDate>(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z", body)
    info = re.search(rb"/CreationDate \(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z\)", body)
    assert xmp and info, "a creation date is missing from XMP or from the info dictionary"
    assert xmp.groups() == info.groups()


def test_every_font_is_embedded(artifact: bytes) -> None:
    """The requirement that forces this artifact to carry a font at all.

    There is no Cyrillic base-14 face, so a PDF/A file in this product's
    language cannot avoid embedding one. Asserted as: a font file stream exists,
    it declares its unencoded length, and no font object references a font that
    is not embedded.
    """
    body = pdf(artifact)
    descriptors = re.findall(rb"/Type\s*/FontDescriptor.*?>>", body, re.S)
    assert descriptors, "no font descriptor"
    for descriptor in descriptors:
        assert b"/FontFile2" in descriptor, "a font descriptor embeds no font program"
    assert re.search(rb"/Length1 \d+", body), "the font stream declares no /Length1"


def test_the_text_is_extractable(artifact: bytes) -> None:
    """A print layer nobody can search or copy from is a picture of a document.

    Identity-H maps glyph ids, not characters, so a ToUnicode CMap is what makes
    the text recoverable. Without it the PDF renders correctly and yields
    nonsense when copied — which is the failure mode a presence check misses, so
    this walks the mapping and reads the first page back as text.
    """
    body = pdf(artifact)
    assert b"/ToUnicode" in body
    assert b"/CIDToGIDMap /Identity" in body
    assert b"/Encoding /Identity-H" in body

    # gid -> codepoint, straight out of the CMap the file carries.
    mapping = {
        int(gid, 16): int(cp, 16)
        for gid, cp in re.findall(rb"<([0-9A-F]{4})> <([0-9A-F]{4})>", body)
    }
    assert len(mapping) > 40, f"the ToUnicode CMap maps only {len(mapping)} glyphs"

    page = re.search(rb"BT\n(.*?)\nET", body, re.S)
    assert page, "no text object on the first page"
    decoded = []
    for run in re.findall(rb"<([0-9A-F]+)> Tj", page.group(1)):
        glyphs = [int(run[i : i + 4], 16) for i in range(0, len(run), 4)]
        decoded.append("".join(chr(mapping[g]) for g in glyphs if g in mapping))
    text = "\n".join(decoded)

    # Cyrillic survives the round trip through Identity-H. If the CMap were
    # wrong this would come back as mojibake or empty.
    assert "Участники" in text, text[:200]
    assert "�" not in text, "the first page fell back to the replacement character"


def test_the_output_intent_carries_an_embedded_profile(artifact: bytes) -> None:
    body = pdf(artifact)
    intent = re.search(rb"/Type\s*/OutputIntent.*?>>", body, re.S)
    assert intent, "no OutputIntent"
    assert b"/S /GTS_PDFA1" in intent.group(0)
    assert b"/DestOutputProfile" in intent.group(0), "the OutputIntent names no profile"
    assert b"/OutputConditionIdentifier" in intent.group(0)
    # /N 3 is the component count of the embedded ICC stream; a mismatch with
    # the profile's own colour space is a conformance failure.
    assert re.search(rb"<< /N 3 /Length \d+ >>", body), "the ICC stream declares no /N 3"


def test_the_cross_reference_table_points_at_real_objects(artifact: bytes) -> None:
    """A file whose xref is wrong may still open in a forgiving viewer today.

    It will not open in a strict one, and "strict" is what a 2044 reader is
    likely to be. Each offset is followed to the object it claims to start.
    """
    body = pdf(artifact)
    start = re.search(rb"startxref\s+(\d+)", body)
    assert start, "no startxref"
    xref_at = int(start.group(1))
    assert body[xref_at : xref_at + 4] == b"xref", "startxref does not point at the table"

    table = body[xref_at:]
    header = re.match(rb"xref\s+0 (\d+)\s+", table)
    assert header, "malformed xref header"
    count = int(header.group(1))
    entries = re.findall(rb"(\d{10}) (\d{5}) ([nf])", table)
    assert len(entries) == count, f"xref declares {count} objects, lists {len(entries)}"

    for index, (offset, _gen, kind) in enumerate(entries):
        if kind == b"f":
            continue
        at = int(offset)
        assert re.match(rb"%d 0 obj" % index, body[at : at + 20]), (
            f"xref entry {index} points at {at}, which does not start object {index}"
        )


def test_the_trailer_carries_an_id(artifact: bytes) -> None:
    body = pdf(artifact)
    trailer = re.search(rb"trailer\s*<<(.*?)>>\s*startxref", body, re.S)
    assert trailer, "no trailer"
    assert re.search(rb"/ID \[<[0-9A-F]+> <[0-9A-F]+>\]", trailer.group(1)), "no /ID"
    assert b"/Root" in trailer.group(1)
    assert b"/Info" in trailer.group(1)


def test_the_print_layer_is_declared_and_says_which_copy_is_authoritative(
    artifact: bytes,
) -> None:
    """The declared degradation, checked where a reader would look for it."""
    import json

    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        declaration = json.loads(archive.read("index.json").decode("utf-8"))["declaration"]
        readme = archive.read("README.txt").decode("utf-8")

    assert declaration["print_layer"]["path"] == PDF_PATH
    assert declaration["print_layer"]["conformance"] == "PDF/A-2b"
    # The authority statement must name the substitution mark and point at the
    # text files, or a reader has no way to know the PDF is the lossy copy — and
    # it must name the mark the writer REALLY draws. Read out of the shipped
    # config surface rather than repeated here as a literal (the
    # `_declared_line_width` idiom in test_artifact_shape.py): the artifact
    # quotes the knob to a reader, so a knob changed without the sentence being
    # amended is the artifact telling a family something untrue, and that is what
    # this leg exists to catch. It was written after the sentence and the writer
    # disagreed for a whole milestone (FIU-DL-005).
    codepoint = _declared_substitute()
    authority = declaration["print_layer"]["authority_ru"]
    assert chr(codepoint) in authority, (
        f"the declaration does not show the mark the writer draws ({chr(codepoint)})"
    )
    assert f"U+{codepoint:04X}" in authority, "the declaration does not name the mark's codepoint"
    assert "U+FFFD" not in authority, "the declaration still promises the mark this writer dropped"
    assert "index.json" in authority
    assert "печатный слой" in readme.lower(), "README does not mention the print layer"


def test_a_character_outside_the_font_degrades_only_in_the_pdf(artifact: bytes) -> None:
    """Anti-vacuity for the degradation claim, over the real artifact.

    The fixture seeds Cyrillic, which PT Sans covers, so this asserts the
    invariant that matters: whatever the PDF does, the text files and the index
    carry the exact characters. The PDF-side substitution is exercised directly
    in the unit-level check below.
    """
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        children = archive.read("text/children.txt").decode("utf-8")
        index = archive.read("index.json").decode("utf-8")

    assert "Мия Александровна" in children
    assert "Мия Александровна" in index


def _declared_substitute() -> int:
    """The shipped substitution mark, read out of the module that owns it."""
    source = (EXPORT_DIR / "config.js").read_text(encoding="utf-8")
    match = re.search(r"pdfSubstituteCodepoint: 0x([0-9a-fA-F]+)", source)
    assert match, "export/config.js no longer declares pdfSubstituteCodepoint"
    return int(match.group(1), 16)


def test_no_text_showing_operator_references_the_notdef_glyph(artifact: bytes) -> None:
    """The conformance-relevant property the print layer had no local executor for.

    ISO 19005-2:2011 clause 6.2.11.8: a PDF/A-2 file may not reference the
    .notdef glyph from any text-showing operator, in any content stream,
    whatever the rendering mode. veraPDF certifies that; this asserts it here,
    for free, on every push — which is the whole point, because until FIU-P5 the
    only executor was an owner dispatch, and the class surfaced as a red job at
    PR time on run 32530473473 rather than as a red test at the keyboard.

    WHAT THIS CAN AND CANNOT PROVE. It proves ONE rule of 144, on the artifact
    this repository's fixture produces, by reading the bytes. It is not veraPDF
    and does not become veraPDF: the other 143 rules — colour spaces,
    transparency, annotations, actions, ICC tag internals — are still certified
    only by the `Validate the print layer against PDF/A-2b` step in
    `android-instrumented`, on `pull_request` and `workflow_dispatch`. What it
    buys is that this particular rule can no longer be broken silently between
    dispatches.
    """
    body = pdf(artifact)
    streams = content_streams(body)
    pages = len(re.findall(rb"/Type /Page[ /]", body))

    # Anti-vacuity, three legs. A guard that found no content streams, or no
    # text in them, would report a clean file about bytes it never read — and
    # `glyph_runs` itself raises if an operator spelling escapes it.
    assert pages, "no page objects — this test would pass vacuously"
    assert len(streams) == pages, f"{pages} pages but {len(streams)} content streams"
    runs = [run for stream in streams for run in glyph_runs(stream)]
    assert runs, "no text-showing operators — this test would pass vacuously"

    offences = [(index, at) for index, run in enumerate(runs) for at, g in enumerate(run) if g == 0]
    assert not offences, (
        f"{len(offences)} reference(s) to .notdef from a text-showing operator,"
        f" first at run {offences[0][0]} position {offences[0][1]} —"
        " the print layer is not PDF/A-2b (clause 6.2.11.8)"
    )

    # The fourth anti-vacuity leg, and the one that binds this test to the
    # fixture: `seed_family` seeds a codepoint PT Sans does not cover, so the
    # substitution must actually have happened. Without this, dropping the
    # uncovered character from the fixture would leave the test green while
    # removing everything it was watching.
    substitute = _glyph_for(body, _declared_substitute())
    drawn = sum(run.count(substitute) for run in runs)
    assert drawn, (
        "no substituted glyph on any page — the fixture no longer seeds a"
        " codepoint the embedded font lacks, and this test is now watching nothing"
    )


def test_the_notdef_scanner_detects_a_seeded_reference() -> None:
    """The arm-check, which generates its own failing input in this run.

    The guard above is an ABSENCE assertion over a file this repository writes,
    and an absence assertion is worth exactly what its detector is worth. So the
    detector is shown finding a reference to glyph 0 in a content stream built
    here, rather than by mutating the shipped writer and trusting a human to put
    it back.
    """
    seeded = b"BT\n/F1 9 Tf\n<00030000> Tj T*\nET"
    runs = glyph_runs(seeded)
    assert runs == [[3, 0]], runs
    assert any(0 in run for run in runs), "the scanner does not see a seeded .notdef reference"

    # And it sees one written with a spelling this writer never emits.
    assert any(0 in run for run in glyph_runs(b"BT\n[<0003> -20 <0000>] TJ\nET"))


def _glyph_for(pdf_bytes: bytes, codepoint: int) -> int:
    """The glyph id a codepoint has in this file, read out of its ToUnicode CMap."""
    mapping = {
        int(cp, 16): int(gid, 16)
        for gid, cp in re.findall(rb"<([0-9A-F]{4})> <([0-9A-F]{4})>", pdf_bytes)
    }
    assert codepoint in mapping, (
        f"U+{codepoint:04X} is not in the file's ToUnicode CMap — it was never drawn"
    )
    return mapping[codepoint]
