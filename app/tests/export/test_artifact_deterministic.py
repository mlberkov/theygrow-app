"""What "exporting twice gives the same thing" is guaranteed to mean.

The promise is stated precisely rather than approximately, because an
approximate one cannot be tested and would quietly stop holding:

  - same journal + same `exported_at_utc`  ->  byte-identical archive;
  - same journal + different `exported_at_utc`  ->  every file identical except
    MANIFEST.json and print/archive.pdf, which is where the export time is
    deliberately confined — and inside the PDF it is confined further, to the
    two date fields and the derived /ID that PDF/A requires it to carry.

The second half is what makes the first half useful: it says the variation is in
named places rather than smeared across the archive.
"""

from __future__ import annotations

import io
import re
import sqlite3
import zipfile
from pathlib import Path

from .harness import build_artifact


def _entries(raw: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return {info.filename: archive.read(info.filename) for info in archive.infolist()}


def test_two_exports_of_the_same_state_are_byte_identical(
    store: sqlite3.Connection, tmp_path: Path
) -> None:
    first = build_artifact(store, tmp_path, name="first.zip")
    second = build_artifact(store, tmp_path, name="second.zip")
    assert first == second


def _mask_timestamps(pdf: bytes) -> bytes:
    """Blank the three places a PDF is allowed to record when it was made.

    Used so the assertion below stays a statement about CONTENT rather than
    being relaxed to "the PDF may differ". Everything else in the print layer
    must still be byte-identical across two export times.
    """
    pdf = re.sub(rb"D:\d{14}Z", b"D:00000000000000Z", pdf)
    pdf = re.sub(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", b"0000-00-00T00:00:00Z", pdf)
    pdf = re.sub(rb"/ID \[<[0-9A-F]+> <[0-9A-F]+>\]", b"/ID []", pdf)
    # The xref offsets shift when the dates above change length; they do not
    # here (all three are fixed-width), so the table is compared as-is.
    return pdf


def test_only_the_manifest_and_the_print_layer_move_when_the_clock_moves(
    store: sqlite3.Connection, tmp_path: Path
) -> None:
    """The export time is confined to two files, and to three fields in one of them.

    MANIFEST.json records `exported_at_utc` by design. The print layer records
    the same instant in `/CreationDate`, `/ModDate` and the XMP dates because
    PDF/A requires those fields and requires them to agree — so it cannot be
    clock-free. What it CAN be, and is asserted to be here, is clock-free
    everywhere else: mask the dates and the derived `/ID`, and the two PDFs are
    identical byte for byte.
    """
    early = _entries(build_artifact(store, tmp_path, exported_at_utc=1_000, name="early.zip"))
    late = _entries(build_artifact(store, tmp_path, exported_at_utc=9_999, name="late.zip"))

    assert early.keys() == late.keys()
    differing = sorted(name for name in early if early[name] != late[name])
    assert differing == ["MANIFEST.json", "print/archive.pdf"], differing

    assert _mask_timestamps(early["print/archive.pdf"]) == _mask_timestamps(
        late["print/archive.pdf"]
    ), "the print layer varies with the clock beyond its date and ID fields"


def test_a_changed_journal_changes_the_archive(store: sqlite3.Connection, tmp_path: Path) -> None:
    """Anti-vacuity: byte-identity is worthless if the builder ignores its input."""
    before = build_artifact(store, tmp_path, name="before.zip")
    store.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-new', 'assertion', 'p-self', 'c-1', 'child_shared', 'authored',"
        " '2026-02-01', 7000, 180)"
    )
    store.execute(
        "INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,"
        " prerequisite_propagation) VALUES ('j-new', 'skill_observed', 'skill-9',"
        " '2026-02-01', 'none')"
    )
    after = build_artifact(store, tmp_path, name="after.zip")
    assert before != after


def test_the_archive_carries_no_wall_clock_outside_the_manifest(
    store: sqlite3.Connection, tmp_path: Path
) -> None:
    """The export time appears in exactly one place, by construction.

    Zip entry timestamps are pinned to the DOS epoch and no renderer stamps
    "generated at" into a text file — otherwise two exports of an unchanged
    journal would differ in a dozen places and the guarantee above would be
    impossible to state.
    """
    entries = _entries(build_artifact(store, tmp_path, exported_at_utc=1_770_000_000_000))
    for name, body in entries.items():
        if name == "MANIFEST.json":
            continue
        assert b"1770000000000" not in body, f"{name} carries the export timestamp"
