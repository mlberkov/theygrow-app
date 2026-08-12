"""Coverage map for the sixteen irreversible slots and the five accompanying rules.

PDR-026 §4 (body + amendment 2026-08-04 + overlay 2026-08-11) names sixteen slots
that must be present in the schema THAT FREEZES HERE, plus five rules that govern
how the store behaves. This module is the machine-checkable index of both: every
slot names the schema object that carries it AND the test that exercises it, and
the map itself is asserted against the live schema and the live test modules — so
a slot cannot be quietly dropped, and a test cannot be renamed out from under its
slot.

The fifth accompanying rule (the export artifact stays human-readable and
self-describing for years without the app) is a requirement on the EXPORT, not a
slot in this schema. It is recorded here as deferred with its address — L1-P3,
the export contour — so that a reader checking this file against the source text
finds it accounted for rather than missing.
"""

from __future__ import annotations

import importlib
import sqlite3

import pytest

SLOT_COVERAGE: dict[int, tuple[str, str, str]] = {
    1: (
        "a mark is an attributed assertion",
        "assertion",
        "test_store_slots::test_an_assertion_cannot_be_anonymous",
    ),
    2: (
        "subject plus visibility class on derived state",
        "v_child_skill_state",
        "test_store_projections::test_derived_state_carries_subject_and_visibility",
    ),
    3: (
        "area flag child_shared / participant_private",
        "area",
        "test_store_slots::test_area_visibility_class_binds_ownership",
    ),
    4: (
        "multi-child support in the area model",
        "area_child",
        "test_store_slots::test_one_area_can_cover_several_children",
    ),
    5: (
        "record type flag text / media",
        "record",
        "test_store_slots::test_record_kind_binds_its_payload",
    ),
    6: (
        "trajectory-modifier fields and the do-not-collect list",
        "child_attribute",
        "test_store_markers::test_markers_never_move_a_computed_number",
    ),
    7: (
        "semantics of backward propagation of marks",
        "assertion",
        "test_store_projections::test_backward_propagation_is_recorded_not_materialised",
    ),
    8: (
        "state slot for the stopped-time mode",
        "v_child_stopped_time",
        "test_store_projections::test_stopped_time_is_per_child_reversible_and_shared",
    ),
    9: (
        "status of existing single-author marks at migration",
        "confirmation",
        "test_store_projections::test_migrated_mark_is_authors_assertion_confirmed_by_one",
    ),
    10: (
        "append-only historicity of the journal",
        "journal_entry",
        "test_store_append_only::test_update_is_refused",
    ),
    11: (
        "event time and entry time held separately",
        "journal_entry",
        "test_store_slots::test_event_time_and_entry_time_are_separate",
    ),
    12: (
        "per-record sensitivity flag",
        "record",
        "test_store_slots::test_record_sensitivity_has_an_undeclared_state",
    ),
    13: (
        "mark refresh status",
        "v_assertion_status",
        "test_store_projections::test_dispute_does_not_erase_the_original_assertion",
    ),
    14: (
        "schema version and migration path on the device",
        "schema_migration",
        "test_store_slots::test_schema_version_and_migration_ledger_exist",
    ),
    15: (
        "fragment-basis inside an assertion",
        "assertion_quote",
        "test_store_append_only::test_deleting_a_record_does_not_revoke_its_marks",
    ),
    16: (
        "stable addressable identifiers",
        "journal_entry",
        "test_store_slots::test_identifiers_are_stable_and_unique",
    ),
}

RULE_COVERAGE: dict[int, tuple[str, str]] = {
    1: (
        "the diary is edited by overwrite",
        "test_store_append_only::test_the_record_is_editable_by_overwrite",
    ),
    2: (
        "deleting a diary record does not revoke marks derived from it",
        "test_store_append_only::test_deleting_a_record_does_not_revoke_its_marks",
    ),
    3: (
        "a state snapshot for a date is a derived projection, not a stored file",
        "test_store_projections::test_state_at_a_past_date_is_reconstructed_from_the_journal",
    ),
    4: (
        "retrieval indexes are derived and recomputed on diary edits",
        "test_store_corruption::test_the_index_is_fully_rebuildable_from_the_records",
    ),
    5: (
        "the export artifact stays human-readable and self-describing",
        "DEFERRED: L1-P3 export contour — a requirement on the export, not a schema slot",
    ),
}


