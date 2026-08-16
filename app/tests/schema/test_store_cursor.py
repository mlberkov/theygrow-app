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


# --- the diary, which is NOT on the journal spine (DIA-P3) -------------------
#
# ADR-046 §1.3's 2026-08-14 annotation records that a durable filing cursor must
# remain possible without a backward schema edit, and has no vault evidence that
# it does. The tests above settle that for `journal_entry`. They do not settle it
# for the DIARY, and L5 filing reads diary text: a `record` is not a journal row,
# has no `seq`, and nothing in `journal_entry` points at one. So the question is
# asked again here, of the object that will actually be filed.


def test_a_record_offers_no_reusable_arrival_counter(
    family: sqlite3.Connection,
) -> None:
    """Why the answer is NOT `record.rowid`, demonstrated rather than asserted.

    `journal_entry.seq` is AUTOINCREMENT, which is exactly the promise that a
    value is never handed out twice. `record` has only the implicit rowid, and a
    record is deletable BY SPECIFICATION (PDR-026 §4 rule 1 and amendment item
    6). Delete the highest row and the next insert takes its number back — a
    cursor holding that number would skip the new entry entirely.
    """
    from .harness import seed_area, seed_record

    area = seed_area(
        family, "a-1", visibility="participant_private", owner="p-self", child_id="c-1"
    )
    seed_record(family, "r-1", area, "p-self", body="первая")
    highest = family.execute("SELECT max(rowid) AS n FROM record").fetchone()["n"]

    family.execute("DELETE FROM record WHERE id = 'r-1'")
    seed_record(family, "r-2", area, "p-self", body="вторая")
    reused = family.execute("SELECT rowid FROM record WHERE id = 'r-2'").fetchone()["rowid"]

    assert reused == highest, (
        "rowid came back around, so a filing cursor over it would skip r-2 —"
        " this is the reason the diary cursor is keyed on (entry_at_utc, id)"
    )


def test_a_diary_cursor_resumes_on_entry_time_with_no_schema_edit(
    family: sqlite3.Connection,
) -> None:
    """The shape that IS available today, executed end to end.

    Two facts together answer §1.3 for the diary: `(entry_at_utc, id)` is the
    same total order every projection in the frozen schema already uses, and
    `schema_meta` is a mutable key/value table, so the position has somewhere
    durable to live. No column is added, no table is created, and nothing about
    this is a migration — which is the whole claim being checked.
    """
    from .harness import seed_area

    area = seed_area(
        family, "a-1", visibility="participant_private", owner="p-self", child_id="c-1"
    )

    def write(record_id: str, entry_at: int, event_date: str) -> None:
        family.execute(
            "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
            " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
            " VALUES (?, ?, 'p-self', 'text', 'текст', ?, ?, 180, ?)",
            (record_id, area, event_date, entry_at, entry_at),
        )

    def read_after(position: tuple[int, str], limit: int) -> list[tuple[int, str]]:
        rows = family.execute(
            "SELECT entry_at_utc, id FROM record"
            " WHERE (entry_at_utc, id) > (?, ?)"
            " ORDER BY entry_at_utc, id LIMIT ?",
            (position[0], position[1], limit),
        ).fetchall()
        return [(r["entry_at_utc"], r["id"]) for r in rows]

    def advance(position: tuple[int, str]) -> None:
        family.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('diary_filing_cursor', ?)"
            " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (f"{position[0]}\x1f{position[1]}",),
        )

    def position() -> tuple[int, str]:
        row = family.execute(
            "SELECT value FROM schema_meta WHERE key = 'diary_filing_cursor'"
        ).fetchone()
        if row is None:
            return (0, "")
        at, _, record_id = str(row["value"]).partition("\x1f")
        return (int(at), record_id)

    # Two entries written in the same millisecond, which is what forces the id
    # tie-break: a cursor holding only a timestamp would deliver one of these
    # twice or neither.
    write("r-a", 1000, "2026-02-01")
    write("r-b", 1000, "2026-02-01")
    write("r-c", 1001, "2026-02-02")

    seen: list[str] = []
    batch = read_after(position(), 2)
    seen += [record_id for _, record_id in batch]
    advance(batch[-1])

    # Interrupted: read but never acknowledged, so the next resume re-reads it.
    assert [record_id for _, record_id in read_after(position(), 10)] == ["r-c"]

    batch = read_after(position(), 10)
    seen += [record_id for _, record_id in batch]
    advance(batch[-1])

    assert seen == ["r-a", "r-b", "r-c"], "no gap and no duplicate across the resume"
    assert read_after(position(), 10) == []

    # An entry written LATER about an EARLIER day still arrives after the cursor,
    # which is the property that makes the order right for filing.
    write("r-old", 1002, "2026-01-01")
    assert [record_id for _, record_id in read_after(position(), 10)] == ["r-old"]
