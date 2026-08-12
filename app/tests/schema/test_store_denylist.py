"""LSC-P2-INV-003 — the closed "do not collect" list, enforced against the schema.

PDR-033 closes the list: no numeric probability of a diagnosis or risk for a
specific child; no clinician-instrument scores entered by a non-clinician; no
syndrome-specific skill curves; no algorithm differentiating the CAUSE of a
regression; no multiple-birth correction coefficient; no quantitative correction
for institutionalization or deprivation. Regression is NOT a schema attribute —
it is derived from the journal.

A second denylist rides along for a different reason: two column names are
LOAD-BEARING FOR THE WRAPPER. `@capacitor-community/sqlite` rewrites
`DELETE FROM ... WHERE ...` into a soft-delete UPDATE when a table carries both
`last_modified` and `sql_deleted` (Database.deleteSQL). A schema that grew those
names would silently stop deleting quote-basis rows, and slot 15's erasure would
become a lie told by a third-party plugin. The names are banned here so that can
never happen by accident.
"""

from __future__ import annotations

import re
import sqlite3

FORBIDDEN_NAME_PARTS = (
    "gmfcs",
    "macs",
    "cfcs",
    "vineland",
    "pedi_cat",
    "pedicat",
    "hine",
    "asq",
    "risk",
    "probability",
    "prognosis",
    "diagnos",
    "syndrome",
    "severity",
    "percentile",
    "z_score",
    "zscore",
    "coefficient",
    "deprivation",
    "institutionalization",
    "multiple_birth",
    "regression",
)

WRAPPER_RESERVED_COLUMNS = ("sql_deleted", "last_modified")

# Slot 6, closed by PDR-033: one computing field (weeks + days) and three
# declarative markers. Nothing else may become a child attribute.
EXPECTED_ATTRIBUTES = {
    "name",
    "birthdate",
    "gestational_age_weeks",
    "gestational_age_days",
    "stopped_time",
    "marker_bilingual",
    "marker_atypical_development",
    "marker_unknown_early_history",
}


def _schema_objects(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).fetchall()


def _all_column_names(conn: sqlite3.Connection) -> set[str]:
    columns: set[str] = set()
    for row in _schema_objects(conn):
        if row["type"] not in ("table", "view"):
            continue
        for column in conn.execute(f"PRAGMA table_info({row['name']})"):
            columns.add(column["name"].lower())
    return columns


def test_no_schema_object_name_is_on_the_do_not_collect_list(
    store: sqlite3.Connection,
) -> None:
    names = [row["name"].lower() for row in _schema_objects(store)]
    assert names, "no schema objects found — the scan would be vacuous"
    for name in names:
        for part in FORBIDDEN_NAME_PARTS:
            assert part not in name, f"schema object {name!r} matches banned term {part!r}"


def test_no_column_name_is_on_the_do_not_collect_list(store: sqlite3.Connection) -> None:
    columns = _all_column_names(store)
    assert len(columns) > 20, "the column scan reached a suspiciously small surface"
    for column in columns:
        for part in FORBIDDEN_NAME_PARTS:
            assert part not in column, f"column {column!r} matches banned term {part!r}"


def test_no_column_collides_with_the_wrappers_soft_delete_contract(
    store: sqlite3.Connection,
) -> None:
    columns = _all_column_names(store)
    for reserved in WRAPPER_RESERVED_COLUMNS:
        assert reserved not in columns, (
            f"{reserved!r} makes @capacitor-community/sqlite rewrite DELETE into a "
            "soft-delete UPDATE; slot 15 erasure would stop erasing"
        )


def test_the_child_attribute_list_is_closed(store: sqlite3.Connection) -> None:
    ddl = store.execute("SELECT sql FROM sqlite_master WHERE name = 'child_attribute'").fetchone()[
        "sql"
    ]
    declared = set(re.findall(r"'([a-z_]+)'", ddl))
    assert EXPECTED_ATTRIBUTES <= declared, "an attribute from PDR-033 is missing"
    extra = declared - EXPECTED_ATTRIBUTES
    assert extra == set(), f"child_attribute accepts undeclared attributes: {sorted(extra)}"


def test_the_child_row_carries_no_measurement_at_all(store: sqlite3.Connection) -> None:
    columns = {r["name"] for r in store.execute("PRAGMA table_info(child)")}
    assert columns == {"id", "created_at_utc"}, (
        "the child row is identity only — every attribute is a journal event, so "
        "no numeric field can accrete on it"
    )


def test_the_participant_row_carries_no_name(store: sqlite3.Connection) -> None:
    """§4 privacy shape: identifiers, not identities, until L7 grants exist."""
    columns = {r["name"] for r in store.execute("PRAGMA table_info(participant)")}
    assert columns == {"id", "is_self", "created_at_utc"}
