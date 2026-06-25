"""M4-P1 — re-derivation pass, enforced against a real Postgres.

Covers the M4-DL-001 decisions: faithful two-table derivation (notes +
event_chunks), the fallback-to-created_at disposition for non-date-led rows,
valid_at recovery on a recovered ISO date, deriving BOTH note and draft (fork b
open), and idempotency of the offline pass.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import Connection, func, insert, select

from theygrow_api.db.models import EventChunk, Note, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.signals import Signal, SignalKind


class _RecordingSink:
    """Test sink that captures emitted signals instead of logging them."""

    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)

_seq = 0


def _insert_source(conn: Connection, **overrides: object) -> None:
    """Insert one valid source_messages row; override any field per test.

    Each call gets a distinct source_message_id / external_message_id so the PK
    and composite assertion key never collide unless a test forces it.
    """
    global _seq
    _seq += 1
    row: dict[str, object] = {
        "source_message_id": f"smid-{_seq}",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": "chat-1",
        "external_user_id": "user-1",
        "external_message_id": f"msg-{_seq}",
        "edit_seq": 0,
        "raw_text": "2026-03-15\nfever 38.1\nslept poorly",
        "detected_route": "note",
        "created_at": _CREATED,
        "valid_at": _CREATED,
    }
    row.update(overrides)
    conn.execute(insert(SourceMessage), row)


def _count(conn: Connection, model: type) -> int:
    return conn.execute(select(func.count()).select_from(model)).scalar_one()


def test_date_led_note_derives_layer_and_recovers_valid_at(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-dated")

    summary = rederive(connection=connection)

    assert (summary.derived_dated, summary.derived_fallback, summary.chunks) == (1, 0, 2)
    note = connection.execute(select(Note)).one()
    assert note.note_id == "sm-dated"
    assert note.note_date == date(2026, 3, 15)
    assert note.note_text == "fever 38.1\nslept poorly"

    chunks = connection.execute(
        select(EventChunk.event_index, EventChunk.chunk_text, EventChunk.embedding_status).order_by(
            EventChunk.event_index
        )
    ).all()
    assert [(c.event_index, c.chunk_text) for c in chunks] == [
        (0, "fever 38.1"),
        (1, "slept poorly"),
    ]
    assert all(c.embedding_status == "pending" for c in chunks)

    # valid_at recovered to the parsed event date (UTC midnight), not created_at.
    valid_at = connection.execute(
        select(SourceMessage.valid_at).where(SourceMessage.source_message_id == "sm-dated")
    ).scalar_one()
    assert valid_at == datetime(2026, 3, 15, tzinfo=UTC)


def test_non_date_row_falls_back_to_created_at(connection: Connection) -> None:
    _insert_source(
        connection,
        source_message_id="sm-fallback",
        raw_text="woke early\nfever later",
    )

    summary = rederive(connection=connection)

    assert (summary.derived_dated, summary.derived_fallback, summary.chunks) == (0, 1, 2)
    note = connection.execute(select(Note)).one()
    # note_date := created_at's date; ALL non-empty lines became chunks.
    assert note.note_date == date(2026, 1, 1)
    texts = (
        connection.execute(select(EventChunk.chunk_text).order_by(EventChunk.event_index))
        .scalars()
        .all()
    )
    assert texts == ["woke early", "fever later"]

    # valid_at keeps the M3 placeholder (no recovery happened).
    valid_at = connection.execute(
        select(SourceMessage.valid_at).where(SourceMessage.source_message_id == "sm-fallback")
    ).scalar_one()
    assert valid_at == _CREATED


def test_draft_is_derived_keeping_fork_b_open(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-draft", detected_route="draft")

    summary = rederive(connection=connection)

    assert summary.sources_processed == 1
    assert _count(connection, Note) == 1
    note_source = connection.execute(select(Note.source_message_id)).scalar_one()
    assert note_source == "sm-draft"


def test_non_live_route_is_not_derived(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-note", detected_route="note")
    # 'ask' is admitted by the CHECK but is not a live route — must be ignored.
    _insert_source(connection, source_message_id="sm-ask", detected_route="ask")

    summary = rederive(connection=connection)

    assert summary.sources_processed == 1
    sources = connection.execute(select(Note.source_message_id)).scalars().all()
    assert sources == ["sm-note"]


def test_rederive_is_idempotent(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-idem")

    first = rederive(connection=connection)
    second = rederive(connection=connection)

    assert first == second
    # No duplication: still exactly one note and two chunks after the re-run.
    assert _count(connection, Note) == 1
    assert _count(connection, EventChunk) == 2


def test_whitespace_only_raw_text_is_skipped(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-blank", raw_text="   \n  \n")

    summary = rederive(connection=connection)

    assert summary.skipped_empty == 1
    assert _count(connection, Note) == 0
    assert _count(connection, EventChunk) == 0


def test_rederive_emits_one_derivation_counters_signal(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-sig")
    sink = _RecordingSink()

    summary = rederive(connection=connection, sink=sink)

    assert len(sink.signals) == 1
    signal = sink.signals[0]
    assert signal.kind == SignalKind.DERIVATION_COUNTERS
    # The emitted payload mirrors the counts-only summary exactly.
    assert signal.fields() == {
        "sources_processed": summary.sources_processed,
        "derived_dated": summary.derived_dated,
        "derived_fallback": summary.derived_fallback,
        "chunks": summary.chunks,
        "skipped_empty": summary.skipped_empty,
    }
