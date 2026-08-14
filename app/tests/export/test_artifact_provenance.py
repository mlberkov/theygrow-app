"""A migrated mark must not read as an observation (L1-P4).

THE FAILURE THIS PREVENTS, stated plainly because it is the reason the test
exists: a legacy mark carries no date. `journal_entry.event_date_local` is NOT
NULL, so the importer has to write *something*, and the least-bad something is
the import date — with `event_at_utc` left NULL and `origin = 'migrated_legacy'`
so the fiction is detectable in the database (`app/tests/schema/
test_write_path_projection.py`).

Detectable in the database is not enough. The archive is the decades-horizon
record, and its intended reader has no database, no app and nobody to ask. If the
artifact prints the import date beside three hundred skills without saying what
that date is, the reader is handed a story in which a child mastered three
hundred skills on a single afternoon. So the artifact has to mark those dates
unknown — in `text/`, in `index.json`, and in the print layer, which is built
from the same `text/` rendering.

WHY THIS IS A DECLARATION TEST RATHER THAN A RENDERER TEST. `text.js` renders
whatever columns the declaration names and `readme.js` prints whatever the
declaration says about them, so the honest wording has to live in
`declaration.json` to reach all three surfaces at once. That is the P3
architecture working as designed, not a shortcut around it.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from .blind_reader import Artifact
from .harness import CHILD, DECLARATION_PATH, SELF, build_artifact, seeded_store

IMPORT_DATE = "2026-08-13"
OBSERVED_DATE = "2026-02-01"

# The value the artifact must carry for a mark whose observation date is not
# known, and the value it must carry for one that is. Named here so the two are
# compared against each other rather than against a hardcoded expectation in
# each assertion.
BASIS_UNKNOWN = "import_date_unknown"
BASIS_OBSERVED = "observed"


def _migrated_mark(conn: sqlite3.Connection) -> None:
    """One imported mark, exactly as `store/import-legacy.js` writes it."""
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, event_at_utc, event_utc_offset_min,"
        " entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-mig', 'assertion', ?, ?, 'child_shared', 'migrated_legacy', ?,"
        " NULL, NULL, 6000, 180)",
        (SELF, CHILD, IMPORT_DATE),
    )
    conn.execute(
        "INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,"
        " prerequisite_propagation, source_record_id, supersedes_assertion_id)"
        " VALUES ('j-mig', 'skill_observed', 'skill-9', ?, 'none', NULL, NULL)",
        (IMPORT_DATE,),
    )
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, event_at_utc, event_utc_offset_min,"
        " entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-mig-c', 'confirmation', ?, ?, 'child_shared', 'migrated_legacy', ?,"
        " NULL, NULL, 6000, 180)",
        (SELF, CHILD, IMPORT_DATE),
    )
    conn.execute(
        "INSERT INTO confirmation (journal_id, target_assertion_id, status, note)"
        " VALUES ('j-mig-c', 'j-mig', 'confirmed', NULL)"
    )


def _observed_mark(conn: sqlite3.Connection) -> None:
    """One authored mark with a real observation date, so the contrast is testable."""
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, event_at_utc, event_utc_offset_min,"
        " entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-obs', 'assertion', ?, ?, 'child_shared', 'authored', ?,"
        " 1770000000000, 180, 6100, 180)",
        (SELF, CHILD, OBSERVED_DATE),
    )
    conn.execute(
        "INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,"
        " prerequisite_propagation, source_record_id, supersedes_assertion_id)"
        " VALUES ('j-obs', 'skill_observed', 'skill-8', ?, 'none', NULL, NULL)",
        (OBSERVED_DATE,),
    )


@pytest.fixture
def mixed_store() -> Iterator[sqlite3.Connection]:
    """The fixture family plus one imported mark and one observed mark.

    A separate fixture rather than an addition to `seed_family`: every other
    module in this suite asserts against that family's counts and contents, and
    growing it to serve one test would move assertions that have nothing to do
    with provenance.
    """
    conn = seeded_store()
    _migrated_mark(conn)
    _observed_mark(conn)
    yield conn
    conn.close()


@pytest.fixture
def mixed_artifact(mixed_store: sqlite3.Connection, tmp_path: Path) -> bytes:
    return build_artifact(mixed_store, tmp_path)


def _skill_row(archive: Artifact, skill_id: str) -> dict[str, object]:
    for row in archive.rows("child_skill_state"):
        if row["skill_id"] == skill_id:
            return row
    raise AssertionError(f"the artifact carries no skill state for {skill_id!r}")


# --- the machine-readable half -------------------------------------------


def test_the_skill_state_says_whether_its_date_is_an_observation(
    mixed_artifact: bytes,
) -> None:
    archive = Artifact(mixed_artifact)

    migrated = _skill_row(archive, "skill-9")
    observed = _skill_row(archive, "skill-8")

    assert migrated["event_date_basis"] == BASIS_UNKNOWN, (
        "an imported mark's date is the day it was imported, and the archive has to say so"
    )
    assert observed["event_date_basis"] == BASIS_OBSERVED
    assert migrated["origin"] == "migrated_legacy"
    assert observed["origin"] == "authored"


def test_the_basis_column_is_declared_and_explained(mixed_artifact: bytes) -> None:
    """A column a reader cannot interpret is not a disclosure."""
    archive = Artifact(mixed_artifact)
    assert "event_date_basis" in archive.columns_of("child_skill_state")

    declared = next(
        dataset
        for dataset in archive.declaration["datasets"]
        if dataset["name"] == "child_skill_state"
    )
    description = next(
        column["description_ru"]
        for column in declared["columns"]
        if column["name"] == "event_date_basis"
    )
    assert BASIS_UNKNOWN in description, "the value is named in its own explanation"
    assert len(description) > 80, "an explanation short enough to be a label explains nothing"


def test_the_journal_dataset_explains_what_a_migrated_date_is(mixed_artifact: bytes) -> None:
    """`journal_entry` stays a SOURCE dataset — no computed column — so the honesty
    has to live in the field explanations the reader gets beside the value."""
    archive = Artifact(mixed_artifact)
    declared = next(
        dataset for dataset in archive.declaration["datasets"] if dataset["name"] == "journal_entry"
    )
    explanations = {column["name"]: column["description_ru"] for column in declared["columns"]}

    assert "migrated_legacy" in explanations["event_date_local"], (
        "the date column must say what the date means when the entry was imported"
    )
    assert "migrated_legacy" in explanations["event_at_utc"]


# --- the human-readable half, and the print layer that is built from it ---


def test_the_skills_text_file_marks_the_unknown_date_on_the_row(mixed_artifact: bytes) -> None:
    archive = Artifact(mixed_artifact)
    body = archive.text_file("text/skills.txt")

    assert f"event_date_basis: {BASIS_UNKNOWN}" in body
    assert f"event_date_basis: {BASIS_OBSERVED}" in body
    assert "event_date_basis" in body.split("Поля:")[1], "and the legend explains the field"


def test_the_readme_tells_the_reader_that_some_dates_are_import_dates(
    mixed_artifact: bytes,
) -> None:
    """The README is the file a reader opens first and the only one that can warn
    them before they start believing the dates."""
    archive = Artifact(mixed_artifact)
    readme = archive.text_file("README.txt")

    assert "migrated_legacy" in readme
    assert IMPORT_DATE not in readme, "the README explains the rule, it does not restate the data"


def test_the_print_layer_carries_the_same_marking(mixed_artifact: bytes) -> None:
    """The PDF is built from the rendered `text/` files, so this is a regression
    guard on that wiring rather than a second rendering to keep in step."""
    archive = Artifact(mixed_artifact)
    pdf = archive.raw("print/archive.pdf")

    assert pdf.startswith(b"%PDF-"), "the print layer is still a PDF"
    text_body = archive.text_file("text/skills.txt")
    assert BASIS_UNKNOWN in text_body
    assert len(pdf) > len(archive.raw("README.txt")), "the print layer is not a stub"


# --- anti-vacuity ---------------------------------------------------------


def test_the_fixture_actually_holds_both_kinds_of_mark(mixed_store: sqlite3.Connection) -> None:
    """Every assertion above is a statement about a contrast; if the fixture ever
    stopped carrying both sides, they would all pass while proving nothing."""
    origins = {
        row["origin"]
        for row in mixed_store.execute(
            "SELECT DISTINCT origin FROM journal_entry WHERE kind = 'assertion'"
        ).fetchall()
    }
    assert {"authored", "migrated_legacy"} <= origins


def test_the_declaration_in_the_artifact_is_the_declaration_on_disk(
    mixed_artifact: bytes,
) -> None:
    """The new columns must reach the archive through the file the app reads,
    not through a build-time addition the device would never make."""
    archive = Artifact(mixed_artifact)
    on_disk = json.loads(DECLARATION_PATH.read_text(encoding="utf-8"))
    assert archive.declaration == on_disk
