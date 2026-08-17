"""The diary write path, against the real frozen DDL (DIA-P3).

WHAT THIS MODULE IS FOR, AND WHAT IT IS NOT. Every statement below is READ OUT
OF ``store/records.js`` and executed against the schema the device applies, for
the reason ``test_write_path_projection.py`` states about ``MARKS_SQL``: a query
re-typed in a test is a copy, and the copy is what drifts. So these tests carry
the claims about what the diary write path MEANS — what lands in which column,
what an overwrite touches and what it leaves, whose entries a read returns.

They do not carry claims about the app's control flow (that is
``app/tests/diary-write.spec.js``, which starts no product and proves statement
shape), nor about the plugin and SQLCipher actually doing it on a device (that
is ``android-instrumented``, DIA-P3 checkpoint 4). A claim needing two of those
boxes at once does not belong here.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from .harness import (
    append_assertion,
    current_mount,
    js_string_constant,
    seed_child,
    seed_participant,
)

RECORDS_JS = Path(__file__).resolve().parents[2] / "m" / current_mount() / "store" / "records.js"

AUTHOR = "p-self"
CHILD = "c-1"
OTHER_CHILD = "c-2"

# The day a parent writes ABOUT, and the day they write ON. Different on purpose
# throughout this module: an assertion that only holds when the two coincide
# would prove nothing about slot 11 (PDR-026 §4 amendment item 2).
MORNING = "2026-02-01"
WROTE_AT = 1_770_000_000_000
EDITED_AT = 1_770_000_600_000
OFFSET_MIN = 180

PRIVATE = "participant_private"
TEXT_KIND = "text"


CONFIG_JS = Path(__file__).resolve().parents[2] / "m" / current_mount() / "store" / "config.js"


def _sql(name: str) -> str:
    return js_string_constant(RECORDS_JS.read_text(encoding="utf-8"), name, RECORDS_JS.name)


def _knob(name: str) -> str:
    """A single-quoted STORE_CONFIG value, read out of the shipped knob surface."""
    match = re.search(
        rf"^\s*{re.escape(name)}: '([^']*)',", CONFIG_JS.read_text(encoding="utf-8"), re.MULTILINE
    )
    if match is None:
        raise AssertionError(f"{CONFIG_JS.name} declares no string knob `{name}`")
    return match.group(1)


@pytest.fixture
def records_sql() -> dict[str, str]:
    """The five statements the shipped diary path actually issues."""
    return {
        name: _sql(name)
        for name in (
            "AREA_LOOKUP_SQL",
            "AREA_INSERT_SQL",
            "AREA_CHILD_INSERT_SQL",
            "RECORD_INSERT_SQL",
            "RECORD_UPDATE_SQL",
            "RECORDS_SQL",
        )
    }


@pytest.fixture
def family(store: sqlite3.Connection) -> sqlite3.Connection:
    seed_participant(store, AUTHOR)
    seed_child(store, CHILD)
    return store


def _write(
    conn: sqlite3.Connection,
    sql: dict[str, str],
    record_id: str,
    *,
    area_id: str = "area-1",
    child_id: str = CHILD,
    body: str = "Впервые сам встал у дивана",
    event_date: str = MORNING,
    entry_at: int = WROTE_AT,
    create_area: bool = True,
) -> str:
    """One entry as the shipped path writes it: the area, its link, the record.

    Written as one helper so no test in this module can exercise a record
    without the container the app puts it in and then call that the write path.
    """
    if create_area:
        conn.execute(sql["AREA_INSERT_SQL"], (area_id, "diary", PRIVATE, AUTHOR, entry_at))
        conn.execute(sql["AREA_CHILD_INSERT_SQL"], (area_id, child_id))
    conn.execute(
        sql["RECORD_INSERT_SQL"],
        (record_id, area_id, AUTHOR, TEXT_KIND, body, event_date, entry_at, OFFSET_MIN, entry_at),
    )
    return record_id


# --- slot 11: the two times, held apart --------------------------------------


def test_an_entry_about_a_past_day_keeps_both_times(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """A parent writes in the evening about the morning, and the row says both."""
    _write(family, records_sql, "r-1", event_date=MORNING, entry_at=WROTE_AT)

    row = family.execute(
        "SELECT event_date_local, event_at_utc, event_utc_offset_min, entry_at_utc,"
        " entry_utc_offset_min, updated_at_utc FROM record WHERE id = 'r-1'"
    ).fetchone()

    assert row["event_date_local"] == MORNING, "the day the entry is about"
    assert row["entry_at_utc"] == WROTE_AT, "the moment it was written"
    assert row["entry_utc_offset_min"] == OFFSET_MIN
    assert row["updated_at_utc"] == WROTE_AT, "never edited yet, so the two agree"
    # The instant of the EVENT is unknown and says so, which the paired CHECK is
    # what makes expressible. Inventing `now` here would be false precision.
    assert row["event_at_utc"] is None
    assert row["event_utc_offset_min"] is None


def test_the_shipped_insert_declares_no_sensitivity(records_sql: dict[str, str]) -> None:
    """Slot 12 — 'never declared' is a value the write path must not overwrite."""
    insert = records_sql["RECORD_INSERT_SQL"]
    assert "sensitivity" in insert, "the column is named, so its NULL is deliberate"
    assert "'sensitive'" not in insert and "'not_sensitive'" not in insert, (
        "the write path declares a sensitivity the parent was never asked about"
    )


def test_an_undeclared_sensitivity_survives_the_write_path(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The statement above, executed: NULL reaches the column and stays there."""
    _write(family, records_sql, "r-1")
    assert (
        family.execute("SELECT sensitivity FROM record WHERE id = 'r-1'").fetchone()["sensitivity"]
        is None
    )


