"""What a search over the diary actually matches (DIA-P4).

WHAT THIS MODULE IS FOR. ADR-046 §2.5 left the Russian word-form question to this
milestone, and the answer had to be MEASURED rather than asserted — the precedent
being ``StoreEngineTest::russian_tokenization_behaves_as_measured_off_device``,
which hands L2 a fact about the tokenizer instead of an assumption. This module is
that measurement, one layer up: not what the tokenizer does with a body, but what
a parent's typed query finds once the shipped builder has turned it into an FTS5
expression and the shipped statement has run it against the frozen DDL.

BOTH HALVES ARE THE SHIPPED ONES, AND NEITHER IS RE-TYPED HERE. The statements are
read out of ``store/records.js`` through ``js_string_constant`` for the reason
``test_write_path_projection.py`` states about ``MARKS_SQL``; the MATCH expression
is produced by running the shipped ``buildDiaryMatch`` under ``node``
(``diary-match.mjs``), because a query rule re-typed in Python is the same copy in
a different language.

WHAT IT DOES NOT CARRY. Not the app's control flow — that the surface asks with
this author and this child, renders results, and repairs the index once per
session is ``app/tests/diary-search.spec.js``. Not the device — that SQLCipher's
own FTS5 build behaves this way, and what the repair COSTS a parent in
milliseconds, is ``StoreEngineTest`` and ``DiaryEntryTest`` on
``android-instrumented``. A claim needing two of those boxes at once does not
belong here.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from .harness import current_mount, js_string_constant, seed_child, seed_participant

RECORDS_JS = Path(__file__).resolve().parents[2] / "m" / current_mount() / "store" / "records.js"
MATCH_DRIVER = Path(__file__).resolve().parent / "diary-match.mjs"

PRIVATE = "participant_private"
TEXT_KIND = "text"
LIMIT = 50

# Two parents and two children, because the scoping claim (DIA-P4-INV-001) is
# unfalsifiable with one of either: `record_fts` indexes every record in the
# store, so a search that returned the whole index would pass a single-family
# fixture and leak the other parent's diary on a real device.
SELF = "p-self"
OTHER = "p-other"
CHILD = "c-1"
OTHER_CHILD = "c-2"

# The corpus. Ordinary sentences a parent would write, chosen so that every row
# of the word-form table below has something to hit and something to miss.
CORPUS = {
    "r-sel": "Сегодня сел сам и держался",
    "r-elka": "Ёлка растёт быстро",
    "r-posla": "Пошла первый раз без рук",
    "r-reb": "Ребёнок сказал новое слово",
    "r-spal": "Спал днём два часа",
}
OTHER_PARENT_ENTRY = "Сел и заплакал у меня на руках"
OTHER_CHILD_ENTRY = "Села рядом с котом"


def _sql(name: str) -> str:
    return js_string_constant(RECORDS_JS.read_text(encoding="utf-8"), name, RECORDS_JS.name)


@pytest.fixture(scope="module")
def records_sql() -> dict[str, str]:
    """The three statements the shipped search path issues."""
    return {
        name: _sql(name) for name in ("RECORD_SEARCH_SQL", "RECORD_COUNT_SQL", "FTS_REBUILD_SQL")
    }


@pytest.fixture(scope="module")
def rebuild_command() -> str:
    """The rebuild verb, bound as a value by the shipped module rather than inline."""
    return _sql("FTS_REBUILD_COMMAND")


class Matcher:
    """Builds MATCH expressions by running the SHIPPED builder under node.

    Batched into one node invocation per test session: the driver copies the
    store modules into a temp root and verifies every copy, which is not work to
    repeat per query.
    """

    def __init__(self) -> None:
        self._built: dict[str, str] = {}

    def prime(self, queries: list[str]) -> None:
        node = shutil.which("node")
        assert node is not None, "node is required to build the query with the shipped builder"
        result = subprocess.run(
            [node, str(MATCH_DRIVER), json.dumps(queries, ensure_ascii=False)],
            capture_output=True,
            check=True,
            text=True,
        )
        self._built.update(json.loads(result.stdout))

    def __call__(self, typed: str) -> str:
        if typed not in self._built:
            self.prime([typed])
        return self._built[typed]


@pytest.fixture(scope="module")
def match() -> Matcher:
    return Matcher()


@pytest.fixture
def diary(store: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Two parents, two children, and one private diary area each."""
    seed_participant(store, SELF, is_self=1)
    seed_participant(store, OTHER, is_self=0)
    seed_child(store, CHILD)
    seed_child(store, OTHER_CHILD)

    areas = [("a-self", SELF, CHILD), ("a-other", OTHER, CHILD), ("a-self-2", SELF, OTHER_CHILD)]
    for area_id, owner, child in areas:
        store.execute(
            "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
            " VALUES (?, 'diary', ?, ?, 1000)",
            (area_id, PRIVATE, owner),
        )
        store.execute("INSERT INTO area_child (area_id, child_id) VALUES (?, ?)", (area_id, child))

    rows = [(rid, "a-self", SELF, body) for rid, body in CORPUS.items()]
    rows.append(("r-other-parent", "a-other", OTHER, OTHER_PARENT_ENTRY))
    rows.append(("r-other-child", "a-self-2", SELF, OTHER_CHILD_ENTRY))
    for record_id, area_id, author, body in rows:
        store.execute(
            "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
            " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
            " VALUES (?, ?, ?, 'text', ?, '2026-02-01', 1000, 180, 1000)",
            (record_id, area_id, author, body),
        )
    yield store


