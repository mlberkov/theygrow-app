"""LSC-P2-INV-001 — the journal is append-only, and the exceptions are exactly two.

Slot 10 of PDR-026 §4: marks and derived state are never overwritten; a change is
a new assertion on top. Two things are deliberately NOT append-only, and both are
asserted here so that "append-only" cannot quietly grow to cover them:
the diary record (rule 1: edited by overwrite) and the quote basis (slot 15:
erased when its record is finally deleted).
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
)

JOURNAL_TABLES = ("journal_entry", "assertion", "confirmation", "child_attribute")


@pytest.fixture
def seeded(store: sqlite3.Connection) -> sqlite3.Connection:
    author = seed_participant(store)
    child = seed_child(store)
    append_assertion(store, "j-1", author, child)
    append_confirmation(store, "j-2", author, child, "j-1")
    append_child_attribute(store, "j-3", author, child, "name", "Ася")
    store.commit()
    return store


@pytest.mark.parametrize("table", JOURNAL_TABLES)
def test_update_is_refused(seeded: sqlite3.Connection, table: str) -> None:
    column = "id" if table == "journal_entry" else "journal_id"
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        seeded.execute(f"UPDATE {table} SET {column} = {column}")


@pytest.mark.parametrize("table", JOURNAL_TABLES)
def test_delete_is_refused(seeded: sqlite3.Connection, table: str) -> None:
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        seeded.execute(f"DELETE FROM {table}")


def test_a_correction_is_a_new_entry_on_top(seeded: sqlite3.Connection) -> None:
    author, child = "p-self", "c-1"
    append_assertion(
        seeded,
        "j-4",
        author,
        child,
        kind="skill_revoked",
        supersedes="j-1",
        entry_at_utc=2000,
    )
    rows = seeded.execute("SELECT id FROM journal_entry ORDER BY seq").fetchall()
    assert [r["id"] for r in rows] == ["j-1", "j-2", "j-3", "j-4"], (
        "the superseded assertion must still be in the journal"
    )


def test_the_record_is_editable_by_overwrite(store: sqlite3.Connection) -> None:
    """Rule 1 of PDR-026 — append-only binds the mark journal, not diary text."""
    author = seed_participant(store)
    area = seed_area(store, owner=None)
    seed_record(store, "r-1", area, author, body="первый вариант")
    store.execute(
        "UPDATE record SET body = ?, updated_at_utc = 2000 WHERE id = ?", ("правка", "r-1")
    )
    assert store.execute("SELECT body FROM record WHERE id = 'r-1'").fetchone()["body"] == "правка"


def test_deleting_a_record_does_not_revoke_its_marks(store: sqlite3.Connection) -> None:
    """Rule 2 of PDR-026 — revocation is a separate action and a new assertion."""
    author = seed_participant(store)
    child = seed_child(store)
    area = seed_area(store, owner=None)
    seed_record(store, "r-1", area, author)
    append_assertion(store, "j-1", author, child, source_record_id="r-1")
    store.execute(
        "INSERT INTO assertion_quote (journal_id, private_to_participant_id, source_record_id,"
        " quote_text, copied_at_utc) VALUES ('j-1', ?, 'r-1', 'сел сам', 1500)",
        (author,),
    )

    store.execute("DELETE FROM record WHERE id = 'r-1'")

    assert store.execute("SELECT count(*) AS n FROM assertion").fetchone()["n"] == 1
    assert store.execute("SELECT count(*) AS n FROM assertion_quote").fetchone()["n"] == 0
    basis = store.execute(
        "SELECT basis FROM v_assertion_provenance WHERE assertion_id = 'j-1'"
    ).fetchone()["basis"]
    assert basis == "degraded", "an assertion whose basis was erased must say so (ADR-015)"