# --- rule 1: edited by overwrite, and the journal untouched by it -------------


def test_an_edit_overwrites_the_record_and_appends_nothing(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """PDR-026 §4 rule 1. The row changes in place; nothing is appended anywhere.

    The three columns are checked apart on purpose. `updated_at_utc` must move
    (a correction happened), `entry_at_utc` must NOT (the entry time is when the
    text was first written), and `event_date_local` must follow the parent's
    correction — an edit that could not move the day would make a mistyped date
    permanent.
    """
    _write(family, records_sql, "r-1", event_date=MORNING, entry_at=WROTE_AT)
    append_assertion(family, "j-1", AUTHOR, CHILD, skill_id="stand", source_record_id="r-1")
    journal_before = family.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"]

    family.execute(
        records_sql["RECORD_UPDATE_SQL"],
        ("Не у дивана, а у стула", "2026-01-31", EDITED_AT, "r-1"),
    )

    row = family.execute(
        "SELECT body, event_date_local, entry_at_utc, updated_at_utc FROM record WHERE id = 'r-1'"
    ).fetchone()
    assert row["body"] == "Не у дивана, а у стула", "the text is corrected in place"
    assert row["event_date_local"] == "2026-01-31", "the parent may correct the day too"
    assert row["entry_at_utc"] == WROTE_AT, "the entry time is when it was first written"
    assert row["updated_at_utc"] == EDITED_AT, "the change has its own timestamp"

    assert family.execute("SELECT count(*) AS n FROM record").fetchone()["n"] == 1, (
        "an overwrite is not an append — a second row would be a second entry"
    )
    assert family.execute("SELECT count(*) AS n FROM journal_entry").fetchone()["n"] == (
        journal_before
    ), "editing a diary entry appends nothing to the mark journal"
    assert family.execute("SELECT count(*) AS n FROM assertion").fetchone()["n"] == 1, (
        "and revokes nothing: the mark that cited this record is untouched"
    )


def test_the_retrieval_index_follows_an_overwrite(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """Rule 4 — the index is derived, so the trigger must have done the work.

    Nothing in the app re-indexes by hand, so if `record_fts_after_update` were
    ever dropped the old text would keep matching and the new text would not.
    """
    _write(family, records_sql, "r-1", body="ползёт по ковру")
    family.execute(records_sql["RECORD_UPDATE_SQL"], ("встал у дивана", MORNING, EDITED_AT, "r-1"))

    def search(term: str) -> list[str]:
        return [
            r["id"]
            for r in family.execute(
                "SELECT r.id AS id FROM record_fts f JOIN record r ON r.rowid = f.rowid"
                " WHERE record_fts MATCH ?",
                (term,),
            )
        ]

    assert search("встал") == ["r-1"], "the new text is findable"
    assert search("ползёт") == [], "the replaced text is not"


def test_an_edit_that_names_no_existing_entry_changes_nothing(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The zero-row case the shipped path refuses rather than reports as saved.

    `records.js` reads the change count and throws when it is zero; what is
    executed here is the SQL half — that the statement really does change no row
    and really does report so — because an UPDATE that silently hits nothing is
    the shape ADR-046 §1 is about.
    """
    _write(family, records_sql, "r-1", body="исходный текст")
    cursor = family.execute(
        records_sql["RECORD_UPDATE_SQL"], ("подмена", MORNING, EDITED_AT, "r-does-not-exist")
    )
    assert cursor.rowcount == 0, "the store must be able to say that it changed nothing"
    assert (
        family.execute("SELECT body FROM record WHERE id = 'r-1'").fetchone()["body"]
        == "исходный текст"
    ), "and it must not have touched somebody else's entry"


# --- the area bootstrap: the first code that ever creates one ----------------


def test_the_first_write_creates_a_private_area_owned_by_its_author(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """Slot 3 — and the visibility class the annotation of 2026-08-11 requires."""
    _write(family, records_sql, "r-1")

    area = family.execute("SELECT * FROM area").fetchone()
    assert area["visibility_class"] == PRIVATE, (
        "a diary entry is the author's own text; the shared journal never carries it"
    )
    assert area["owner_participant_id"] == AUTHOR, "a private area has exactly one owner"
    assert area["title"] == "diary"
    assert family.execute("SELECT count(*) AS n FROM area_child").fetchone()["n"] == 1, (
        "the child a record is about is reached through its area (slot 4)"
    )


def test_the_declared_visibility_is_the_private_one(store: sqlite3.Connection) -> None:
    """The knob's VALUE, not just its use — and the schema's opinion of it.

    Every test in this module binds the class by hand, so flipping
    `diaryAreaVisibility` to 'child_shared' would leave them all green while the
    shipped app wrote diary text into the set L7 may ship. Measured: that
    mutation was run, and before this test only the JavaScript spec went red.
    """
    declared = _knob("diaryAreaVisibility")
    assert declared == PRIVATE, (
        "a diary entry is the author's own text — PDR-026's annotation of"
        " 2026-08-11 keeps it in the author's private area so that a quote copied"
        " out of it cannot leak into a shared assertion"
    )
    # And the frozen CHECK accepts it, so the two cannot disagree silently.
    seed_participant(store, AUTHOR)
    store.execute(
        _sql("AREA_INSERT_SQL"), ("a-probe", _knob("diaryAreaTitle"), declared, AUTHOR, WROTE_AT)
    )
    assert (
        store.execute("SELECT visibility_class FROM area WHERE id = 'a-probe'").fetchone()[
            "visibility_class"
        ]
        == PRIVATE
    )


def test_the_second_write_reuses_the_area_the_lookup_finds(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The lookup is what makes the second write cheap; execute it, do not assume."""
    _write(family, records_sql, "r-1")

    found = family.execute(records_sql["AREA_LOOKUP_SQL"], (AUTHOR, CHILD, PRIVATE)).fetchone()
    assert found is not None, "the lookup must find the area the first write created"
    _write(family, records_sql, "r-2", area_id=found["id"], create_area=False)

    assert family.execute("SELECT count(*) AS n FROM area").fetchone()["n"] == 1, (
        "a second entry must not create a second diary"
    )
    assert family.execute("SELECT count(*) AS n FROM record").fetchone()["n"] == 2


def test_re_running_the_area_statements_is_a_no_op(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """What happens when two writes race: both mint an area and both insert.

    The single-threaded WebView makes the race hard to reach and the surface
    serialises saves on top of that, but "hard to reach" is not a property, so
    the outcome is written down. Re-running the SAME statements is a no-op by
    ON CONFLICT; two racers minting DIFFERENT ids leave two private areas for one
    child, which the read below shows costs no entry — the read is scoped by
    owner, child and class, never by one area id.
    """
    family.execute(records_sql["AREA_INSERT_SQL"], ("area-1", "diary", PRIVATE, AUTHOR, WROTE_AT))
    family.execute(records_sql["AREA_CHILD_INSERT_SQL"], ("area-1", CHILD))
    family.execute(records_sql["AREA_INSERT_SQL"], ("area-1", "diary", PRIVATE, AUTHOR, WROTE_AT))
    family.execute(records_sql["AREA_CHILD_INSERT_SQL"], ("area-1", CHILD))

    assert family.execute("SELECT count(*) AS n FROM area").fetchone()["n"] == 1
    assert family.execute("SELECT count(*) AS n FROM area_child").fetchone()["n"] == 1


def test_two_areas_for_one_child_still_yield_every_entry(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The race's actual cost, measured: an untidy row, and no lost entry."""
    _write(family, records_sql, "r-1", area_id="area-1", event_date="2026-02-01")
    _write(family, records_sql, "r-2", area_id="area-2", event_date="2026-02-02")

    rows = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, CHILD, PRIVATE, TEXT_KIND, 200)
    ).fetchall()
    assert [r["id"] for r in rows] == ["r-2", "r-1"], "both areas' entries, newest first"


def test_a_second_child_gets_a_diary_of_its_own(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """Slot 4 is per-area, so the lookup must miss for a child with no diary yet."""
    seed_child(family, OTHER_CHILD)
    _write(family, records_sql, "r-1", area_id="area-1", child_id=CHILD)

    assert (
        family.execute(records_sql["AREA_LOOKUP_SQL"], (AUTHOR, OTHER_CHILD, PRIVATE)).fetchone()
        is None
    ), "the second child's first write must not land in the first child's diary"

    _write(family, records_sql, "r-2", area_id="area-2", child_id=OTHER_CHILD)

    first = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, CHILD, PRIVATE, TEXT_KIND, 200)
    ).fetchall()
    second = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, OTHER_CHILD, PRIVATE, TEXT_KIND, 200)
    ).fetchall()
    assert [r["id"] for r in first] == ["r-1"]
    assert [r["id"] for r in second] == ["r-2"], "two children, two diaries, no leakage"


