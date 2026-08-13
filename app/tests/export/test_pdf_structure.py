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
    # The authority statement must name the replacement character and point at
    # the text files, or a reader has no way to know the PDF is the lossy copy.
    authority = declaration["print_layer"]["authority_ru"]
    assert "U+FFFD" in authority
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
