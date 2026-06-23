"""M3-P1 schema constraints, enforced against a real Postgres.

Covers the M3-DL-001 idempotency contract (PK + composite assertion key, with
``edit_seq`` significant), the defensive ``detected_route`` CHECK over the full
RouteKind set, the reserved (nullable, unindexed) embedding shell, the persona
stub, and the ADR-004 dual-timestamp semantics (``recorded_at`` defaulted,
``valid_at`` required).
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import Connection, insert, select, text
from sqlalchemy.exc import IntegrityError

from theygrow_api.db.models import ROUTE_KINDS, SourceMessage

_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def _row(**overrides: object) -> dict[str, object]:
    """A complete, valid source-message row; override any field per test."""
    row: dict[str, object] = {
        "source_message_id": "smid-1",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": "chat-1",
        "external_user_id": "user-1",
        "external_message_id": "msg-1",
        "edit_seq": 0,
        "raw_text": "2026-01-01 a private diary line",
        "detected_route": "note",
        "created_at": _CREATED,
        "valid_at": _CREATED,
    }
    row.update(overrides)
    return row


def _insert(conn: Connection, **overrides: object) -> None:
    conn.execute(insert(SourceMessage), _row(**overrides))


def test_primary_key_rejects_duplicate_source_message_id(connection: Connection) -> None:
    _insert(connection, source_message_id="dup", external_message_id="m1")
    with pytest.raises(IntegrityError):
        # Same PK, different assertion key — must still be rejected by the PK.
        _insert(connection, source_message_id="dup", external_message_id="m2")


def test_composite_assertion_key_rejects_duplicate(connection: Connection) -> None:
    _insert(connection, source_message_id="a")
    with pytest.raises(IntegrityError):
        # Distinct PK but identical (community, chat, message, edit_seq) tuple.
        _insert(connection, source_message_id="b")


def test_edit_seq_distinguishes_edit_states(connection: Connection) -> None:
    # Same message, two edit-states — both admitted, never collapsed (M3-DL-001).
    _insert(connection, source_message_id="orig", edit_seq=0)
    _insert(connection, source_message_id="edited", edit_seq=1717171717)
    count = connection.execute(select(text("count(*)")).select_from(SourceMessage)).scalar_one()
    assert count == 2


def test_edit_seq_accepts_bigint_epoch(connection: Connection) -> None:
    # An epoch-ms edit_seq overflows int32; BIGINT must accept it.
    big = 1_717_171_717_000
    _insert(connection, edit_seq=big)
    stored = connection.execute(select(SourceMessage.edit_seq)).scalar_one()
    assert stored == big


def test_detected_route_admits_full_routekind_set(connection: Connection) -> None:
    for i, route in enumerate(ROUTE_KINDS):
        _insert(
            connection,
            source_message_id=f"r-{i}",
            external_message_id=f"m-{i}",
            detected_route=route,
        )
    count = connection.execute(select(text("count(*)")).select_from(SourceMessage)).scalar_one()
    assert count == len(ROUTE_KINDS)


def test_detected_route_check_rejects_unknown_value(connection: Connection) -> None:
    with pytest.raises(IntegrityError):
        _insert(connection, detected_route="garbage")


def test_persona_and_embedding_are_nullable(connection: Connection) -> None:
    _insert(connection, persona_id=None, embedding=None)
    persona = connection.execute(select(SourceMessage.persona_id)).scalar_one()
    assert persona is None


def test_embedding_column_has_no_index(connection: Connection) -> None:
    rows = connection.execute(
        text("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'source_messages'")
    ).fetchall()
    indexdefs = [str(r[1]).lower() for r in rows]
    assert not any("embedding" in d for d in indexdefs), (
        "embedding must stay unindexed in M3 (HNSW index is M4)"
    )
    # Sanity: the PK + composite-key indexes Postgres creates do exist.
    names = {str(r[0]) for r in rows}
    assert "pk_source_messages" in names
    assert "uq_source_messages_assertion_key" in names


def test_recorded_at_defaults_to_transaction_time(connection: Connection) -> None:
    # recorded_at omitted -> server DEFAULT now() applies (ADR-004 transaction time).
    connection.execute(insert(SourceMessage), _row())
    recorded = connection.execute(select(SourceMessage.recorded_at)).scalar_one()
    assert recorded is not None


def test_valid_at_is_required(connection: Connection) -> None:
    row = _row()
    del row["valid_at"]
    with pytest.raises(IntegrityError):
        connection.execute(insert(SourceMessage), row)
