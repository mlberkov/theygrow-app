"""M4-P3 — retrieval fusion: RRF over the dense + sparse legs.

Lifts the engine's Reciprocal Rank Fusion (``memory_rag.services.retrieval``; ADR-005 §7:
transfer, not rewrite — the donor is out of perimeter, so the algorithm is transferred, not
imported). :func:`reciprocal_rank_fusion` fuses the two leg rankings into one scored,
deduplicated candidate list; :func:`retrieve` is the orchestrator that embeds the query,
runs both legs at the symmetric ``candidate_k`` depth, fuses, and truncates to ``top_k``.

Episodic eligibility (ADR-012, fork b) is enforced INSIDE each leg (the note-only FK-join
filter); the fused result therefore inherits note-only by construction — no draft chunk can
reach a caller.

§4 fail-closed query embedding (ADR-011 §1): :func:`retrieve` embeds ``query_text`` through
the provider-port — that is USER text leaving the perimeter to the third-party embedder,
exactly the surface ADR-011 governs. It is NOT privacy-exempt for being read-path: the SAME
ZDR + DPA + EU-residency clearance gate as the offline backfill runs FIRST, so an uncleared
process makes ZERO provider calls and embeds nothing. The gate and provider construction are
REUSED from ``embeddings_backfill`` (one fail-closed gate, never a second drifting copy).

Since A2-P3 (``L2-DL-003``) that gate is scoped to EGRESS here too, the way the backfill's
already was: it is asked of the real provider path and of any injected provider that does
not structurally declare ``performs_no_egress is True``, and is skipped only for an
in-perimeter provider — which removes the third-party surface instead of crossing it. The
declaration check is fail-closed (absent or non-``True`` reads as egressing), so the
narrowing cannot become a bypass by omission. Before A2-P3 the gate ran unconditionally,
which made the read path unreachable for the in-perimeter staging embedder and would have
forced the eval pipeline to set a clearance flag nobody granted.

Privacy (AGENTS.md §4): this module logs nothing beyond the §4-safe ``RETRIEVAL_LATENCY``
signals (a leg label + counts + timings); ``chunk_text`` and ``query_text`` never enter
telemetry. ``query_text`` leaves the perimeter to the cleared embedder alone.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Connection

from theygrow_api.config import Settings, get_settings
from theygrow_api.embeddings_backfill import (
    EmbedderNotReady,
    _build_provider,
    _ensure_embedder_cleared,
)
from theygrow_api.parameters import RuntimeParameters
from theygrow_api.ports.provider import EmbeddingProvider, performs_no_egress
from theygrow_api.retrieval.search_repository import (
    Candidate,
    DateRange,
    dense_candidates,
    sparse_candidates,
)
from theygrow_api.signals import RetrievalLatency, SignalSink, default_sink

__all__ = [
    "EmbedderNotReady",
    "FusedCandidate",
    "reciprocal_rank_fusion",
    "retrieve",
]


@dataclass(frozen=True)
class FusedCandidate:
    """One fused result: the chunk, its fused RRF score, and its per-leg ranks.

    ``dense_rank`` / ``sparse_rank`` are 1-based ranks within each leg (``None`` if the chunk
    was absent from that leg) — kept for observability / P4 explainability, never logged.
    """

    candidate: Candidate
    score: float
    dense_rank: int | None
    sparse_rank: int | None


def reciprocal_rank_fusion(
    *,
    dense: list[Candidate],
    sparse: list[Candidate],
    k: int,
    dense_weight: float,
    sparse_weight: float,
) -> list[FusedCandidate]:
    """Fuse the two leg rankings by weighted Reciprocal Rank Fusion.

    ``score(chunk) = Σ_leg weight_leg / (k + rank_leg)`` over the legs the chunk appears in
    (1-based rank). Deduplicated by ``chunk_id``; ranked by fused score DESC with a
    deterministic tiebreak (``created_at``, ``event_index``, ``chunk_id``) so equal-score
    ties are stable across runs. A faithful transfer of the donor RRF — no engine import.
    """
    scores: dict[str, float] = {}
    dense_rank: dict[str, int] = {}
    sparse_rank: dict[str, int] = {}
    by_id: dict[str, Candidate] = {}

    for rank, cand in enumerate(dense, start=1):
        scores[cand.chunk_id] = scores.get(cand.chunk_id, 0.0) + dense_weight / (k + rank)
        dense_rank.setdefault(cand.chunk_id, rank)
        by_id.setdefault(cand.chunk_id, cand)
    for rank, cand in enumerate(sparse, start=1):
        scores[cand.chunk_id] = scores.get(cand.chunk_id, 0.0) + sparse_weight / (k + rank)
        sparse_rank.setdefault(cand.chunk_id, rank)
        by_id.setdefault(cand.chunk_id, cand)

    fused = [
        FusedCandidate(
            candidate=by_id[chunk_id],
            score=score,
            dense_rank=dense_rank.get(chunk_id),
            sparse_rank=sparse_rank.get(chunk_id),
        )
        for chunk_id, score in scores.items()
    ]
    fused.sort(
        key=lambda f: (
            -f.score,
            f.candidate.created_at,
            f.candidate.event_index,
            f.candidate.chunk_id,
        )
    )
    return fused


def retrieve(
    connection: Connection,
    community_id: str,
    query_text: str,
    *,
    candidate_k: int | None = None,
    top_k: int | None = None,
    date_range: DateRange | None = None,
    provider: EmbeddingProvider | None = None,
    settings: Settings | None = None,
    sink: SignalSink | None = None,
) -> list[FusedCandidate]:
    """Embed the query, run both legs at ``candidate_k``, RRF-fuse, return the top ``top_k``.

    Fail-closed (ADR-011 §1): the ZDR+DPA+EU clearance gate runs FIRST — if unset this raises
    ``EmbedderNotReady`` before any provider call or text egress (zero provider calls). The
    gate is scoped to EGRESS (A2-P3): an injected provider that does not declare
    ``performs_no_egress is True`` is gated exactly as the real path is, so an uncleared
    process cannot embed through an undeclared provider it happens to hold; only an
    in-perimeter provider skips it. ``candidate_k`` / ``top_k`` / the RRF knobs
    default to the config surface (``RuntimeParameters``). Empty / whitespace query
    short-circuits to ``[]`` (no embed, no DB round-trip). Emits three §4-safe
    ``RETRIEVAL_LATENCY`` signals: ``leg="sparse"`` and ``leg="dense"`` from the legs, plus a
    ``leg="fused"`` whole-call timing here.
    """
    sink = sink if sink is not None else default_sink()
    settings = settings if settings is not None else get_settings()
    params = RuntimeParameters()
    candidate_k = candidate_k if candidate_k is not None else params.candidate_k
    top_k = top_k if top_k is not None else params.top_k

    if not community_id:
        raise ValueError("community_id is required")
    if not query_text.strip():
        return []

    # §4 gate, BEFORE any text is embedded or sent. The real path is gated then built; an
    # injected provider is gated unless it declares no egress (default: gated).
    if provider is None:
        _ensure_embedder_cleared(settings)
        provider = _build_provider(settings)
    elif not performs_no_egress(provider):
        _ensure_embedder_cleared(settings)

    started = time.perf_counter()
    query_vector: Sequence[float] = provider.embed_texts([query_text]).vectors[0]

    dense = dense_candidates(
        connection, community_id, query_vector, candidate_k, date_range=date_range, sink=sink
    )
    sparse = sparse_candidates(
        connection, community_id, query_text, candidate_k, date_range=date_range, sink=sink
    )
    fused = reciprocal_rank_fusion(
        dense=dense,
        sparse=sparse,
        k=params.rrf_k,
        dense_weight=params.rrf_dense_weight,
        sparse_weight=params.rrf_sparse_weight,
    )[:top_k]
    latency_ms = (time.perf_counter() - started) * 1000.0

    # §4: counts/timings only — no community_id, no chunk_text, no query_text.
    sink.emit(RetrievalLatency(leg="fused", candidate_count=len(fused), latency_ms=latency_ms))
    return fused
