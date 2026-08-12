"""Fixtures and helpers for the native-store schema tests (L1-P2).

WHY THE SPLITTER IS REPLICATED HERE. The store does not hand SQL to SQLite
directly: it hands a statement string to `CapacitorSQLite.execute`, whose Java
implementation splits it with a HEURISTIC before calling `execSQL` on each
piece (`native/node_modules/@capacitor-community/sqlite/android/src/main/java/
com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLite.java`,
`getStatementsArray`). The heuristic splits on ";\\n" and then re-joins trigger
bodies only when a fragment trims to exactly "END" — so a trigger written
across several lines is cut in half and the DDL fails ON THE DEVICE while
passing every desktop test that feeds the file to SQLite whole.

`plugin_split()` below is a faithful port of that Java method. Every test here
applies the schema THROUGH it, so the packet's one un-runnable claim ("the DDL
applies on the device") is reduced to a claim these tests can actually check.
The port is deliberately literal, quirks included: the blanket `end;` -> `END;`
replacement, the `--` comment strip, the line flattening, the recursive
END-rejoin and the trailing-empty trim.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "app" / "m" / "v1" / "store" / "schema" / "001-core.sql"

# Mirrors STORE_CONFIG.sqliteVersionFloor in app/m/v1/store/config.js. STRICT
# tables need 3.37; the floor is the same number in both places by hand, and
# test_store_ddl_apply.py asserts they agree.
SQLITE_VERSION_FLOOR = (3, 37, 0)


def _flatten_and_strip_comments(fragment: str) -> str:
    """Port of the per-fragment line flattening in getStatementsArray()."""
    out: list[str] = []
    for raw in fragment.split("\n"):
        line = raw.strip()
        idx = line.find("--")
        if idx > -1:
            line = line[:idx]
        line = line.strip()
        if line:
            out.append(line)
    return " ".join(out)


def _concat_remove_end(fragments: list[str]) -> list[str]:
    """Port of concatRemoveEnd(): re-join a trigger body split off at its END."""
    result = list(fragments)
    while "END" in result:
        idx = result.index("END")
        result[idx - 1] = result[idx - 1] + "; END"
        del result[idx]
    return result


def plugin_split(statements: str) -> list[str]:
    """Port of UtilsSQLite.getStatementsArray() (@capacitor-community/sqlite 8.1.1)."""
    stmts = statements.replace("end;", "END;")
    fragments = stmts.split(";\n")
    fragments = _concat_remove_end([f.strip() for f in fragments])
    flattened = [_flatten_and_strip_comments(f) for f in fragments]
    if flattened and not flattened[-1].strip():
        flattened = flattened[:-1]
    return flattened


def schema_sql() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8")


def schema_statements() -> list[str]:
    """The DDL as the Android plugin would hand it to execSQL, one by one."""
    return [s for s in plugin_split(schema_sql()) if s.strip()]


def apply_schema(conn: sqlite3.Connection) -> None:
    """Apply the DDL the way the device does: statement by statement, via the split."""
    for statement in schema_statements():
        conn.execute(statement)


def connect(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


# --- seeding -------------------------------------------------------------
#
# Ids are literal and readable rather than UUIDs: the schema does not constrain
# id FORM (see LSC-DL-002 — minting is the store's job, uniqueness is the
# schema's), and readable ids make a failing assertion legible.


def seed_participant(conn: sqlite3.Connection, participant_id: str = "p-self") -> str:
    conn.execute(
        "INSERT INTO participant (id, is_self, created_at_utc) VALUES (?, 1, 1000)",
        (participant_id,),
    )
    return participant_id


def seed_child(conn: sqlite3.Connection, child_id: str = "c-1") -> str:
    conn.execute("INSERT INTO child (id, created_at_utc) VALUES (?, 1000)", (child_id,))
    return child_id


def seed_area(
    conn: sqlite3.Connection,
    area_id: str = "a-1",
    visibility: str = "child_shared",
    owner: str | None = None,
    child_id: str | None = None,
) -> str:
    conn.execute(
        "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
        " VALUES (?, ?, ?, ?, 1000)",
        (area_id, area_id, visibility, owner),
    )
    if child_id is not None:
        conn.execute(
            "INSERT INTO area_child (area_id, child_id) VALUES (?, ?)", (area_id, child_id)
        )
    return area_id


def seed_record(
    conn: sqlite3.Connection,
    record_id: str,
    area_id: str,
    author: str,
    body: str = "текст",
    event_date: str = "2026-01-01",
    sensitivity: str | None = None,
) -> str:
    conn.execute(
        "INSERT INTO record (id, area_id, author_participant_id, kind, body, sensitivity,"
        " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
        " VALUES (?, ?, ?, 'text', ?, ?, ?, 1000, 180, 1000)",
        (record_id, area_id, author, body, sensitivity, event_date),
    )
    return record_id


def append_entry(
    conn: sqlite3.Connection,
    entry_id: str,
    kind: str,
    author: str,
    child_id: str,
    *,
    visibility: str = "child_shared",
    origin: str = "authored",
    event_date: str = "2026-01-01",
    entry_at_utc: int = 1000,
) -> str:
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 180)",
        (entry_id, kind, author, child_id, visibility, origin, event_date, entry_at_utc),
    )
    return entry_id


def append_assertion(
    conn: sqlite3.Connection,
    entry_id: str,
    author: str,
    child_id: str,
    *,
    skill_id: str | None = "skill-1",
    kind: str = "skill_observed",
    effective_from: str = "2026-01-01",
    propagation: str = "none",
    source_record_id: str | None = None,
    supersedes: str | None = None,
    visibility: str = "child_shared",
    origin: str = "authored",
    entry_at_utc: int = 1000,
) -> str:
    append_entry(
        conn,
        entry_id,
        "assertion",
        author,
        child_id,
        visibility=visibility,
        origin=origin,
        event_date=effective_from,
        entry_at_utc=entry_at_utc,
    )
    conn.execute(
        "INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,"
        " prerequisite_propagation, source_record_id, supersedes_assertion_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (entry_id, kind, skill_id, effective_from, propagation, source_record_id, supersedes),
    )
    return entry_id


def append_confirmation(
    conn: sqlite3.Connection,
    entry_id: str,
    author: str,
    child_id: str,
    target_assertion_id: str,
    status: str = "confirmed",
    *,
    entry_at_utc: int = 1000,
) -> str:
    append_entry(conn, entry_id, "confirmation", author, child_id, entry_at_utc=entry_at_utc)
    conn.execute(
        "INSERT INTO confirmation (journal_id, target_assertion_id, status, note)"
        " VALUES (?, ?, ?, NULL)",
        (entry_id, target_assertion_id, status),
    )
    return entry_id


def append_child_attribute(
    conn: sqlite3.Connection,
    entry_id: str,
    author: str,
    child_id: str,
    attribute: str,
    value: str | None,
    *,
    entry_at_utc: int = 1000,
) -> str:
    sensitive = 1 if attribute.startswith("marker_") else 0
    append_entry(
        conn,
        entry_id,
        "child_attribute",
        author,
        child_id,
        entry_at_utc=entry_at_utc,
    )
    conn.execute(
        "INSERT INTO child_attribute (journal_id, attribute, value, sensitive) VALUES (?, ?, ?, ?)",
        (entry_id, attribute, value, sensitive),
    )
    return entry_id


def set_as_of(conn: sqlite3.Connection, as_of_date: str) -> None:
    conn.execute("UPDATE projection_context SET as_of_date = ? WHERE id = 1", (as_of_date,))