def _search(
    conn: sqlite3.Connection,
    sql: dict[str, str],
    expression: str,
    *,
    owner: str = SELF,
    child: str = CHILD,
) -> list[str]:
    rows = conn.execute(
        sql["RECORD_SEARCH_SQL"], (expression, owner, child, PRIVATE, TEXT_KIND, LIMIT)
    ).fetchall()
    return [row["id"] for row in rows]


# --- the word-form measurement -----------------------------------------------
#
# THE `found` COLUMN IS THE POINT, INCLUDING WHERE IT IS EMPTY. A search without
# lemmatisation has systematic misses, and the parent is told about them in the
# surface (ADR-015) because they are recorded here first. Every row runs the
# SHIPPED builder against the SHIPPED statement on the real frozen DDL.

WORD_FORMS = [
    # typed,        found,              why this row exists
    ("сел", ["r-sel"], "the word as written"),
    ("села", ["r-sel"], "a feminine past tense the parent did not write"),
    ("сели", ["r-sel"], "a plural the parent did not write"),
    ("растут", ["r-elka"], "a different person and number"),
    ("растёт", ["r-elka"], "the word as written, with its ё"),
    ("растет", ["r-elka"], "the same word spelled without the ё"),
    ("ёлка", ["r-elka"], "the ё spelling of an indexed ё"),
    ("елка", ["r-elka"], "the е spelling of an indexed ё — the LSC-DL-002 gap, closed"),
    ("ребенок", ["r-reb"], "four spellings searched at once"),
    ("пошёл", ["r-posla"], "a masculine past tense against a feminine one"),
    ("спать", ["r-spal"], "an infinitive against a past tense"),
    ("книжка", [], "a word nobody wrote"),
    # THE MISSES. Not defects — the boundary of a prefix scheme, measured. Every
    # one is a word whose STEM changed, which is what a lemmatiser would have
    # bought and what ICU would NOT have (LSC-DL-002).
    ("сесть", [], "сес- against сел-: the stem itself moved"),
    ("пойти", [], "пой- against пош-"),
    ("спит", [], "спи- against спа-"),
    # THE OVER-MATCH, asserted rather than hidden. This is the price of the three
    # rows above being the only misses; see the ceiling test below.
    ("сельский", ["r-sel"], "a real extra result the parent will see and skim past"),
]


@pytest.mark.parametrize("typed,expected,why", WORD_FORMS, ids=[row[0] for row in WORD_FORMS])
def test_word_forms_behave_as_measured(
    diary: sqlite3.Connection,
    records_sql: dict[str, str],
    match: Matcher,
    typed: str,
    expected: list[str],
    why: str,
) -> None:
    assert _search(diary, records_sql, match(typed)) == expected, why


