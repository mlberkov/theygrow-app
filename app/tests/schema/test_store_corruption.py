"""Corruption detection and index rebuildability (ADR-046 §1, PDR-026 rule 4).

A journal that silently fails to record an observation breaks the single source
of truth invisibly, which is worse than a crash — so the disk-full path is
asserted to fail LOUDLY and to leave the journal exactly as it was.

AND ONE LEG MEASURES WHAT "FULL" MEANS, because an instrumented fixture was
arming a device leg on the answer and getting it wrong (DIA-DL-009). Fullness is
a property of the WRITE, not of the file: a ceiling that refuses a long row can
still take a short one, so an arming that stops at the first refusal has proved
the store full only for the size it happened to try. That is measured here, off
the device, in seconds — the run that found it on a device cost a dispatch.

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

# The sentence `DiaryEntryTest`'s disk-full leg writes, so the size measured here
# is the size that leg performs. Its TEXT is incidental and its LENGTH is not:
# twenty-six characters is what the device arming has to exhaust before that leg
# is a test of anything (DIA-DL-009). The two copies cannot share a source across
# the language boundary; what keeps them honest is that this one is named after
# the other and both are cited from the same decision.
ACT_SIZED_BODY = "Впервые сам встал у дивана"


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


def test_a_full_store_still_takes_a_row_of_the_next_size_down(
    on_disk: sqlite3.Connection,
) -> None:
    """ "Full" is a property of the next write, not of the file (DIA-DL-009).

    WHY THIS IS HERE RATHER THAN ONLY ON A DEVICE. `DiaryEntryTest` arms its
    disk-full leg by writing filler rows until one is refused, and then performs
    the act under test. Until this packet the filler stopped at 200 characters
    and the act writes 26, so the refusal that licensed the leg was a refusal of
    a row nearly eight times wider than the one being tested — and the act landed
    on a store the arming had just called full. A refusal bounds writes no wider
    than the one refused and reaches nothing narrower, so that is the unsound
    direction to arm in. Two dispatches spent on it: one red
    that showed it, and one earlier GREEN that was page layout rather than the
    property. This leg is the same question asked in seconds.

    WHAT IT ESTABLISHES, in the order the assertions make it:

    1. Each of three sizes reaches a refusal, and the refusal says `full`.
    2. AFTER the 200-character refusal, rows of the act's size still land. That
       is the defect stated as a positive fact, so it reds here first if the
       engine ever stops behaving this way.
    3. After the act-size refusal the store converges: ten more of that size are
       all refused. Without this, "arm until the act's size is refused" would be
       a rule with no reason to terminate.
    4. A JOURNAL write still lands after the record-shaped refusal — the shape
       half of the same lesson, which `DIA-DL-006` found on a device and which
       the arming's `journalRefusal` exists to answer.
    """
    author = seed_participant(on_disk)
    child = seed_child(on_disk)
    area = seed_area(on_disk, child_id=child)
    on_disk.commit()

    pages = on_disk.execute("PRAGMA page_count").fetchone()[0]
    on_disk.execute(f"PRAGMA max_page_count = {pages}")

    def fill(stage: str, body: str, budget: int) -> tuple[int, str]:
        """Rows of one size until one is refused — the device arming, off it.

        A row per transaction, as the app writes them: the ceiling bounds the
        FILE's pages, and a statement that is refused leaves the file no larger
        than it found it.
        """
        written = 0
        for attempt in range(budget):
            try:
                seed_record(on_disk, f"{stage}-{attempt}", area, author, body=body)
                on_disk.commit()
            except sqlite3.OperationalError as refusal:
                on_disk.rollback()
                return written, str(refusal)
            written += 1
        return written, ""

    landed: dict[str, int] = {}
    said: dict[str, str] = {}
    for stage, body, budget in (
        ("big", "я" * 8000, 400),
        ("small", "я" * 200, 400),
        ("act", ACT_SIZED_BODY, 400),
    ):
        landed[stage], said[stage] = fill(stage, body, budget)
        assert "full" in said[stage].lower(), (
            f"the {stage} stage never met a full store, so nothing measured below it is"
            f" about one: {landed[stage]} rows of {len(body)} characters landed within a"
            f" budget of {budget}, and the loop ended with {said[stage]!r}"
        )

    # 2. THE DEFECT, AS A POSITIVE FACT. The 200-character refusal above is the
    #    one the device fixture used to call the store full; these rows land
    #    after it.
    assert landed["act"] > 0, (
        "a store that refused a 200-character row refused a"
        f" {len(ACT_SIZED_BODY)}-character one too, so the size classes do not separate"
        " here and this leg can no longer explain the device defect it was written for"
        f" (big={landed['big']}, small={landed['small']}, act={landed['act']})"
    )

    # 3. AND IT CONVERGES. Ten more of the act's size, all refused: the rule the
    #    arming now follows has a floor to stop at.
    stubborn = 0
    for attempt in range(10):
        try:
            seed_record(on_disk, f"again-{attempt}", area, author, body=ACT_SIZED_BODY)
            on_disk.commit()
            stubborn += 1
        except sqlite3.OperationalError:
            on_disk.rollback()
    assert stubborn == 0, (
        f"{stubborn} of 10 rows of the act's size landed after that size was refused, so"
        " a refusal of the act's own size is not a state the store stays in and arming"
        f" to it would not terminate (big={landed['big']}, small={landed['small']},"
        f" act={landed['act']})"
    )

    # 4. THE SHAPE HALF, unchanged by any of this and re-measured beside it: the
    #    journal's own leaves had room the record's did not.
    before = on_disk.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"]
    try:
        append_assertion(
            on_disk, "j-after-the-refusal", author, child, skill_id="s-after", entry_at_utc=9
        )
        on_disk.commit()
    except sqlite3.OperationalError as refusal:
        on_disk.rollback()
        pytest.fail(
            "a store full for records refused a journal write as well, so the two shapes"
            f" no longer separate and DIA-DL-006's arming is measuring nothing: {refusal}"
        )
    after = on_disk.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"]
    assert after == before + 1, (
        f"the journal write neither refused nor landed: {before} entries before, {after} after"
    )


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
