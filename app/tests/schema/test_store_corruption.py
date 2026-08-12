"""Corruption detection and index rebuildability (ADR-046 §1, PDR-026 rule 4).

A journal that silently fails to record an observation breaks the single source
of truth invisibly, which is worse than a crash — so the disk-full path is
asserted to fail LOUDLY and to leave the journal exactly as it was.

The tokenization assertions at the foot record MEASURED behaviour of the FTS5
`unicode61` tokenizer on Russian, including what it does NOT do. They exist so
that L2's word-form work starts from a fact rather than from an assumption; see
LSC-DL-002 on why ICU would not have closed that gap either.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from .harness import (
    append_assertion,
    apply_schema,
    connect,
    seed_area,
    seed_child,
    seed_participant,
    seed_record,
)


@pytest.fixture
def on_disk(tmp_path: Path) -> sqlite3.Connection:
    conn = connect(str(tmp_path / "store.db"))
    conn.execute("PRAGMA journal_mode = WAL")
    apply_schema(conn)
    conn.commit()
    return conn


def test_wal_mode_is_available_and_sticks(on_disk: sqlite3.Connection) -> None:
    mode = on_disk.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_integrity_check_passes_on_a_healthy_store(on_disk: sqlite3.Connection) -> None:
    assert on_disk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert on_disk.execute("PRAGMA foreign_key_check").fetchall() == []


def test_a_full_disk_fails_loudly_and_leaves_the_journal_intact(
    on_disk: sqlite3.Connection,
) -> None:
    seed_participant(on_disk, "p-self")
    seed_child(on_disk, "c-1")
    append_assertion(on_disk, "j-1", "p-self", "c-1", entry_at_utc=1)
    on_disk.commit()
    before = on_disk.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"]

    pages = on_disk.execute("PRAGMA page_count").fetchone()[0]
    on_disk.execute(f"PRAGMA max_page_count = {pages}")

    with pytest.raises(sqlite3.OperationalError) as excinfo:
        for i in range(2, 4000):
            append_assertion(on_disk, f"j-{i}", "p-self", "c-1", skill_id=f"s{i}", entry_at_utc=i)
        on_disk.commit()
    assert "full" in str(excinfo.value).lower(), (
        "the disk-full condition must surface as itself, not as a generic failure"
    )

    on_disk.rollback()
    on_disk.execute("PRAGMA max_page_count = 1073741823")
    after = on_disk.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"]
    assert after == before, "a failed append must leave no partial entry behind"
    assert on_disk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_the_index_is_fully_rebuildable_from_the_records(store: sqlite3.Connection) -> None:
    """Rule 4 — retrieval indexes are derived and recomputed on diary edits."""
    author = seed_participant(store)
    area = seed_area(store)
    seed_record(store, "r-1", area, author, body="сегодня сел сам без опоры")
    seed_record(store, "r-2", area, author, body="пробует ползти по-пластунски")

    def search(term: str) -> list[str]:
        return [
            row["id"]
            for row in store.execute(
                "SELECT r.id AS id FROM record_fts f JOIN record r ON r.rowid = f.rowid"
                " WHERE record_fts MATCH ? ORDER BY r.id",
                (term,),
            )
        ]

    assert search("сел") == ["r-1"]

    store.execute("UPDATE record SET body = ?, updated_at_utc = 2 WHERE id = 'r-1'", ("встал",))
    assert search("сел") == [], "an edited record must leave no stale index row"
    assert search("встал") == ["r-1"]

    before = search("встал")
    store.execute("INSERT INTO record_fts (record_fts) VALUES ('rebuild')")
    assert search("встал") == before, "a full rebuild must reproduce the incremental index"

    store.execute("DELETE FROM record WHERE id = 'r-2'")
    assert search("ползти") == []


def test_measured_russian_tokenization_behaviour(store: sqlite3.Connection) -> None:
    """What unicode61 DOES and does NOT do for Russian — recorded, not assumed."""
    author = seed_participant(store)
    area = seed_area(store)
    seed_record(store, "r-1", area, author, body="ЁЛКА растёт БЫСТРО")

    def matches(term: str) -> bool:
        hits = store.execute(
            "SELECT count(*) AS n FROM record_fts WHERE record_fts MATCH ?", (term,)
        ).fetchone()["n"]
        return int(hits) > 0

    assert matches("ёлка"), "Cyrillic case folding works"
    assert matches("БЫСТРО") and matches("быстро")
    assert not matches("елка"), (
        "ё is NOT folded to е — remove_diacritics is Latin-script only. This is the "
        "L2 word-form gap; ICU would not have closed it either (LSC-DL-002)"
    )
    assert not matches("растет"), "ё/е normalization is an L2 decision, not a schema one"
