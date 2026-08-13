"""LSC-P2-INV-002 — a declarative marker never moves a computed number.

PDR-033 fixes slot 6 as ONE computing field (gestational age at birth, from which
corrected-age policy is derived) and THREE declarative, non-computing markers
(bilingual environment, atypical development, unknown early history). The
structural invariant is that a marker changes what the product is ALLOWED TO
ASSERT, never a number.

The test is behavioural rather than textual on purpose: flipping every marker
through every value and asserting the computing surface is byte-identical catches
a computation that reaches a marker through three views, which a grep for the
table name would not.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from .harness import append_child_attribute, seed_child, seed_participant

MARKERS = (
    "marker_bilingual",
    "marker_atypical_development",
    "marker_unknown_early_history",
)

# The computing surface: every view that yields a NUMBER or a DATE about a child.
# A view added here without being added to the schema fails loudly below.
COMPUTING_VIEWS = ("v_child_age",)


@pytest.fixture
def child_with_history(store: sqlite3.Connection) -> sqlite3.Connection:
    seed_participant(store, "p-self")
    seed_child(store, "c-1")
    append_child_attribute(store, "j-1", "p-self", "c-1", "birthdate", "2025-06-01", entry_at_utc=1)
    append_child_attribute(
        store, "j-2", "p-self", "c-1", "gestational_age_weeks", "32", entry_at_utc=2
    )
    append_child_attribute(
        store, "j-3", "p-self", "c-1", "gestational_age_days", "3", entry_at_utc=3
    )
    return store


def _computing_snapshot(conn: sqlite3.Connection) -> dict[str, list[tuple[Any, ...]]]:
    snapshot: dict[str, list[tuple[Any, ...]]] = {}
    for view in COMPUTING_VIEWS:
        rows = conn.execute(f"SELECT * FROM {view} ORDER BY child_id").fetchall()
        snapshot[view] = [tuple(row) for row in rows]
    return snapshot


def test_the_computing_surface_is_not_empty(child_with_history: sqlite3.Connection) -> None:
    """Anti-vacuity: a snapshot of nothing would make the invariant below trivial."""
    snapshot = _computing_snapshot(child_with_history)
    assert snapshot["v_child_age"], "v_child_age produced no rows to compare"
    row = child_with_history.execute("SELECT * FROM v_child_age").fetchone()
    assert row["prematurity_correction_days"] == 53, "40w0d minus 32w3d is 53 days"
    assert row["corrected_age_baseline_date"] == "2025-07-24"


def test_markers_never_move_a_computed_number(child_with_history: sqlite3.Connection) -> None:
    before = _computing_snapshot(child_with_history)
    seq = 10
    for marker in MARKERS:
        for value in ("true", "false", "ru,en", None):
            seq += 1
            append_child_attribute(
                child_with_history,
                f"j-m{seq}",
                "p-self",
                "c-1",
                marker,
                value,
                entry_at_utc=seq,
            )
            assert _computing_snapshot(child_with_history) == before, (
                f"setting {marker}={value!r} changed a computed value — a declarative "
                "marker must never be read on a computing path (PDR-033)"
            )


def test_the_computing_view_does_not_read_the_marker_rows(
    child_with_history: sqlite3.Connection,
) -> None:
    """The textual half: v_child_age reaches attributes only through v_child_profile."""
    sql = child_with_history.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'v_child_age'"
    ).fetchone()["sql"]
    assert "marker_" not in sql
    profile_sql = child_with_history.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'v_child_profile'"
    ).fetchone()["sql"]
    assert "marker_" not in profile_sql, (
        "v_child_profile feeds the computing view; it must not surface markers"
    )


def test_the_markers_are_still_readable_where_they_belong(
    child_with_history: sqlite3.Connection,
) -> None:
    """Not-collecting is not the same as not-recording: the declaration is kept."""
    append_child_attribute(
        child_with_history, "j-b", "p-self", "c-1", "marker_bilingual", "ru,he", entry_at_utc=20
    )
    rows = child_with_history.execute(
        "SELECT attribute, value, sensitive FROM v_child_marker WHERE child_id = 'c-1'"
    ).fetchall()
    assert [(r["attribute"], r["value"]) for r in rows] == [("marker_bilingual", "ru,he")]
    assert rows[0]["sensitive"] == 1, "all three markers carry the sensitivity flag"


def test_a_marker_cannot_be_recorded_as_non_sensitive(
    child_with_history: sqlite3.Connection,
) -> None:
    child_with_history.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-x', 'child_attribute', 'p-self', 'c-1', 'child_shared', 'authored',"
        " '2026-01-01', 50, 180)"
    )
    with pytest.raises(sqlite3.IntegrityError):
        child_with_history.execute(
            "INSERT INTO child_attribute (journal_id, attribute, value, sensitive)"
            " VALUES ('j-x', 'marker_atypical_development', 'true', 0)"
        )


def test_no_marker_carries_a_classification_or_a_severity(
    child_with_history: sqlite3.Connection,
) -> None:
    """PDR-033 — parent declaration, no classification and no severity."""
    columns = {r["name"] for r in child_with_history.execute("PRAGMA table_info(child_attribute)")}
    assert columns == {"journal_id", "attribute", "value", "sensitive"}, (
        "child_attribute must not grow a severity, grade or classification column"
    )
