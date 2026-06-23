"""M3-P2 importer behavior, enforced against a real Postgres.

Covers the M3-DL-001/003 contract: fail-closed validation (schema_version,
envelope integrity, record shape), atomic idempotent upsert on the composite
assertion key (recorded_at + source_message_id excluded from the update),
``valid_at := created_at``, NULL persona/embedding, and the minimized quarantine
sidecar (reject-with-report). Reuses the P1 ``connection`` fixture (per-test
transaction, rolled back), so the suite skips without Postgres just like P1.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Connection, func, select, text

from theygrow_api.db.models import SourceMessage
from theygrow_api.importer import ExportValidationError, import_export

_FIXTURE = Path(__file__).parent / "fixtures" / "export_v1_sample.json"


def _record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "source_message_id": "sm-1",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": "chat-1",
        "external_user_id": "user-1",
        "external_message_id": "msg-1",
        "edit_seq": 0,
        "raw_text": "a synthetic diary line",
        "detected_route": "note",
        "created_at": "2026-01-01T12:00:00+00:00",
    }
    record.update(overrides)
    return record


def _doc(records: list[dict[str, Any]], **envelope_overrides: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "format": "theygrow.export",
        "schema_version": 1,
        "scope": {"community_id": "comm-1", "requester_user_id": "requester-1"},
        "generated_at": "2026-06-01T09:00:00+00:00",
        "record_count": len(records),
    }
    envelope.update(envelope_overrides)
    return {"export": envelope, "records": records}


def _write(tmp_path: Path, doc: dict[str, Any]) -> Path:
    path = tmp_path / "export.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _count(connection: Connection) -> int:
    return connection.execute(select(func.count()).select_from(SourceMessage)).scalar_one()


def test_happy_path_imports_fixture(connection: Connection) -> None:
    summary = import_export(_FIXTURE, connection=connection)

    assert (summary.inserted, summary.updated, summary.quarantined, summary.skipped) == (3, 0, 0, 0)
    assert _count(connection) == 3

    row = connection.execute(
        select(SourceMessage).where(SourceMessage.source_message_id == "sm-0001")
    ).one()
    assert row.valid_at == row.created_at
    assert row.persona_id is None
    assert row.embedding is None
    assert row.recorded_at is not None  # DB server default applied
    assert row.detected_route == "note"


def test_reimport_is_idempotent(connection: Connection) -> None:
    import_export(_FIXTURE, connection=connection)
    summary = import_export(_FIXTURE, connection=connection)

    assert (summary.inserted, summary.updated, summary.quarantined) == (0, 3, 0)
    assert _count(connection) == 3  # no duplicates

    row = connection.execute(
        select(SourceMessage).where(SourceMessage.source_message_id == "sm-0001")
    ).one()
    assert row.raw_text == "synthetic diary line one"  # no drift
    assert row.valid_at == row.created_at


def test_recorded_at_is_db_set_and_preserved_on_reimport(connection: Connection) -> None:
    import_export(_FIXTURE, connection=connection)

    # Stamp a sentinel recorded_at, then re-import: the upsert must NOT overwrite it.
    sentinel = "2000-01-01T00:00:00+00:00"
    connection.execute(text("UPDATE source_messages SET recorded_at = :ts"), {"ts": sentinel})
    import_export(_FIXTURE, connection=connection)

    recorded = connection.execute(
        select(SourceMessage.recorded_at).where(SourceMessage.source_message_id == "sm-0001")
    ).scalar_one()
    assert recorded.year == 2000  # first-recorded instant preserved
    row = connection.execute(
        select(SourceMessage).where(SourceMessage.source_message_id == "sm-0001")
    ).one()
    assert row.valid_at == row.created_at


def test_edit_seq_states_are_distinct_rows(tmp_path: Path, connection: Connection) -> None:
    original = _record(source_message_id="orig", edit_seq=0)
    edited = _record(source_message_id="edited", edit_seq=1717171717000)
    path = _write(tmp_path, _doc([original, edited]))

    summary = import_export(path, connection=connection)

    assert summary.inserted == 2
    assert _count(connection) == 2  # same message, two edit-states, never collapsed


def test_quarantine_non_live_route(tmp_path: Path, connection: Connection) -> None:
    live = _record(source_message_id="live", detected_route="note")
    quarantined = _record(
        source_message_id="quar", external_message_id="msg-2", detected_route="ask"
    )
    path = _write(tmp_path, _doc([live, quarantined]))
    report = tmp_path / "report.json"

    summary = import_export(path, connection=connection, quarantine_report_path=report)

    assert (summary.inserted, summary.quarantined) == (1, 1)
    assert _count(connection) == 1  # quarantined row not landed
    landed = connection.execute(select(SourceMessage.source_message_id)).scalars().all()
    assert landed == ["live"]
    assert report.exists()


def test_quarantine_report_is_minimized(tmp_path: Path, connection: Connection) -> None:
    """Locks M3-DL-003 / C1: report carries only the three §4-safe fields."""
    quarantined = _record(source_message_id="quar", detected_route="clarify")
    path = _write(tmp_path, _doc([quarantined]))
    report = tmp_path / "report.json"

    import_export(path, connection=connection, quarantine_report_path=report)

    entries = json.loads(report.read_text(encoding="utf-8"))
    assert len(entries) == 1
    entry = entries[0]
    assert set(entry) == {"source_message_id", "detected_route", "reason"}
    assert entry == {
        "source_message_id": "quar",
        "detected_route": "clarify",
        "reason": "non_live_route",
    }
    # Family-identifying keys and raw_text must never appear.
    for forbidden in (
        "community_id",
        "external_chat_id",
        "external_message_id",
        "external_user_id",
        "author_user_id",
        "edit_seq",
        "raw_text",
    ):
        assert forbidden not in entry


def test_wrong_schema_version_fails_closed(tmp_path: Path, connection: Connection) -> None:
    path = _write(tmp_path, _doc([_record()], schema_version=2))
    with pytest.raises(ExportValidationError):
        import_export(path, connection=connection)
    assert _count(connection) == 0  # nothing written


def test_record_count_mismatch_fails_closed(tmp_path: Path, connection: Connection) -> None:
    path = _write(tmp_path, _doc([_record()], record_count=5))
    with pytest.raises(ExportValidationError):
        import_export(path, connection=connection)
    assert _count(connection) == 0


def test_malformed_record_aborts_whole_file(tmp_path: Path, connection: Connection) -> None:
    good = _record(source_message_id="good")
    bad = _record(source_message_id="bad", external_message_id="msg-2", edit_seq="nope")
    path = _write(tmp_path, _doc([good, bad]))

    with pytest.raises(ExportValidationError):
        import_export(path, connection=connection)
    assert _count(connection) == 0  # atomic: the valid record is not partially landed


def test_unknown_route_value_fails_closed(tmp_path: Path, connection: Connection) -> None:
    path = _write(tmp_path, _doc([_record(detected_route="garbage")]))
    with pytest.raises(ExportValidationError):
        import_export(path, connection=connection)
    assert _count(connection) == 0
