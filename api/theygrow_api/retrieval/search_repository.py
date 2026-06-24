"""M4-P1 — sparse (lexical) retrieval leg.

Lifts the engine's PostgreSQL FTS baseline (``memory_rag.storage.search_repository``
+ ``storage.postgres.store.sparse_candidates``; ADR-005 §7: transfer, not
rewrite). Returns event chunks ranked best-first by ``ts_rank_cd`` over a
``websearch_to_tsquery`` match against the generated ``chunk_text_tsv``.
Community-scoped (a query never crosses community boundaries); optional inclusive
``note_date`` range.

This is ONE leg only. The dense (pgvector) leg is M4-P2 (gated: provider/model +
final dimension, fork a). Reciprocal Rank Fusion of the two legs and the
episodic-eligibility filter are M4-P3 (fork a + fork b). There is no chat surface
(M5); this function is a library seam exercised by tests until P3 consumes it.

FTS config is ``FTS_CONFIG`` (``'simple'``) — a faithful donor lift that does NO
Russian morphological stemming, so lexical recall on the Russian corpus is the
known weakest link (ADR-008); the named port-out trigger is FTS -> ``'russian'``
/ ParadeDB by a recall metric (M4-DL-001). The leg's mechanics (match / ranking /
community scope / date range) are tested here; Russian recall adequacy is NOT
established by those tests — that measurement belongs to the M4-close mini-eval.

Privacy (AGENTS.md §4): this function logs nothing; callers must keep
``chunk_text`` out of logs and telemetry.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import Connection, text

from theygrow_api.parameters import FTS_CONFIG, RuntimeParameters
from theygrow_api.signals import RetrievalLatency, SignalSink, default_sink


@dataclass(frozen=True)
class DateRange:
    """Inclusive ``note_date`` bound (donor lift).

    Both bounds optional and inclusive; both ``None`` is a valid no-constraint
    range. ``start > end`` is contradictory and rejected at construction.
    """

    start: date | None = None
    end: date | None = None

    def __post_init__(self) -> None:
        if self.start is not None and self.end is not None and self.start > self.end:
            raise ValueError(
                f"DateRange.start must be <= end (got start={self.start}, end={self.end})"
            )


@dataclass(frozen=True)
class Candidate:
    """One ranked event chunk — the sparse leg's return unit (donor ``EventChunk``)."""

    chunk_id: str
    note_id: str
    source_message_id: str
    community_id: str
    author_user_id: str
    note_date: date
    event_index: int
    chunk_text: str
    created_at: datetime
    embedding_status: str


def sparse_candidates(
    connection: Connection,
    community_id: str,
    query_text: str,
    limit: int | None = None,
    *,
    date_range: DateRange | None = None,
    sink: SignalSink | None = None,
) -> list[Candidate]:
    """Return up to ``limit`` chunks ranked by the PostgreSQL FTS baseline.

    Community-scoped. ``limit`` defaults to the config-surface
    ``sparse_candidate_limit`` (``parameters.RuntimeParameters``) when not supplied — the
    knob lives in the surface, not as a scattered literal. Empty / whitespace query and
    ``limit <= 0`` short-circuit to ``[]`` (no DB round-trip, no signal — no retrieval
    ran), matching the donor's guards. On the executed-query path a single
    ``RETRIEVAL_LATENCY`` signal (candidate count + latency) is emitted through ``sink``
    (default: the PII-guarded logging sink); §4: counts/timings only.
    """
    sink = sink if sink is not None else default_sink()
    if limit is None:
        limit = RuntimeParameters().sparse_candidate_limit
    if not community_id:
        raise ValueError("community_id is required")
    if limit <= 0:
        return []
    if not query_text.strip():
        return []

    params: dict[str, object] = {
        "q": query_text,
        "community_id": community_id,
        "limit": limit,
    }
    date_sql = ""
    if date_range is not None:
        if date_range.start is not None:
            date_sql += " AND ec.note_date >= :date_start"
            params["date_start"] = date_range.start
        if date_range.end is not None:
            date_sql += " AND ec.note_date <= :date_end"
            params["date_end"] = date_range.end

    # FTS_CONFIG is a fixed module literal (never user input), so splicing it into
    # the config-name position is safe; :q and the rest are bound parameters.
    stmt = text(
        f"WITH q AS (SELECT websearch_to_tsquery('{FTS_CONFIG}', :q) AS tsq) "
        "SELECT ec.chunk_id, ec.note_id, ec.source_message_id, "
        "       ec.community_id, ec.author_user_id, ec.note_date, "
        "       ec.event_index, ec.chunk_text, ec.created_at, "
        "       ec.embedding_status "
        "  FROM event_chunks ec, q "
        " WHERE ec.community_id = :community_id "
        "   AND ec.chunk_text_tsv @@ q.tsq" + date_sql + " "
        " ORDER BY ts_rank_cd(ec.chunk_text_tsv, q.tsq) DESC, "
        "          ec.created_at, ec.event_index "
        " LIMIT :limit"
    )
    started = time.perf_counter()
    rows = connection.execute(stmt, params).mappings().all()
    latency_ms = (time.perf_counter() - started) * 1000.0
    candidates = [
        Candidate(
            chunk_id=row["chunk_id"],
            note_id=row["note_id"],
            source_message_id=row["source_message_id"],
            community_id=row["community_id"],
            author_user_id=row["author_user_id"],
            note_date=row["note_date"],
            event_index=row["event_index"],
            chunk_text=row["chunk_text"],
            created_at=row["created_at"],
            embedding_status=row["embedding_status"],
        )
        for row in rows
    ]
    # §4: counts/timings only — no community_id, no chunk_text.
    sink.emit(RetrievalLatency(candidate_count=len(candidates), latency_ms=latency_ms))
    return candidates