def _resolve(test_id: str) -> None:
    module_name, func_name = test_id.split("::")
    module = importlib.import_module(f".{module_name}", package=__package__)
    assert hasattr(module, func_name), f"{test_id} does not exist"


def test_all_sixteen_slots_are_claimed() -> None:
    assert sorted(SLOT_COVERAGE) == list(range(1, 17))


@pytest.mark.parametrize("slot", sorted(SLOT_COVERAGE))
def test_each_slot_names_a_live_schema_object_and_a_live_test(
    store: sqlite3.Connection, slot: int
) -> None:
    _, schema_object, test_id = SLOT_COVERAGE[slot]
    found = store.execute(
        "SELECT count(*) AS n FROM sqlite_master WHERE name = ?", (schema_object,)
    ).fetchone()["n"]
    assert found == 1, f"slot {slot} names {schema_object}, which is not in the schema"
    _resolve(test_id)


@pytest.mark.parametrize("rule", sorted(RULE_COVERAGE))
def test_each_accompanying_rule_is_closed_or_addressed(rule: int) -> None:
    _, test_id = RULE_COVERAGE[rule]
    if test_id.startswith("DEFERRED:"):
        assert "L1-P3" in test_id, "a deferred rule must name the packet that closes it"
        return
    _resolve(test_id)


# --- the slot assertions this module owns --------------------------------


def test_an_assertion_cannot_be_anonymous(store: sqlite3.Connection) -> None:
    """Slot 1 + LSC-P2-INV-005: no family datum without an author and a subject."""
    from .harness import seed_child, seed_participant

    seed_participant(store)
    seed_child(store)
    with pytest.raises(sqlite3.IntegrityError):
        store.execute(
            "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
            " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
            " VALUES ('j-x', 'assertion', 'ghost', 'c-1', 'child_shared', 'authored',"
            " '2026-01-01', 1000, 180)"
        )
    with pytest.raises(sqlite3.IntegrityError):
        store.execute(
            "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
            " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
            " VALUES ('j-y', 'assertion', 'p-self', NULL, 'child_shared', 'authored',"
            " '2026-01-01', 1000, 180)"
        )


def test_area_visibility_class_binds_ownership(store: sqlite3.Connection) -> None:
    """Slot 3 — a private area has an owner; a shared one cannot have one."""
    from .harness import seed_participant

    owner = seed_participant(store)
    store.execute(
        "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
        " VALUES ('a-priv', 'дневник', 'participant_private', ?, 1000)",
        (owner,),
    )
    with pytest.raises(sqlite3.IntegrityError):
        store.execute(
            "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
            " VALUES ('a-bad', 'x', 'participant_private', NULL, 1000)"
        )
    with pytest.raises(sqlite3.IntegrityError):
        store.execute(
            "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
            " VALUES ('a-bad2', 'x', 'child_shared', ?, 1000)",
            (owner,),
        )


def test_one_area_can_cover_several_children(store: sqlite3.Connection) -> None:
    """Slot 4 — multi-child in the area model (PDR-021 OQ#6)."""
    from .harness import seed_area, seed_child

    seed_child(store, "c-1")
    seed_child(store, "c-2")
    seed_area(store, "a-1", child_id="c-1")
    store.execute("INSERT INTO area_child (area_id, child_id) VALUES ('a-1', 'c-2')")
    rows = store.execute(
        "SELECT child_id FROM area_child WHERE area_id = 'a-1' ORDER BY child_id"
    ).fetchall()
    assert [r["child_id"] for r in rows] == ["c-1", "c-2"]


