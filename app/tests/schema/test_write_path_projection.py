"""The write path, projected (L1-P4).

Slot 1 and slot 9 stop being schema shapes here and become a rule the app obeys:
a mark is an ATTRIBUTED ASSERTION, and it travels with its author's confirmation
so that "confirmed by one" is what the general consensus function returns rather
than a case someone remembered to special-case.

WHY THESE TESTS EXTRACT SQL FROM `journal.js` RATHER THAN RESTATING IT.
`v_child_skill_state` carries no consensus column and `v_assertion_consensus` is
keyed by assertion, so expressing "confirmed by one of two" needs a join. The
schema is FROZEN (`LSC-DL-002`), so that join cannot become a view — it lives in
the shipped JS. A test that re-typed the query here would verify a copy, and the
copy is exactly what drifts. So the query is read out of the shipped module and
run against the real frozen DDL, the way `test_store_ddl_apply.py` reads the
version floor out of `config.js` instead of trusting that the two agree.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from .harness import append_assertion, append_confirmation, seed_child, seed_participant

JOURNAL_JS = Path(__file__).resolve().parents[2] / "m" / "v1" / "store" / "journal.js"

# The import date a legacy mark is stamped with, and the date it would carry if
# the importer were to invent an observation date instead. They are different on
# purpose: an assertion that only holds when they coincide proves nothing.
IMPORT_DATE = "2026-08-13"
OBSERVED_DATE = "2026-02-01"
OBSERVED_INSTANT = 1_770_000_000_000


def _js_string_constant(source: str, name: str) -> str:
    """Read a `const NAME = '...' + '...';` string out of shipped JavaScript.

    Fails closed in both directions: an absent constant and a constant whose
    right-hand side is not a concatenation of single-quoted literals both raise,
    because a parser that silently returns "" would turn every assertion built on
    it into a test of the empty string.
    """
    match = re.search(rf"^const {re.escape(name)} =(.*?);$", source, re.MULTILINE | re.DOTALL)
    if match is None:
        raise AssertionError(f"{JOURNAL_JS.name} declares no `const {name}`")
    body = match.group(1)
    parts = re.findall(r"'([^']*)'", body)
    if not parts:
        raise AssertionError(f"`const {name}` is not a concatenation of single-quoted literals")
    stripped = re.sub(r"'[^']*'", "", body)
    if re.search(r"[A-Za-z_$]", stripped):
        raise AssertionError(
            f"`const {name}` interpolates something this reader cannot see; the test would"
            " be running a different query from the app"
        )
    return "".join(parts)


@pytest.fixture
def marks_sql() -> str:
    """The projection query the app actually ships."""
    return _js_string_constant(JOURNAL_JS.read_text(encoding="utf-8"), "MARKS_SQL")


@pytest.fixture
def family(store: sqlite3.Connection) -> sqlite3.Connection:
    seed_participant(store, "p-self")
    seed_child(store, "c-1")
    return store


def _mark(
    conn: sqlite3.Connection,
    entry_id: str,
    *,
    author: str = "p-self",
    child_id: str = "c-1",
    skill_id: str = "sit",
    kind: str = "skill_observed",
    origin: str = "authored",
    effective_from: str = OBSERVED_DATE,
    entry_at_utc: int = 1000,
    event_at_utc: int | None = OBSERVED_INSTANT,
) -> str:
    """One mark as the write path writes it: an assertion AND its author's confirmation.

    The pairing is the point. It is written here as one helper so that no test in
    this module can accidentally exercise a lone assertion and call the result
    the write path's behaviour.
    """
    append_assertion(
        conn,
        entry_id,
        author,
        child_id,
        skill_id=skill_id,
        kind=kind,
        effective_from=effective_from,
        origin=origin,
        entry_at_utc=entry_at_utc,
        event_at_utc=event_at_utc,
        event_utc_offset_min=None if event_at_utc is None else 180,
    )
    append_confirmation(
        conn, f"{entry_id}-c", author, child_id, entry_id, "confirmed", entry_at_utc=entry_at_utc
    )
    return entry_id


# --- slot 9: the degenerate case is not a case ---------------------------


def test_consensus_of_one_is_not_special_cased(family: sqlite3.Connection) -> None:
    """PDR-021 — with one participant the general rule must already say "one"."""
    _mark(family, "j-1")

    row = family.execute(
        "SELECT confirmed_by, disputed_by, needs_refresh_by FROM v_assertion_consensus"
        " WHERE assertion_id = 'j-1'"
    ).fetchone()
    assert row["confirmed_by"] == 1, "one equal owner confirming their own mark IS one confirmation"
    assert row["disputed_by"] == 0
    assert row["needs_refresh_by"] == 0


def test_the_same_rule_counts_two_participants_without_a_second_code_path(
    family: sqlite3.Connection,
) -> None:
    """Anti-vacuity for the test above: the count is a count, not a constant."""
    seed_participant(family, "p-other", is_self=0)
    _mark(family, "j-1")
    append_confirmation(family, "j-1-c2", "p-other", "c-1", "j-1", "confirmed", entry_at_utc=2000)

    confirmed = family.execute(
        "SELECT confirmed_by FROM v_assertion_consensus WHERE assertion_id = 'j-1'"
    ).fetchone()["confirmed_by"]
    assert confirmed == 2, "the same view, the same query, one more participant"


# --- the migration's owner decision, at the level the app reads it --------


def test_an_authored_mark_and_a_migrated_mark_project_identically_but_for_origin(
    family: sqlite3.Connection, marks_sql: str
) -> None:
    """PDR-025 annotation 2026-08-12 — grandfathering was rejected, so the two agree.

    Compared field by field rather than by a single hand-picked column: the
    decision is that a migrated mark is indistinguishable from an authored one in
    everything except its stated provenance, and a test that checked only
    `confirmed_by` would pass while the two diverged everywhere else.
    """
    seed_child(family, "c-2")
    _mark(family, "j-authored", child_id="c-1", origin="authored")
    _mark(
        family,
        "j-migrated",
        child_id="c-2",
        origin="migrated_legacy",
        effective_from=IMPORT_DATE,
        event_at_utc=None,
    )

    authored = dict(family.execute(marks_sql, ("c-1",)).fetchone())
    migrated = dict(family.execute(marks_sql, ("c-2",)).fetchone())

    # The columns that must differ, and the reason each one differs.
    differ = {"child_id", "assertion_id", "origin", "effective_from_date"}
    assert set(authored) == set(migrated), "both project through the same query"
    for column in set(authored) - differ:
        assert authored[column] == migrated[column], (
            f"a migrated mark diverges from an authored one at {column!r}:"
            f" {migrated[column]!r} vs {authored[column]!r}"
        )
    assert authored["origin"] == "authored"
    assert migrated["origin"] == "migrated_legacy", "a migrated mark stays distinguishable forever"
    assert migrated["confirmed_by"] == 1, "the author's assertion, confirmed by one"


def test_a_migrated_mark_states_that_its_event_instant_is_unknown(
    family: sqlite3.Connection,
) -> None:
    """`event_date_local` is NOT NULL and a legacy mark has no date, so the fiction
    has to be detectable in the database rather than merely regretted in a comment.

    The import date goes in the NOT NULL column; the nullable instant stays NULL,
    which is the schema's own way of saying "only the date is known"; and `origin`
    says the date is an import artifact. All three together are what let the
    artifact refuse to present the import date as an observation date.
    """
    _mark(family, "j-1", origin="migrated_legacy", effective_from=IMPORT_DATE, event_at_utc=None)

    row = family.execute(
        "SELECT origin, event_date_local, event_at_utc, event_utc_offset_min"
        " FROM journal_entry WHERE id = 'j-1'"
    ).fetchone()
    assert row["origin"] == "migrated_legacy"
    assert row["event_date_local"] == IMPORT_DATE
    assert row["event_at_utc"] is None, "the moment of a legacy observation is not known"
    assert row["event_utc_offset_min"] is None

    authored = family.execute(
        "SELECT event_at_utc FROM journal_entry WHERE id = 'j-1-c'"
    ).fetchone()
    assert authored is not None, "the confirmation is part of the same act"


# --- append-only, exercised through the write path's own shape -----------


def test_a_revocation_supersedes_without_erasing(
    family: sqlite3.Connection, marks_sql: str
) -> None:
    """Un-ticking is a new assertion on top, never a delete (AGENTS.md append-only)."""
    _mark(family, "j-1", entry_at_utc=1000)
    _mark(family, "j-2", kind="skill_revoked", entry_at_utc=2000)

    rows = family.execute(marks_sql, ("c-1",)).fetchall()
    assert len(rows) == 1, "one row per (child, skill) — the later assertion wins"
    assert rows[0]["state"] == "skill_revoked"
    assert rows[0]["assertion_id"] == "j-2"
    assert rows[0]["confirmed_by"] == 1, "the revocation carries its own confirmation"

    assert family.execute("SELECT count(*) AS n FROM assertion").fetchone()["n"] == 2, (
        "the original observation is still in the journal"
    )


def test_a_re_observation_after_a_revocation_wins_again(
    family: sqlite3.Connection, marks_sql: str
) -> None:
    """Anti-vacuity: the projection follows (entry_at_utc, id), not "revoked sticks"."""
    _mark(family, "j-1", entry_at_utc=1000)
    _mark(family, "j-2", kind="skill_revoked", entry_at_utc=2000)
    _mark(family, "j-3", entry_at_utc=3000)

    row = family.execute(marks_sql, ("c-1",)).fetchone()
    assert row["state"] == "skill_observed"
    assert row["assertion_id"] == "j-3"


# --- the shipped query, checked for what it is supposed to be ------------


def test_the_shipped_marks_query_reads_state_and_consensus_together(marks_sql: str) -> None:
    """The join exists because the schema is frozen and a view would be a change."""
    assert "v_child_skill_state" in marks_sql, "state comes from the frozen projection view"
    assert "v_assertion_consensus" in marks_sql, "consensus is joined, not recomputed in JS"
    assert marks_sql.count("?") == 1, "the query is scoped to one child by parameter"
    for forbidden in ("INSERT", "UPDATE", "DELETE", "DROP"):
        assert forbidden not in marks_sql.upper(), "a projection reads and writes nothing"


def test_the_shipped_marks_query_scopes_to_one_child(
    family: sqlite3.Connection, marks_sql: str
) -> None:
    """A projection that ignored its parameter would pass every test above."""
    seed_child(family, "c-2")
    _mark(family, "j-1", child_id="c-1", skill_id="sit")
    _mark(family, "j-2", child_id="c-2", skill_id="walk")

    rows = family.execute(marks_sql, ("c-1",)).fetchall()
    assert [row["skill_id"] for row in rows] == ["sit"]
    assert [row["child_id"] for row in rows] == ["c-1"]
