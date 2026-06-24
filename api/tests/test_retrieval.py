"""M4-P3 — retrieval fusion (RRF) + the fail-closed query-embedding gate.

Two layers: RRF as a PURE function (ordering / dedup / weights / deterministic tiebreak,
no DB), and the :func:`retrieve` orchestrator against a real Postgres with an INJECTED fake
provider — leg fan-out, top_k truncation, the §4-safe ``leg="fused"`` emission, the
end-to-end note-only guarantee (draft never surfaces through the fused path), and the
fail-closed ZDR gate (uncleared -> zero provider calls, no embed, raises before egress).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import Connection, insert, text

from theygrow_api.config import Settings
from theygrow_api.db.models import EMBEDDING_DIMENSION, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.ports.provider import EmbeddingBatch
from theygrow_api.retrieval.search_repository import Candidate
from theygrow_api.services.retrieval import (
    EmbedderNotReady,
    reciprocal_rank_fusion,
    retrieve,
)
from theygrow_api.signals import Signal, SignalKind

_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
_seq = 0


# --- RRF as a pure function ------------------------------------------------------------


def _cand(chunk_id: str, *, created_at: datetime = _CREATED, event_index: int = 0) -> Candidate:
    return Candidate(
        chunk_id=chunk_id,
        note_id="note-1",
        source_message_id="smid-1",
        community_id="comm-1",
        author_user_id="author-1",
        note_date=date(2026, 3, 15),
        event_index=event_index,
        chunk_text="t",
        created_at=created_at,
        embedding_status="ready",
    )


def test_rrf_fuses_and_dedupes_by_chunk_id() -> None:
    a, b, c = _cand("A"), _cand("B"), _cand("C")
    fused = reciprocal_rank_fusion(
        dense=[a, b], sparse=[b, c], k=60, dense_weight=1.0, sparse_weight=1.0
    )

    # B appears in both legs (dense rank 2 + sparse rank 1) -> highest fused score.
    assert [f.candidate.chunk_id for f in fused] == ["B", "A", "C"]
    bf = next(f for f in fused if f.candidate.chunk_id == "B")
    assert (bf.dense_rank, bf.sparse_rank) == (2, 1)
    af = next(f for f in fused if f.candidate.chunk_id == "A")
    assert (af.dense_rank, af.sparse_rank) == (1, None)
    cf = next(f for f in fused if f.candidate.chunk_id == "C")
    assert (cf.dense_rank, cf.sparse_rank) == (None, 2)


def test_rrf_weights_bias_the_blend() -> None:
    x, y = _cand("X"), _cand("Y")
    # Each appears at rank 1 in one leg; a heavier dense weight ranks the dense-only hit first.
    fused = reciprocal_rank_fusion(
        dense=[x], sparse=[y], k=60, dense_weight=10.0, sparse_weight=1.0
    )
    assert [f.candidate.chunk_id for f in fused] == ["X", "Y"]


def test_rrf_tiebreak_is_deterministic() -> None:
    # Equal fused score (each rank-1 in one leg, equal weights) -> stable tiebreak by
    # created_at, then event_index, then chunk_id.
    early = _cand("Z-late", created_at=datetime(2026, 1, 1, tzinfo=UTC))
    late = _cand("A-early", created_at=datetime(2026, 6, 1, tzinfo=UTC))
    fused = reciprocal_rank_fusion(
        dense=[early], sparse=[late], k=60, dense_weight=1.0, sparse_weight=1.0
    )
    assert [f.candidate.chunk_id for f in fused] == ["Z-late", "A-early"]


# --- The retrieve() orchestrator against a real Postgres -------------------------------


class _FakeProvider:
    """Injected provider: records calls, returns a fixed query vector."""

    def __init__(self, vector: list[float]) -> None:
        self.calls: list[list[str]] = []
        self._vector = vector

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        self.calls.append(list(texts))
        return EmbeddingBatch(vectors=[self._vector for _ in texts], total_tokens=1)


class _RecordingSink:
    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


def _cleared_settings(*, cleared: bool = True) -> Settings:
    return Settings(
        database_url="postgresql://unused",
        embedder_base_url="http://embedder",
        embedder_api_key="k",
        embedder_privacy_cleared=cleared,
    )


def _unit_vec(*nonzero: float) -> list[float]:
    v = [0.0] * EMBEDDING_DIMENSION
    for i, x in enumerate(nonzero):
        v[i] = float(x)
    return v


def _insert_source(conn: Connection, **overrides: object) -> None:
    global _seq
    _seq += 1
    row: dict[str, object] = {
        "source_message_id": f"r-smid-{_seq}",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": f"r-chat-{_seq}",
        "external_user_id": "user-1",
        "external_message_id": f"r-msg-{_seq}",
        "edit_seq": 0,
        "raw_text": "2026-03-15\nplaceholder",
        "detected_route": "note",
        "created_at": _CREATED,
        "valid_at": _CREATED,
    }
    row.update(overrides)
    conn.execute(insert(SourceMessage), row)


def _set_ready_embedding(conn: Connection, *, chunk_text: str, vector: list[float]) -> None:
    literal = "[" + ",".join(repr(x) for x in vector) + "]"
    conn.execute(
        text(
            "UPDATE event_chunks SET embedding = CAST(:vec AS vector), "
            "embedding_status = 'ready' WHERE chunk_text = :ct"
        ),
        {"vec": literal, "ct": chunk_text},
    )


def test_retrieve_fuses_legs_and_truncates_top_k(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nalpha\nbeta")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="alpha", vector=_unit_vec(1.0))
    _set_ready_embedding(connection, chunk_text="beta", vector=_unit_vec(0.0, 1.0))

    fused = retrieve(
        connection,
        "comm-1",
        "alpha",
        candidate_k=10,
        top_k=1,
        provider=_FakeProvider(_unit_vec(1.0)),
        settings=_cleared_settings(),
    )

    assert len(fused) == 1
    # 'alpha' wins: nearest dense + the lexical match.
    assert fused[0].candidate.chunk_text == "alpha"


def test_retrieve_emits_three_labelled_latency_signals(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nalpha")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="alpha", vector=_unit_vec(1.0))
    sink = _RecordingSink()

    retrieve(
        connection,
        "comm-1",
        "alpha",
        provider=_FakeProvider(_unit_vec(1.0)),
        settings=_cleared_settings(),
        sink=sink,
    )

    legs = [str(s.fields()["leg"]) for s in sink.signals if s.kind == SignalKind.RETRIEVAL_LATENCY]
    assert sorted(legs) == ["dense", "fused", "sparse"]


def test_retrieve_excludes_draft_end_to_end(connection: Connection) -> None:
    _insert_source(
        connection, source_message_id="r-note", detected_route="note", raw_text="2026-03-15\nomega"
    )
    _insert_source(
        connection,
        source_message_id="r-draft",
        detected_route="draft",
        raw_text="2026-03-15\nomega",
    )
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="omega", vector=_unit_vec(1.0))

    fused = retrieve(
        connection,
        "comm-1",
        "omega",
        provider=_FakeProvider(_unit_vec(1.0)),
        settings=_cleared_settings(),
    )

    assert fused, "the note chunk must be retrievable"
    assert {f.candidate.source_message_id for f in fused} == {"r-note"}


def test_retrieve_fail_closed_when_uncleared(connection: Connection) -> None:
    _insert_source(connection, raw_text="2026-03-15\nalpha")
    rederive(connection=connection)
    _set_ready_embedding(connection, chunk_text="alpha", vector=_unit_vec(1.0))
    provider = _FakeProvider(_unit_vec(1.0))

    # §4 gate runs FIRST — even with a provider in hand, an uncleared process cannot embed.
    with pytest.raises(EmbedderNotReady):
        retrieve(
            connection,
            "comm-1",
            "alpha",
            provider=provider,
            settings=_cleared_settings(cleared=False),
        )

    assert provider.calls == []  # zero provider calls, no query text left the perimeter


def test_retrieve_empty_query_short_circuits_before_embedding(connection: Connection) -> None:
    provider = _FakeProvider(_unit_vec(1.0))

    out = retrieve(connection, "comm-1", "   ", provider=provider, settings=_cleared_settings())

    assert out == []
    assert provider.calls == []  # no embed on an empty query
