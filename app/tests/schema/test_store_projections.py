"""Derived state is a projection of the journal — never a stored snapshot.

Rule 3 of PDR-026 §4. Everything a naive design would store as mutable state
(current skill state, stopped-time, confirmation status, consensus, provenance)
is a view here, so "state at any past date" is a query rather than an archive.
"""

from __future__ import annotations

import sqlite3

import pytest

from .harness import (
    append_assertion,
    append_child_attribute,
    append_confirmation,
    seed_area,
    seed_child,
    seed_participant,
    seed_record,
    set_as_of,
)


@pytest.fixture
def family(store: sqlite3.Connection) -> sqlite3.Connection:
    seed_participant(store, "p-self")
    seed_child(store, "c-1")
    return store


def test_state_at_a_past_date_is_reconstructed_from_the_journal(
    family: sqlite3.Connection,
) -> None:
    append_assertion(
        family, "j-1", "p-self", "c-1", skill_id="sit", effective_from="2026-01-10", entry_at_utc=1
    )
    append_assertion(
        family,
        "j-2",
        "p-self",
        "c-1",
        skill_id="sit",
        kind="skill_revoked",
        effective_from="2026-03-01",
        supersedes="j-1",
        entry_at_utc=2,
    )
    append_assertion(
        family,
        "j-3",
        "p-self",
        "c-1",
        skill_id="walk",
        effective_from="2026-02-01",
        entry_at_utc=3,
    )

    def state_at(date: str) -> dict[str, str]:
        set_as_of(family, date)
        return {
            r["skill_id"]: r["state"]
            for r in family.execute("SELECT skill_id, state FROM v_child_skill_state")
        }

    assert state_at("2026-01-05") == {}
    assert state_at("2026-01-15") == {"sit": "skill_observed"}
    assert state_at("2026-02-15") == {"sit": "skill_observed", "walk": "skill_observed"}
    assert state_at("2026-03-15") == {"sit": "skill_revoked", "walk": "skill_observed"}


def test_derived_state_carries_subject_and_visibility(family: sqlite3.Connection) -> None:
    """Slot 2 — subject plus visibility class on derived state."""
    append_assertion(family, "j-1", "p-self", "c-1", skill_id="sit")
    set_as_of(family, "9999-12-31")
    row = family.execute("SELECT * FROM v_child_skill_state").fetchone()
    assert row["child_id"] == "c-1"
    assert row["visibility_class"] == "child_shared"
    assert row["asserted_by"] == "p-self"


def test_backward_propagation_is_recorded_not_materialised(
    family: sqlite3.Connection,
) -> None:
    """Slot 7 — the intent is stored on the assertion; the implication is computed.

    Materialising implied prerequisites as journal rows would fabricate assertions
    the parent never made, which slot 1 (a mark is an ATTRIBUTED assertion) forbids.
    So the journal holds exactly the marks that were authored, and the propagation
    flag tells the projection what to imply.
    """
    append_assertion(
        family, "j-1", "p-self", "c-1", skill_id="walk", propagation="implies_prerequisites"
    )
    assert family.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"] == 1
    assert (
        family.execute(
            "SELECT prerequisite_propagation FROM assertion WHERE journal_id = 'j-1'"
        ).fetchone()["prerequisite_propagation"]
        == "implies_prerequisites"
    )
    with pytest.raises(sqlite3.IntegrityError):
        family.execute(
            "UPDATE assertion SET prerequisite_propagation = 'both' WHERE journal_id = 'j-1'"
        )


def test_stopped_time_is_per_child_reversible_and_shared(
    family: sqlite3.Connection,
) -> None:
    """Slot 8 (PDR-024 §3) — one flag per child, no per-participant state."""
    default = family.execute(
        "SELECT stopped_time FROM v_child_stopped_time WHERE child_id = 'c-1'"
    ).fetchone()
    assert default["stopped_time"] == "off"

    append_child_attribute(family, "j-1", "p-self", "c-1", "stopped_time", "on", entry_at_utc=1)
    assert (
        family.execute(
            "SELECT stopped_time FROM v_child_stopped_time WHERE child_id = 'c-1'"
        ).fetchone()["stopped_time"]
        == "on"
    )

    append_child_attribute(family, "j-2", "p-self", "c-1", "stopped_time", "off", entry_at_utc=2)
    assert (
        family.execute(
            "SELECT stopped_time FROM v_child_stopped_time WHERE child_id = 'c-1'"
        ).fetchone()["stopped_time"]
        == "off"
    ), "the flag is reversible"

    columns = {r["name"] for r in family.execute("PRAGMA table_info(v_child_stopped_time)")}
    assert "participant_id" not in columns, (
        "stopped-time is identical for every family-contour participant — a "
        "per-participant column would make it a per-user setting"
    )


