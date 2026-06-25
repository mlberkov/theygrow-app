"""M4-P1 — sparse (FTS) leg mechanics, enforced against a real Postgres.

Validates the lifted leg's MECHANICS only: tsvector match, ts_rank_cd ordering,
community scoping, the inclusive note_date range, and the empty-query / non-
positive-limit short-circuits. These tests do NOT establish Russian lexical
recall adequacy — the 'simple' config does no morphological stemming (M4-DL-001 /
ADR-008); recall measurement belongs to the M4-close mini-eval, not here.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import Connection, insert, text

from theygrow_api.db.models import EMBEDDING_DIMENSION, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.retrieval.search_repository import (
    DateRange,
    dense_candidates,
    sparse_candidates,
)
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
    global _seq
    _seq += 1
    row: dict[str, object] = {
        "source_message_id": f"q-smid-{_seq}",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": "chat-1",
        "external_user_id": "user-1",
        "external_message_id": f"q-msg-{_seq}",
        "edit_seq": 0,
        "raw_text": "2026-03-15\nplaceholder",
        "detected_route": "note",
        "created_at": _CREATED,
        "valid_at": _CREATED,
    }
    row.update(overrides)
    conn.execute(insert(SourceMessage), row)


def test_match_returns_the_chunk(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-match", raw_text="2026-03-15\nfever spiked")
    rederive(connection=connection)

    hits = sparse_candidates(connection, "comm-1", "fever", limit=10)

    assert [h.chunk_text for h in hits] == ["fever spiked"]
    assert hits[0].source_message_id == "sm-match"
    assert hits[0].note_date == date(2026, 3, 15)


def test_no_match_returns_empty(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nfever spiked")
    rederive(connection=connection)

    assert sparse_candidates(connection, "comm-1", "unrelated", limit=10) == []


def test_ranking_prefers_higher_term_frequency(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-hi", raw_text="2026-03-01\nalpha alpha alpha")
    _insert_source(connection, source_message_id="sm-lo", raw_text="2026-03-02\nalpha")
    rederive(connection=connection)

    hits = sparse_candidates(connection, "comm-1", "alpha", limit=10)

    assert [h.source_message_id for h in hits] == ["sm-hi", "sm-lo"]


def test_community_scoped(connection: Connection) -> None:
    _insert_source(
        connection,
        source_message_id="sm-c1",
        community_id="comm-1",
        external_chat_id="chat-c1",
        raw_text="2026-03-15\nzebra",
    )
    _insert_source(
        connection,
        source_message_id="sm-c2",
        community_id="comm-2",
        external_chat_id="chat-c2",
        raw_text="2026-03-15\nzebra",
    )
    rederive(connection=connection)

    hits = sparse_candidates(connection, "comm-1", "zebra", limit=10)

    assert [h.source_message_id for h in hits] == ["sm-c1"]


def test_date_range_filters_inclusively(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-early", raw_text="2026-03-01\nmango")
    _insert_source(connection, source_message_id="sm-late", raw_text="2026-03-10\nmango")
    rederive(connection=connection)

    hits = sparse_candidates(
        connection, "comm-1", "mango", limit=10, date_range=DateRange(start=date(2026, 3, 5))
    )

    assert [h.source_message_id for h in hits] == ["sm-late"]


def test_empty_query_and_nonpositive_limit_short_circuit(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nfever")
    rederive(connection=connection)

    assert sparse_candidates(connection, "comm-1", "   ", limit=10) == []
    assert sparse_candidates(connection, "comm-1", "fever", limit=0) == []


def test_sparse_emits_retrieval_latency_signal(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-sig", raw_text="2026-03-15\nfever spiked")
    rederive(connection=connection)
    sink = _RecordingSink()

    hits = sparse_candidates(connection, "comm-1", "fever", limit=10, sink=sink)

    assert len(sink.signals) == 1
    signal = sink.signals[0]
    assert signal.kind == SignalKind.RETRIEVAL_LATENCY
    payload = signal.fields()
    assert payload["candidate_count"] == len(hits)
    assert isinstance(payload["latency_ms"], float)
    assert payload["latency_ms"] >= 0.0


def test_sparse_limit_defaults_from_config_surface(connection: Connection) -> None:
    # Omitting `limit` resolves to RuntimeParameters().sparse_candidate_limit (default 20),
    # not a scattered literal — the knob lives in the config surface.
    _insert_source(connection, raw_text="2026-03-15\nmango")
    rederive(connection=connection)

    hits = sparse_candidates(connection, "comm-1", "mango")

    assert [h.chunk_text for h in hits] == ["mango"]


def test_short_circuit_emits_no_signal(connection: Connection) -> None:
    sink = _RecordingSink()

    assert sparse_candidates(connection, "comm-1", "   ", limit=10, sink=sink) == []
    assert sparse_candidates(connection, "comm-1", "x", limit=0, sink=sink) == []
    # No retrieval ran -> no signal emitted.
    assert sink.signals == []


# --- Dense (pgvector) leg + the shared note-only eligibility filter (M4-P3) -------------


def _unit_vec(*nonzero: float) -> list[float]:
    """A 1536-d vector with the given leading components (rest zero)."""
    v = [0.0] * EMBEDDING_DIMENSION
    for i, x in enumerate(nonzero):
        v[i] = float(x)
    return v


def _set_ready_embedding(conn: Connection, *, chunk_text: str, vector: list[float]) -> None:
    """Mark the chunk(s) with this text 'ready' and assign a vector (no provider call)."""
    literal = "[" + ",".join(repr(x) for x in vector) + "]"
    conn.execute(
        text(
            "UPDATE event_chunks SET embedding = CAST(:vec AS vector), "
            "embedding_status = 'ready' WHERE chunk_text = :ct"
        ),
        {"vec": literal, "ct": chunk_text},
    )


def test_dense_orders_by_cosine_proximity(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-d", raw_text="2026-03-15\napple\nbanana")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="apple", vector=_unit_vec(1.0))
    _set_ready_embedding(connection, chunk_text="banana", vector=_unit_vec(0.0, 1.0))

    # Query nearest to 'apple' -> apple first (distance 0), banana second.
    hits = dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=10)

    assert [h.chunk_text for h in hits] == ["apple", "banana"]


def test_dense_only_ready_rows_participate(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-r", raw_text="2026-03-15\nready_chunk")
    _insert_source(connection, source_message_id="sm-p", raw_text="2026-03-15\npending_chunk")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="ready_chunk", vector=_unit_vec(1.0))
    # 'pending_chunk' is left embedding_status='pending' (no vector).

    hits = dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=10)

    assert [h.chunk_text for h in hits] == ["ready_chunk"]


def test_dense_community_scoped(connection: Connection) -> None:
    _insert_source(
        connection,
        source_message_id="sm-dc1",
        community_id="comm-1",
        external_chat_id="chat-dc1",
        raw_text="2026-03-15\nzebra",
    )
    _insert_source(
        connection,
        source_message_id="sm-dc2",
        community_id="comm-2",
        external_chat_id="chat-dc2",
        raw_text="2026-03-15\nzebra",
    )
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="zebra", vector=_unit_vec(1.0))

    hits = dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=10)

    assert [h.source_message_id for h in hits] == ["sm-dc1"]


def test_dense_empty_vector_and_nonpositive_limit_short_circuit(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nfever")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="fever", vector=_unit_vec(1.0))
    sink = _RecordingSink()

    assert dense_candidates(connection, "comm-1", [], limit=10, sink=sink) == []
    assert dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=0, sink=sink) == []
    # No retrieval ran -> no signal emitted.
    assert sink.signals == []


def test_dense_emits_retrieval_latency_signal_labelled_dense(connection: Connection) -> None:
    _insert_source(connection, source_message_id="sm-ds", raw_text="2026-03-15\nfever")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="fever", vector=_unit_vec(1.0))
    sink = _RecordingSink()

    hits = dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=10, sink=sink)

    assert len(sink.signals) == 1
    payload = sink.signals[0].fields()
    assert sink.signals[0].kind == SignalKind.RETRIEVAL_LATENCY
    assert payload["leg"] == "dense"
    assert payload["candidate_count"] == len(hits)


def test_both_legs_exclude_draft_route(connection: Connection) -> None:
    # ADR-012 (fork b): a draft chunk that is fully embedded AND lexically matchable is still
    # DROPPED at the retrieval filter — note-only is enforced in BOTH legs.
    _insert_source(
        connection,
        source_message_id="sm-note",
        external_chat_id="chat-note",
        detected_route="note",
        raw_text="2026-03-15\nzeppelin",
    )
    _insert_source(
        connection,
        source_message_id="sm-draft",
        external_chat_id="chat-draft",
        detected_route="draft",
        raw_text="2026-03-15\nzeppelin",
    )
    rederive(connection=connection)
    # Both chunks ready + identical vector: only the route filter can separate them.
    _set_ready_embedding(connection, chunk_text="zeppelin", vector=_unit_vec(1.0))

    sparse_hits = sparse_candidates(connection, "comm-1", "zeppelin", limit=10)
    dense_hits = dense_candidates(connection, "comm-1", _unit_vec(1.0), limit=10)

    assert [h.source_message_id for h in sparse_hits] == ["sm-note"]
    assert [h.source_message_id for h in dense_hits] == ["sm-note"]
