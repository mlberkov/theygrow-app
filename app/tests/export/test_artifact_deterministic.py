"""What "exporting twice gives the same thing" is guaranteed to mean.

The promise is stated precisely rather than approximately, because an
approximate one cannot be tested and would quietly stop holding:

  - same journal + same `exported_at_utc`  ->  byte-identical archive;
  - same journal + different `exported_at_utc`  ->  every file identical except
    MANIFEST.json, which is where the export time is deliberately confined.

The second half is what makes the first half useful: it says the variation is in
one named place rather than smeared across the archive.
"""

from __future__ import annotations

import io
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


def test_only_the_manifest_moves_when_the_clock_moves(
    store: sqlite3.Connection, tmp_path: Path
) -> None:
    early = _entries(build_artifact(store, tmp_path, exported_at_utc=1_000, name="early.zip"))
    late = _entries(build_artifact(store, tmp_path, exported_at_utc=9_999, name="late.zip"))

    assert early.keys() == late.keys()
    differing = sorted(name for name in early if early[name] != late[name])
    assert differing == ["MANIFEST.json"], differing


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