def test_record_kind_binds_its_payload(store: sqlite3.Connection) -> None:
    """Slot 5 — the text/media flag is structural, not advisory."""
    from .harness import seed_area, seed_participant

    author = seed_participant(store)
    area = seed_area(store)
    with pytest.raises(sqlite3.IntegrityError):
        store.execute(
            "INSERT INTO record (id, area_id, author_participant_id, kind, body, media_ref,"
            " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
            " VALUES ('r-bad', ?, ?, 'text', NULL, NULL, '2026-01-01', 1000, 180, 1000)",
            (area, author),
        )
    store.execute(
        "INSERT INTO record (id, area_id, author_participant_id, kind, body, media_ref,"
        " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
        " VALUES ('r-media', ?, ?, 'media', NULL, 'media/1', '2026-01-01', 1000, 180, 1000)",
        (area, author),
    )


def test_event_time_and_entry_time_are_separate(store: sqlite3.Connection) -> None:
    """Slot 11 — an observation from last week entered today keeps both times."""
    from .harness import append_assertion, seed_child, seed_participant

    author = seed_participant(store)
    child = seed_child(store)
    append_assertion(store, "j-1", author, child, effective_from="2026-01-01", entry_at_utc=9999)
    row = store.execute(
        "SELECT event_date_local, entry_at_utc FROM journal_entry WHERE id = 'j-1'"
    ).fetchone()
    assert row["event_date_local"] == "2026-01-01"
    assert row["entry_at_utc"] == 9999
    columns = {r["name"] for r in store.execute("PRAGMA table_info(journal_entry)").fetchall()}
    assert {"event_date_local", "event_at_utc", "entry_at_utc"} <= columns


def test_record_sensitivity_has_an_undeclared_state(store: sqlite3.Connection) -> None:
    """Slot 12 — 'never asked' must be distinguishable from 'declared not sensitive'.

    A DEFAULT of 'not sensitive' would make an accumulated corpus indistinguishable
    from a corpus the family actually reviewed, which is exactly the retro-labelling
    problem this slot exists to prevent. NULL is the undeclared state; what a
    proactive surface does with an undeclared record is projection-time policy (L5).
    """
    from .harness import seed_area, seed_participant, seed_record

    author = seed_participant(store)
    area = seed_area(store)
    seed_record(store, "r-undeclared", area, author)
    seed_record(store, "r-sensitive", area, author, sensitivity="sensitive")
    seed_record(store, "r-open", area, author, sensitivity="not_sensitive")

    states = {
        r["id"]: r["sensitivity"]
        for r in store.execute("SELECT id, sensitivity FROM record").fetchall()
    }
    assert states["r-undeclared"] is None
    assert states["r-sensitive"] == "sensitive"
    assert states["r-open"] == "not_sensitive"

    with pytest.raises(sqlite3.IntegrityError):
        store.execute("UPDATE record SET sensitivity = 'maybe' WHERE id = 'r-open'")

    ddl = store.execute("SELECT sql FROM sqlite_master WHERE name = 'record'").fetchone()["sql"]
    assert "sensitivity" in ddl and "DEFAULT" not in ddl.split("sensitivity")[1].split(",")[0], (
        "record.sensitivity must carry no default — undeclared is a first-class state"
    )


def test_schema_version_and_migration_ledger_exist(store: sqlite3.Connection) -> None:
    """Slot 14 — the version and the path it was reached by are both on the device."""
    assert store.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'").fetchone()
    columns = {r["name"] for r in store.execute("PRAGMA table_info(schema_migration)")}
    assert {"version", "name", "applied_at_utc"} <= columns


def test_identifiers_are_stable_and_unique(store: sqlite3.Connection) -> None:
    """Slot 16 — ids are minted at creation and cannot be handed out retroactively."""
    from .harness import append_assertion, seed_child, seed_participant

    author = seed_participant(store)
    child = seed_child(store)
    append_assertion(store, "j-1", author, child)
    with pytest.raises(sqlite3.IntegrityError):
        append_assertion(store, "j-1", author, child, skill_id="skill-2")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        store.execute("UPDATE journal_entry SET id = 'j-renamed' WHERE id = 'j-1'")
