"""M4-P1/P3 — the retrieval legs (sparse lexical + dense vector).

Lifts the engine's PostgreSQL FTS baseline (``memory_rag.storage.search_repository``
+ ``storage.postgres.store.sparse_candidates``; ADR-005 §7: transfer, not
rewrite). :func:`sparse_candidates` returns event chunks ranked best-first by
``ts_rank_cd`` over a ``websearch_to_tsquery`` match against the generated
``chunk_text_tsv``; :func:`dense_candidates` (M4-P3) is the pgvector analogue, ranked by
cosine distance over the P2 HNSW index. Both are community-scoped (a query never crosses
community boundaries), honour an optional inclusive ``note_date`` range, and apply the
SAME ADR-012 note-only eligibility filter.

Reciprocal Rank Fusion of the two legs lives in ``services/retrieval.py`` (M4-P3); these
functions are the library legs it fuses. There is no chat surface (M5).

Episodic eligibility (ADR-012, fork b): BOTH legs hard-filter to
``source_messages.detected_route='note'`` via the FK join — ``draft`` chunks are embedded
and indexed but never retrievable. The filter is binary and always-on (NOT a tier/weight
knob); ``detected_route`` stays on ``source_messages`` (not denormalized).

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
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import Connection, RowMapping, text

from theygrow_api.parameters import FTS_CONFIG, RuntimeParameters
from theygrow_api.signals import RetrievalLatency, SignalSink, default_sink

#: ADR-012 (fork b): the ONLY detected_route value eligible for retrieval. A fixed module
#: literal (never user input), so splicing it into both legs' SQL is safe. ``draft`` chunks
#: are embedded + indexed but DROPPED at this filter — note-only is binary, not a knob.
_ELIGIBLE_ROUTE = "note"


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


def _row_to_candidate(row: RowMapping) -> Candidate:
    """Map one result row to a :class:`Candidate` (shared by both legs)."""
    return Candidate(
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
    # ADR-012 (fork b): the note-only episodic-eligibility filter is a HARD WHERE via the
    # source_messages FK join — only detected_route='note' is retrievable; draft chunks are
    # embedded/indexed but never surface. Binary, always-on (not a tier/weight knob), and on
    # BOTH legs; route stays on source_messages (not denormalized — P1 decision held).
    stmt = text(
        f"WITH q AS (SELECT websearch_to_tsquery('{FTS_CONFIG}', :q) AS tsq) "
        "SELECT ec.chunk_id, ec.note_id, ec.source_message_id, "
        "       ec.community_id, ec.author_user_id, ec.note_date, "
        "       ec.event_index, ec.chunk_text, ec.created_at, "
        "       ec.embedding_status "
        # `q` first in the comma list so the explicit JOIN binds to `ec`, not to `q`
        # (FROM a, b JOIN c parses as a, (b JOIN c) — the JOIN must attach to event_chunks).
        "  FROM q, event_chunks ec "
        "  JOIN source_messages sm ON sm.source_message_id = ec.source_message_id "
        " WHERE ec.community_id = :community_id "
        "   AND sm.detected_route = '" + _ELIGIBLE_ROUTE + "' "
        "   AND ec.chunk_text_tsv @@ q.tsq" + date_sql + " "
        " ORDER BY ts_rank_cd(ec.chunk_text_tsv, q.tsq) DESC, "
        "          ec.created_at, ec.event_index "
        " LIMIT :limit"
    )
    started = time.perf_counter()
    rows = connection.execute(stmt, params).mappings().all()
    latency_ms = (time.perf_counter() - started) * 1000.0
    candidates = [_row_to_candidate(row) for row in rows]
    # §4: counts/timings only — no community_id, no chunk_text.
    sink.emit(
        RetrievalLatency(leg="sparse", candidate_count=len(candidates), latency_ms=latency_ms)
    )
    return candidates


def dense_candidates(
    connection: Connection,
    community_id: str,
    query_vector: Sequence[float],
    limit: int | None = None,
    *,
    date_range: DateRange | None = None,
    sink: SignalSink | None = None,
) -> list[Candidate]:
    """Return up to ``limit`` chunks ranked by cosine proximity to ``query_vector``.

    The dense (pgvector) analogue of :func:`sparse_candidates`, mirroring its shape:
    community-scoped, optional inclusive ``note_date`` range, the SAME ADR-012 note-only
    FK-join filter, and one §4-safe ``RETRIEVAL_LATENCY`` emission (``leg="dense"``).

    Cosine distance (``<=>``) over the HNSW index (``vector_cosine_ops``), ascending
    (nearest first) — ``text-embedding-3-*`` vectors are normalized, so cosine is the donor
    metric. Only ``embedding_status='ready'`` rows (a non-NULL vector) participate. The
    repository is a PURE SQL port: it takes an ALREADY-embedded query vector — the provider
    call lives in the orchestrator (``services.retrieval``), keeping the only child-text
    egress on the cleared embedder seam. ``limit`` defaults to the config-surface
    ``candidate_k``. Empty vector / ``limit <= 0`` short-circuit to ``[]`` (no DB round-trip,
    no signal). §4: logs nothing; callers keep ``chunk_text`` out of telemetry.
    """
    sink = sink if sink is not None else default_sink()
    if limit is None:
        limit = RuntimeParameters().candidate_k
    if not community_id:
        raise ValueError("community_id is required")
    if limit <= 0:
        return []
    if not query_vector:
        return []

    params: dict[str, object] = {
        # pgvector binds a vector literal from its textual form: "[f1,f2,...]".
        "qvec": "[" + ",".join(repr(float(x)) for x in query_vector) + "]",
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

    stmt = text(
        "SELECT ec.chunk_id, ec.note_id, ec.source_message_id, "
        "       ec.community_id, ec.author_user_id, ec.note_date, "
        "       ec.event_index, ec.chunk_text, ec.created_at, "
        "       ec.embedding_status "
        "  FROM event_chunks ec "
        "  JOIN source_messages sm ON sm.source_message_id = ec.source_message_id "
        " WHERE ec.community_id = :community_id "
        "   AND sm.detected_route = '" + _ELIGIBLE_ROUTE + "' "
        "   AND ec.embedding_status = 'ready'" + date_sql + " "
        " ORDER BY ec.embedding <=> CAST(:qvec AS vector), "
        "          ec.created_at, ec.event_index "
        " LIMIT :limit"
    )
    started = time.perf_counter()
    rows = connection.execute(stmt, params).mappings().all()
    latency_ms = (time.perf_counter() - started) * 1000.0
    candidates = [_row_to_candidate(row) for row in rows]
    # §4: counts/timings only — no community_id, no chunk_text.
    sink.emit(RetrievalLatency(leg="dense", candidate_count=len(candidates), latency_ms=latency_ms))
    return candidates
