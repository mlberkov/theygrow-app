"""The DDL applies the way the DEVICE applies it, not the way SQLite likes it.

The interesting assertions here are the ones about FORM rather than content: the
Android wrapper's statement splitter (see harness.plugin_split) is a heuristic,
and the two rules it imposes on the file — triggers on one line, no `--` inside
a string literal — are invisible to a test that feeds SQLite the whole file.
"""

from __future__ import annotations

import re
import sqlite3

from .harness import (
    SCHEMA_PATH,
    SQLITE_VERSION_FLOOR,
    apply_schema,
    connect,
    plugin_split,
    schema_sql,
    schema_statements,
)


def test_schema_file_exists() -> None:
    assert SCHEMA_PATH.is_file(), f"{SCHEMA_PATH} is missing"


def test_schema_applies_through_the_plugin_splitter(store: sqlite3.Connection) -> None:
    objects = store.execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).fetchall()
    kinds = {row["type"] for row in objects}
    assert {"table", "trigger", "view", "index"} <= kinds
    assert len(objects) > 30


def test_every_trigger_is_a_single_line() -> None:
    """A multi-line trigger is cut in half by the wrapper's ";\\n" split."""
    offenders: list[str] = []
    for raw in schema_sql().split("\n"):
        line = raw.strip()
        if not line.upper().startswith("CREATE TRIGGER"):
            continue
        if not line.upper().endswith("END;"):
            offenders.append(line[:80])
    assert offenders == [], (
        "every CREATE TRIGGER must open and close on ONE line, or the Android "
        "wrapper's statement splitter cuts its body: " + repr(offenders)
    )


def test_no_statement_carries_a_comment_marker_inside_a_string_literal() -> None:
    """The splitter strips `--` to end of line, inside quotes as well as outside.

    Whole-line `--` comments are removed before the scan: the splitter is not
    quote-aware, so an apostrophe inside a COMMENT reaches nothing, while a
    naive quote-pairing scan would pair it with the next real literal and report
    a phantom.
    """
    code = "\n".join(line for line in schema_sql().split("\n") if not line.strip().startswith("--"))
    for literal in re.findall(r"'([^']*)'", code):
        assert "--" not in literal, f"`--` inside the SQL string literal {literal!r}"
        assert "end;" not in literal.lower(), (
            f"`end;` inside the SQL string literal {literal!r} — the splitter uppercases it blindly"
        )


def test_the_splitter_produces_no_empty_or_truncated_statement() -> None:
    statements = schema_statements()
    assert statements, "the splitter produced no statements at all"
    for statement in statements:
        assert statement.strip(), "the splitter produced an empty statement"
        assert not statement.upper().startswith("END"), (
            "a trigger body was split off from its header: " + statement[:80]
        )


def test_the_single_line_rule_is_what_keeps_a_trigger_whole() -> None:
    """Anti-vacuity: show the failure the one-line rule exists to avoid.

    A trigger whose body holds MORE THAN ONE statement across lines is torn in
    half by the wrapper (the END-rejoin only reattaches the last fragment), and
    the mount's store/schema DDL has exactly such a trigger — record_fts_after_update.
    """
    one_line = (
        "CREATE TABLE t (a TEXT);\n"
        "CREATE TRIGGER g AFTER UPDATE ON t BEGIN DELETE FROM t; INSERT INTO t VALUES (1); END;\n"
    )
    assert plugin_split(one_line) == [
        "CREATE TABLE t (a TEXT)",
        "CREATE TRIGGER g AFTER UPDATE ON t BEGIN DELETE FROM t; INSERT INTO t VALUES (1); END",
    ]

    across_lines = (
        "CREATE TRIGGER g AFTER UPDATE ON t BEGIN\n"
        "DELETE FROM t;\n"
        "INSERT INTO t VALUES (1);\n"
        "END;\n"
    )
    torn = plugin_split(across_lines)
    assert len(torn) == 2 and torn[0].endswith("DELETE FROM t"), (
        "the wrapper tears a multi-statement trigger body apart — which is why "
        "the DDL keeps every trigger on one line"
    )


def test_every_real_table_is_strict() -> None:
    conn = connect()
    apply_schema(conn)
    rows = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    # FTS5 creates shadow tables of its own; they are not ours to constrain.
    ours = [r for r in rows if not r["name"].startswith("record_fts")]
    assert ours, "no tables found"
    for row in ours:
        assert row["sql"].rstrip().rstrip(";").upper().endswith("STRICT"), (
            f"table {row['name']} is not STRICT — an irreversible store gets column "
            "types enforced by the engine, not by convention"
        )
    conn.close()


def test_sqlite_version_floor_is_met_and_matches_the_store_config() -> None:
    actual = tuple(int(part) for part in sqlite3.sqlite_version.split("."))
    assert actual >= SQLITE_VERSION_FLOOR, (
        f"desktop SQLite {sqlite3.sqlite_version} is below the declared floor"
    )
    config = (SCHEMA_PATH.parents[1] / "config.js").read_text(encoding="utf-8")
    declared = re.search(r"sqliteVersionFloor:\s*'([0-9.]+)'", config)
    assert declared is not None, "config.js declares no sqliteVersionFloor"
    assert tuple(int(p) for p in declared.group(1).split(".")) == SQLITE_VERSION_FLOOR, (
        "the floor in the mount's store/config.js and the floor in harness.py disagree"
    )


def test_fts5_is_available_and_the_index_is_wired(store: sqlite3.Connection) -> None:
    options = {row[0] for row in store.execute("PRAGMA compile_options")}
    assert any("FTS5" in option for option in options), "this SQLite has no FTS5"
    kind = store.execute("SELECT sql FROM sqlite_master WHERE name = 'record_fts'").fetchone()
    assert kind is not None, "record_fts is missing"
    assert "unicode61" in kind["sql"], "the FTS index must pin its tokenizer explicitly"


def test_schema_version_is_recorded(store: sqlite3.Connection) -> None:
    version = store.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'").fetchone()
    assert version is not None and version["value"] == "1"
