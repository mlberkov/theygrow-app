"""Filing-cursor continuity — a resumable position over the journal (ADR-046 §1).

Background filing itself is L5. What has to be true HERE is that the journal
admits a stable, resumable cursor with no backward edits: the cursor advances
over LOCAL ARRIVAL order (`seq`), not over event time, which is what keeps it
correct when an entry about January is written in March — or, later, merged in
from another device.
"""

from __future__ import annotations

import sqlite3

import pytest

from .harness import append_assertion, seed_child, seed_participant


@pytest.fixture
def family(store: sqlite3.Connection) -> sqlite3.Connection:
    seed_participant(store, "p-self")
    seed_child(store, "c-1")
    return store


def _read_since(conn: sqlite3.Connection, cursor: str, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT je.seq AS seq, je.id AS id FROM journal_entry je"
        " WHERE je.seq > (SELECT last_seq FROM journal_cursor WHERE name = ?)"
        " ORDER BY je.seq LIMIT ?",
        (cursor, limit),
    ).fetchall()


def _advance(conn: sqlite3.Connection, cursor: str, seq: int) -> None:
    conn.execute(
        "INSERT INTO journal_cursor (name, last_seq, updated_at_utc) VALUES (?, ?, 1)"
        " ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq, updated_at_utc = 1",
        (cursor, seq),
    )


def test_seq_is_monotonic_and_never_reused(family: sqlite3.Connection) -> None:
    for i in range(5):
        append_assertion(family, f"j-{i}", "p-self", "c-1", skill_id=f"s{i}", entry_at_utc=i)
    seqs = [r["seq"] for r in family.execute("SELECT seq FROM journal_entry ORDER BY seq")]
    assert seqs == sorted(seqs) and len(set(seqs)) == 5
    assert (
        family.execute("SELECT seq FROM sqlite_sequence WHERE name = 'journal_entry'").fetchone()
        is not None
    ), "journal_entry must use AUTOINCREMENT so seq is never reused"


def test_a_cursor_resumes_without_gaps_or_duplicates(family: sqlite3.Connection) -> None:
    for i in range(6):
        append_assertion(family, f"j-{i}", "p-self", "c-1", skill_id=f"s{i}", entry_at_utc=i)
    _advance(family, "filing", 0)

    seen: list[str] = []
    batch = _read_since(family, "filing", 2)
    seen += [r["id"] for r in batch]
    _advance(family, "filing", batch[-1]["seq"])

    # Interruption: the next batch is read but never acknowledged.
    interrupted = _read_since(family, "filing", 2)
    assert [r["id"] for r in interrupted] == ["j-2", "j-3"]

    # Resume from the last ACKNOWLEDGED position — the unacknowledged batch is re-read.
    batch = _read_since(family, "filing", 10)
    seen += [r["id"] for r in batch]
    _advance(family, "filing", batch[-1]["seq"])

    assert seen == ["j-0", "j-1", "j-2", "j-3", "j-4", "j-5"]
    assert _read_since(family, "filing", 10) == []


def test_a_late_entry_about_an_early_date_still_lands_after_the_cursor(
    family: sqlite3.Connection,
) -> None:
    append_assertion(
        family, "j-new", "p-self", "c-1", skill_id="s1", effective_from="2026-05-01", entry_at_utc=1
    )
    _advance(family, "filing", 1)
    assert _read_since(family, "filing", 10) == []

    append_assertion(
        family,
        "j-old",
        "p-self",
        "c-1",
        skill_id="s2",
        effective_from="2026-01-01",
        entry_at_utc=2,
    )
    pending = _read_since(family, "filing", 10)
    assert [r["id"] for r in pending] == ["j-old"], (
        "the cursor orders by arrival, so an entry about an earlier date is still "
        "delivered — ordering by event time would silently skip it"
    )


def test_the_cursor_is_the_only_mutable_row_in_the_journal_area(
    family: sqlite3.Connection,
) -> None:
    append_assertion(family, "j-1", "p-self", "c-1", entry_at_utc=1)
    _advance(family, "filing", 1)
    _advance(family, "filing", 2)
    assert (
        family.execute("SELECT last_seq FROM journal_cursor WHERE name = 'filing'").fetchone()[
            "last_seq"
        ]
        == 2
    )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        family.execute("UPDATE journal_entry SET entry_at_utc = 5")
