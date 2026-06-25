"""M4-P2 — embeddings backfill, enforced against a real Postgres.

Covers the M4-DL-003 / ADR-011 contract with an INJECTED fake provider (no network, no
live embedder call): pending chunks embed to ``ready`` with a 1536-d vector; the HNSW
index is built AFTER population; re-runs are idempotent (``ready`` skipped, no provider
call); a provider error marks ``failed`` and is retried next run; BOTH note and draft
chunks embed (fork b stays open); one §4-safe ``EMBEDDING_COUNTERS`` signal is emitted;
and — the structural §4 gate — an uncleared/unconfigured run is fail-closed (zero
provider calls, zero writes).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import Connection, func, insert, select

from theygrow_api.config import Settings
from theygrow_api.db.models import EMBEDDING_DIMENSION, EventChunk, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.embeddings_backfill import EmbedderNotReady, embed_backfill
from theygrow_api.ports.provider import EmbeddingBatch
from theygrow_api.signals import Signal, SignalKind

_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
_seq = 0


class _FakeProvider:
    """Injected ``EmbeddingProvider``: records calls, returns dim-correct vectors."""

    def __init__(self, *, tokens_per_text: int = 5) -> None:
        self.calls: list[list[str]] = []
        self._tpt = tokens_per_text

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        batch = list(texts)
        self.calls.append(batch)
        vectors = [[0.1] * EMBEDDING_DIMENSION for _ in batch]
        return EmbeddingBatch(vectors=vectors, total_tokens=self._tpt * len(batch))


class _FailingProvider:
    """Injected provider that always errors — drives the failed-disposition path."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        self.calls.append(list(texts))
        raise RuntimeError("simulated embedder outage")


class _RecordingSink:
    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


def _cleared_settings(
    *, cleared: bool = True, base_url: str = "http://embedder", api_key: str = "k"
) -> Settings:
    return Settings(
        database_url="postgresql://unused",
        embedder_base_url=base_url,
        embedder_api_key=api_key,
        embedder_privacy_cleared=cleared,
    )


def _seed_source(conn: Connection, *, route: str = "note") -> None:
    """Insert one date-led source row (-> 2 event chunks once derived)."""
    global _seq
    _seq += 1
    conn.execute(
        insert(SourceMessage),
        {
            "source_message_id": f"smid-{_seq}",
            "community_id": "comm-1",
            "author_user_id": "author-1",
            "external_chat_id": "chat-1",
            "external_user_id": "user-1",
            "external_message_id": f"msg-{_seq}",
            "edit_seq": 0,
            "raw_text": "2026-03-15\nfever 38.1\nslept poorly",
            "detected_route": route,
            "created_at": _CREATED,
            "valid_at": _CREATED,
        },
    )


def _chunk_rows(conn: Connection) -> list[tuple[str, Any]]:
    return [
        (r.embedding_status, r.embedding)
        for r in conn.execute(select(EventChunk.embedding_status, EventChunk.embedding)).all()
    ]


def _count_status(conn: Connection, status: str) -> int:
    return conn.execute(
        select(func.count()).select_from(EventChunk).where(EventChunk.embedding_status == status)
    ).scalar_one()


def _hnsw_exists(conn: Connection) -> bool:
    from sqlalchemy import text

    return (
        conn.execute(
            text("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_event_chunks_embedding'")
        ).first()
        is not None
    )


def test_backfill_embeds_pending_chunks(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)
    provider = _FakeProvider()

    summary = embed_backfill(connection=connection, provider=provider, settings=_cleared_settings())

    assert (summary.attempted, summary.embedded, summary.failed) == (2, 2, 0)
    assert summary.total_tokens == 10  # 2 chunks * 5 tokens
    rows = _chunk_rows(connection)
    assert all(status == "ready" for status, _ in rows)
    assert all(vec is not None and len(vec) == EMBEDDING_DIMENSION for _, vec in rows)
    assert provider.calls  # the provider was actually used