def test_a_longer_prefix_would_lose_forms_a_parent_actually_types(
    diary: sqlite3.Connection, records_sql: dict[str, str], match: Matcher
) -> None:
    """The ceiling is a choice between two failures, and both are executed here.

    Without this the value in ``store/config.js`` reads as a preference. It is
    not. A prefix bridges the END of a word, so a query LONGER than what was
    written cannot reach it unless the ceiling cuts both down — which is exactly
    what raising the ceiling stops doing. The expressions here are built by hand
    at the rejected setting, the only place in this module that does not use the
    shipped default, because the point IS what the other setting does.
    """
    # At five, four ordinary queries stop finding entries that are right there.
    for expression, lost in (
        ('("села"* OR "сёла"*)', "r-sel"),
        ('("спать"*)', "r-spal"),
        ('("пошел"* OR "пошёл"*)', "r-posla"),
        ('("расту"*)', "r-elka"),
    ):
        assert _search(diary, records_sql, expression) == [], f"{lost} would still be reachable"

    # At the shipped ceiling every one of them is found.
    for typed, found in (
        ("села", "r-sel"),
        ("спать", "r-spal"),
        ("пошёл", "r-posla"),
        ("растут", "r-elka"),
    ):
        assert _search(diary, records_sql, match(typed)) == [found]

    # And what it costs is this, in full: one extra entry on one query.
    assert _search(diary, records_sql, match("сельский")) == ["r-sel"]


def test_all_the_words_must_appear(
    diary: sqlite3.Connection, records_sql: dict[str, str], match: Matcher
) -> None:
    """Two words typed mean both are wanted, which is what a search box means."""
    assert _search(diary, records_sql, match("сел сам")) == ["r-sel"]
    assert _search(diary, records_sql, match("сел кот")) == []


# --- what a parent may type without breaking anything ------------------------


@pytest.mark.parametrize(
    "typed",
    ['сел "OR', "сел*", "сел -сам", "сел (сам)", "сел^ NEAR", 'сел "', "раз_два"],
    ids=["quote", "star", "minus", "paren", "caret", "lone-quote", "underscore"],
)
def test_fts5_syntax_a_parent_types_is_not_an_operator(
    diary: sqlite3.Connection, records_sql: dict[str, str], match: Matcher, typed: str
) -> None:
    """No punctuation a parent writes can become a syntax error or an operator.

    THIS IS THE LEG THAT KEEPS A SEARCH FROM DYING IN FRONT OF SOMEONE WHO DID
    NOTHING WRONG. FTS5's query grammar gives ``"``, ``*``, ``-``, ``(``, ``^``
    and bare ``NEAR`` meanings; a parent writing about their child uses several
    of them as ordinary punctuation. Every term is quoted and every non-token
    character is dropped before the expression is built, so all of these run.
    """
    _search(diary, records_sql, match(typed))  # must not raise


def test_a_query_with_no_words_is_not_searched_at_all(match: Matcher) -> None:
    """An empty MATCH is a syntax error, so the builder returns nothing to run."""
    for typed in ("", "   ", "!!!", "…"):
        assert match(typed) == ""


# --- DIA-P4-INV-001: whose diary this is -------------------------------------


def test_a_search_returns_only_this_parents_records_for_this_child(
    diary: sqlite3.Connection, records_sql: dict[str, str], match: Matcher
) -> None:
    """The index spans the store; the search does not.

    ``сел`` matches three rows in ``record_fts`` — this parent's entry, the other
    parent's private entry about the same child, and this parent's entry about
    the other child. Each scope returns exactly its own.
    """
    everything = diary.execute(
        "SELECT count(*) AS n FROM record_fts WHERE record_fts MATCH ?", ('("сел"* OR "сёл"*)',)
    ).fetchone()["n"]
    assert everything == 3, "the fixture must span the boundary for this test to mean anything"

    assert _search(diary, records_sql, match("сел")) == ["r-sel"]
    assert _search(diary, records_sql, match("сел"), owner=OTHER) == ["r-other-parent"]
    assert _search(diary, records_sql, match("сел"), child=OTHER_CHILD) == ["r-other-child"]


def test_the_count_is_scoped_the_same_way(
    diary: sqlite3.Connection, records_sql: dict[str, str]
) -> None:
    """The precondition on the repair must not see another family's rows either."""
    counted = diary.execute(records_sql["RECORD_COUNT_SQL"], (SELF, CHILD, PRIVATE, TEXT_KIND))
    assert counted.fetchone()["n"] == len(CORPUS)