def test_migrated_mark_is_authors_assertion_confirmed_by_one(
    family: sqlite3.Connection,
) -> None:
    """Slot 9 — the owner's decision; grandfathering was rejected."""
    append_assertion(family, "j-1", "p-self", "c-1", skill_id="sit", origin="migrated_legacy")
    append_confirmation(family, "j-2", "p-self", "c-1", "j-1", "confirmed")

    row = family.execute(
        "SELECT confirmed_by FROM v_assertion_consensus WHERE assertion_id = 'j-1'"
    ).fetchone()
    assert row["confirmed_by"] == 1, "consensus degenerates to one under a single owner"
    origin = family.execute("SELECT origin FROM journal_entry WHERE id = 'j-1'").fetchone()[
        "origin"
    ]
    assert origin == "migrated_legacy", "a migrated mark stays distinguishable forever"


def test_dispute_does_not_erase_the_original_assertion(family: sqlite3.Connection) -> None:
    """Slot 13 — refresh status is a new row, never an edit."""
    append_assertion(family, "j-1", "p-self", "c-1", skill_id="sit")
    append_confirmation(family, "j-2", "p-self", "c-1", "j-1", "confirmed", entry_at_utc=1)
    append_confirmation(family, "j-3", "p-self", "c-1", "j-1", "needs_refresh", entry_at_utc=2)

    status = family.execute(
        "SELECT status FROM v_assertion_status WHERE assertion_id = 'j-1'"
    ).fetchall()
    assert [r["status"] for r in status] == ["needs_refresh"], "latest status per participant wins"
    assert family.execute("SELECT count(*) AS n FROM assertion").fetchone()["n"] == 1
    assert family.execute("SELECT count(*) AS n FROM confirmation").fetchone()["n"] == 2


def test_the_shared_journal_carries_no_quote_and_no_private_entry(
    family: sqlite3.Connection,
) -> None:
    """Slot 15 — the quote-basis stays in the author's private area."""
    area = seed_area(family, "a-priv", visibility="participant_private", owner="p-self")
    seed_record(family, "r-1", area, "p-self", body="сегодня сел сам")
    append_assertion(family, "j-1", "p-self", "c-1", skill_id="sit", source_record_id="r-1")
    append_assertion(
        family, "j-2", "p-self", "c-1", skill_id="crawl", visibility="participant_private"
    )
    family.execute(
        "INSERT INTO assertion_quote (journal_id, private_to_participant_id, source_record_id,"
        " quote_text, copied_at_utc) VALUES ('j-1', 'p-self', 'r-1', 'сегодня сел сам', 1500)"
    )

    shared = family.execute("SELECT * FROM v_shared_journal").fetchall()
    assert [r["id"] for r in shared] == ["j-1"], "a private assertion never enters the shared set"
    assert all("quote" not in key for key in shared[0].keys()), (
        "the shared journal must expose no quote column at all"
    )
    basis = family.execute(
        "SELECT basis FROM v_assertion_provenance WHERE assertion_id = 'j-1'"
    ).fetchone()["basis"]
    assert basis == "quoted"


def test_provenance_degrades_honestly_rather_than_lying(family: sqlite3.Connection) -> None:
    area = seed_area(family, "a-1")
    seed_record(family, "r-1", area, "p-self")
    append_assertion(family, "j-plain", "p-self", "c-1", skill_id="a")
    append_assertion(family, "j-ptr", "p-self", "c-1", skill_id="b", source_record_id="r-1")
    append_assertion(family, "j-gone", "p-self", "c-1", skill_id="c", source_record_id="r-missing")

    basis = {
        r["assertion_id"]: r["basis"]
        for r in family.execute("SELECT assertion_id, basis FROM v_assertion_provenance")
    }
    assert basis == {"j-plain": "none", "j-ptr": "record_pointer", "j-gone": "degraded"}


def test_the_child_profile_is_a_projection_of_attribute_events(
    family: sqlite3.Connection,
) -> None:
    append_child_attribute(family, "j-1", "p-self", "c-1", "name", "Ася", entry_at_utc=1)
    append_child_attribute(
        family, "j-2", "p-self", "c-1", "birthdate", "2025-06-01", entry_at_utc=2
    )
    append_child_attribute(family, "j-3", "p-self", "c-1", "name", "Анастасия", entry_at_utc=3)

    row = family.execute("SELECT * FROM v_child_profile WHERE child_id = 'c-1'").fetchone()
    assert row["name"] == "Анастасия", "the latest attribute event wins"
    assert row["birthdate"] == "2025-06-01"
    assert family.execute("SELECT count(*) AS n FROM child_attribute").fetchone()["n"] == 3