# --- the read ---------------------------------------------------------------


def test_the_read_is_scoped_to_one_author_and_one_child(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """A read that ignored its parameters would pass every test above."""
    seed_participant(family, "p-other", is_self=0)
    seed_child(family, OTHER_CHILD)
    _write(family, records_sql, "r-mine", area_id="area-1", child_id=CHILD)

    family.execute(
        records_sql["AREA_INSERT_SQL"], ("area-other", "diary", PRIVATE, "p-other", WROTE_AT)
    )
    family.execute(records_sql["AREA_CHILD_INSERT_SQL"], ("area-other", CHILD))
    family.execute(
        records_sql["RECORD_INSERT_SQL"],
        (
            "r-theirs",
            "area-other",
            "p-other",
            TEXT_KIND,
            "их текст",
            MORNING,
            WROTE_AT,
            OFFSET_MIN,
            WROTE_AT,
        ),
    )

    rows = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, CHILD, PRIVATE, TEXT_KIND, 200)
    ).fetchall()
    assert [r["id"] for r in rows] == ["r-mine"], (
        "one participant's private area is not another's, even about the same child"
    )


def test_the_read_orders_by_the_day_the_parent_named(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """Newest EVENT day first, and the writing moment only breaks ties.

    An entry written today about January belongs under January in a diary, even
    though it arrived last — the opposite of what the filing cursor needs, which
    is why the two orders are different queries (see test_store_cursor.py).
    """
    _write(family, records_sql, "r-jan", event_date="2026-01-05", entry_at=WROTE_AT + 900)
    _write(
        family,
        records_sql,
        "r-feb-early",
        area_id="area-1",
        create_area=False,
        event_date="2026-02-01",
        entry_at=WROTE_AT,
    )
    _write(
        family,
        records_sql,
        "r-feb-late",
        area_id="area-1",
        create_area=False,
        event_date="2026-02-01",
        entry_at=WROTE_AT + 500,
    )

    rows = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, CHILD, PRIVATE, TEXT_KIND, 200)
    ).fetchall()
    assert [r["id"] for r in rows] == ["r-feb-late", "r-feb-early", "r-jan"]