# --- DIA-P4-INV-003: the index is derived ------------------------------------


def test_a_destroyed_index_is_repaired_by_the_shipped_rebuild(
    diary: sqlite3.Connection,
    records_sql: dict[str, str],
    rebuild_command: str,
    match: Matcher,
) -> None:
    """The whole substance ADR-046 §2.5 secured, executed.

    The index holds no normalisation decision and no data of its own, so losing
    it entirely costs a rebuild and never a migration. ``delete-all`` is FTS5's
    own way of emptying an external-content index, which makes this a real loss
    rather than a simulated one.
    """
    assert _search(diary, records_sql, match("сел")) == ["r-sel"]

    diary.execute("INSERT INTO record_fts (record_fts) VALUES ('delete-all')")
    assert _search(diary, records_sql, match("сел")) == [], "the index survived delete-all"

    diary.execute(records_sql["FTS_REBUILD_SQL"], (rebuild_command,))
    assert _search(diary, records_sql, match("сел")) == ["r-sel"]
    # And the journal is untouched by all of it: the index is derived FROM the
    # records, so a rebuild reads them and writes nothing back.
    assert diary.execute("SELECT count(*) AS n FROM record").fetchone()["n"] == len(CORPUS) + 2


def test_counting_the_index_cannot_detect_that_it_is_empty(
    diary: sqlite3.Connection, records_sql: dict[str, str], match: Matcher
) -> None:
    """The obvious staleness probe is VACUOUS here, and this is why it is not used.

    ``record_fts`` is an external-content table, so ``count(*)`` over it counts
    the CONTENT table — the records — and reports the same number whether the
    index is whole or empty. Written down as an executed assertion rather than as
    a warning in a comment, because the next reader to reach for a cheap probe
    will reach for this one.
    """
    before = diary.execute("SELECT count(*) AS n FROM record_fts").fetchone()["n"]
    diary.execute("INSERT INTO record_fts (record_fts) VALUES ('delete-all')")

    assert _search(diary, records_sql, match("сел")) == [], "the index really is empty"
    assert diary.execute("SELECT count(*) AS n FROM record_fts").fetchone()["n"] == before


def test_the_argumentless_integrity_check_cannot_detect_it_either(
    diary: sqlite3.Connection,
) -> None:
    """The second probe that does not work, and the third that does — on THIS engine.

    FTS5's own ``integrity-check`` verifies the index against the content table
    only when it is asked to (the argument rides on the ``rank`` column). Without
    the argument an emptied index passes.

    THE TWO-ARGUMENT FORM IS NOT WHAT THE PRODUCT USES, and this test is why it
    is recorded rather than adopted: what it does on the SQLCipher build the
    device ships has never been measured, and a probe that must itself be
    version-gated is more moving parts than the rebuild it would guard.
    """
    diary.execute("INSERT INTO record_fts (record_fts) VALUES ('delete-all')")

    diary.execute("INSERT INTO record_fts (record_fts) VALUES ('integrity-check')")

    with pytest.raises(sqlite3.DatabaseError):
        diary.execute("INSERT INTO record_fts (record_fts, rank) VALUES ('integrity-check', 1)")


# --- the shipped statement is the shipped statement --------------------------


def test_the_search_reads_the_index_and_scopes_through_the_area(
    records_sql: dict[str, str],
) -> None:
    """A structural read of the statement, so a later edit cannot quietly widen it.

    Static, and labelled as such: this asserts what the SQL SAYS. What it MEANS is
    every test above, which executes it.
    """
    sql = records_sql["RECORD_SEARCH_SQL"]
    assert "record_fts f JOIN record r ON r.rowid = f.rowid" in sql, "the external-content join"
    assert "f.record_fts MATCH ?" in sql
    for predicate in (
        "a.owner_participant_id = ?",
        "ac.child_id = ?",
        "a.visibility_class = ?",
        "r.kind = ?",
    ):
        assert predicate in sql, f"the search dropped the {predicate} scope"
    assert "ORDER BY r.event_date_local DESC, r.entry_at_utc DESC, r.id DESC" in sql
    assert "LIMIT ?" in sql