def test_backfill_builds_hnsw_index_after_population(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)
    assert not _hnsw_exists(connection)  # migration alone built no index

    embed_backfill(connection=connection, provider=_FakeProvider(), settings=_cleared_settings())

    assert _hnsw_exists(connection)


def test_backfill_is_idempotent(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)

    embed_backfill(connection=connection, provider=_FakeProvider(), settings=_cleared_settings())
    second_provider = _FakeProvider()
    second = embed_backfill(
        connection=connection, provider=second_provider, settings=_cleared_settings()
    )

    assert (second.attempted, second.embedded, second.skipped_ready) == (0, 0, 2)
    assert second_provider.calls == []  # no provider call on the no-op re-run
    assert _count_status(connection, "ready") == 2


def test_backfill_marks_failed_then_retries(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)

    first = embed_backfill(
        connection=connection, provider=_FailingProvider(), settings=_cleared_settings()
    )
    assert (first.embedded, first.failed) == (0, 2)
    assert _count_status(connection, "failed") == 2
    assert all(vec is None for _, vec in _chunk_rows(connection))

    # A later run with a working provider retries the failed rows (idempotent retry).
    second = embed_backfill(
        connection=connection, provider=_FakeProvider(), settings=_cleared_settings()
    )
    assert (second.attempted, second.embedded, second.failed) == (2, 2, 0)
    assert _count_status(connection, "ready") == 2


def test_no_retry_failed_leaves_failed_rows(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)
    embed_backfill(connection=connection, provider=_FailingProvider(), settings=_cleared_settings())

    provider = _FakeProvider()
    summary = embed_backfill(
        connection=connection,
        provider=provider,
        settings=_cleared_settings(),
        retry_failed=False,
    )

    assert summary.attempted == 0  # failed rows not selected
    assert provider.calls == []
    assert _count_status(connection, "failed") == 2


def test_backfill_embeds_both_note_and_draft_fork_b_open(connection: Connection) -> None:
    _seed_source(connection, route="note")
    _seed_source(connection, route="draft")
    rederive(connection=connection)

    summary = embed_backfill(
        connection=connection, provider=_FakeProvider(), settings=_cleared_settings()
    )

    # 2 sources * 2 chunks = 4 chunks embedded; draft is NOT filtered out here.
    assert (summary.attempted, summary.embedded) == (4, 4)
    assert _count_status(connection, "ready") == 4


def test_backfill_emits_one_embedding_counters_signal(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)
    sink = _RecordingSink()

    summary = embed_backfill(
        connection=connection,
        provider=_FakeProvider(),
        settings=_cleared_settings(),
        sink=sink,
    )

    assert len(sink.signals) == 1
    signal = sink.signals[0]
    assert signal.kind == SignalKind.EMBEDDING_COUNTERS
    payload = signal.fields()
    assert payload["attempted"] == summary.attempted
    assert payload["embedded"] == summary.embedded
    assert payload["failed"] == summary.failed
    assert payload["skipped_ready"] == summary.skipped_ready
    assert payload["total_tokens"] == summary.total_tokens
    assert isinstance(payload["duration_ms"], float)


def test_fail_closed_when_uncleared(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)
    provider = _FakeProvider()

    with pytest.raises(EmbedderNotReady):
        embed_backfill(
            connection=connection,
            provider=provider,
            settings=_cleared_settings(cleared=False),
        )

    # Structural §4 gate: zero provider calls, zero writes — all rows still pending.
    assert provider.calls == []
    assert _count_status(connection, "pending") == 2
    assert all(vec is None for _, vec in _chunk_rows(connection))


def test_fail_closed_when_unconfigured(connection: Connection) -> None:
    _seed_source(connection)
    rederive(connection=connection)

    # Cleared, but endpoint/key missing and no provider injected -> refuse before any
    # client is built or text sent.
    with pytest.raises(EmbedderNotReady):
        embed_backfill(connection=connection, settings=_cleared_settings(api_key=""))

    assert _count_status(connection, "pending") == 2
    assert all(vec is None for _, vec in _chunk_rows(connection))