def test_the_read_honours_its_limit(
    family: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The limit bounds the RENDER; anti-vacuity for the ordering test above."""
    for n in range(5):
        _write(
            family,
            records_sql,
            f"r-{n}",
            area_id="area-1",
            create_area=n == 0,
            event_date=f"2026-02-0{n + 1}",
        )

    rows = family.execute(
        records_sql["RECORDS_SQL"], (AUTHOR, CHILD, PRIVATE, TEXT_KIND, 2)
    ).fetchall()
    assert [r["id"] for r in rows] == ["r-4", "r-3"], "the newest two, not an arbitrary two"


def test_the_read_writes_nothing(records_sql: dict[str, str]) -> None:
    """A projection reads and writes nothing — the same check MARKS_SQL carries.

    Matched on WORD BOUNDARIES, not as substrings. The naive form of this test
    went red on the shipped query for the wrong reason: the column
    `updated_at_utc` contains the letters of UPDATE, which is the over-matching
    substring failure AGENTS.md §11 records as defect 2 — and a check that reds
    on a legal query would have been silenced rather than fixed.
    """
    read = records_sql["RECORDS_SQL"].upper()
    assert read.startswith("SELECT "), "a projection is a SELECT"
    for forbidden in ("INSERT", "UPDATE", "DELETE", "DROP", "REPLACE"):
        assert re.search(rf"\b{forbidden}\b", read) is None, f"the diary read carries a {forbidden}"
