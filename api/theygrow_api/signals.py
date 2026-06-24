"""M4-P1 — signal taxonomy + emission seam.

A typed registry of structured operational signals, emitted through ONE seam from the
birth of retrieval. The taxonomy is defined NOW (so downstream producers slot into a known
shape); each kind is emitted only when its producing code exists — no fabricated emitters.

§4 (AGENTS.md): signal payloads carry COUNTS / IDS / TIMINGS only — never ``raw_text``,
``chunk_text``, or family-identifying ids (``community_id``). The default sink emits through
the PII-guarded logging boundary (``logging.py``).

Taxonomy:
  * ``DERIVATION_COUNTERS`` — P1, emitted: notes/event_chunks re-derivation counts.
  * ``RETRIEVAL_LATENCY``   — P1/P3, emitted: per-leg (sparse/dense/fused) candidate
    count + query latency, distinguished by a §4-safe ``leg`` label.
  * ``EMBEDDING_COUNTERS``  — P2, emitted: embeddings backfill counts + token cost + timing.
  * ``GROUNDING_COVERAGE``  — P4, emitted: cited vs offered segment counts per answer.
  * ``DEGRADATION_EVENT``   — P4, emitted: honest-degradation events (a §4-safe mode label).

P2/P3/P4 signals MUST emit through this SAME seam (M4-DL-002). The seam is an injectable
``SignalSink`` so tests capture emissions and a future metrics backend swaps in without
touching producers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)


class SignalKind(StrEnum):
    """The full structured-signal taxonomy (defined now; emitted as code lands)."""

    DERIVATION_COUNTERS = "derivation.counters"
    RETRIEVAL_LATENCY = "retrieval.latency"
    EMBEDDING_COUNTERS = "embedding.counters"
    GROUNDING_COVERAGE = "grounding.coverage"
    DEGRADATION_EVENT = "degradation.event"


@dataclass(frozen=True)
class SignalDescriptor:
    """Taxonomy entry: a kind's payload shape + where/whether it is produced."""

    kind: SignalKind
    field_names: tuple[str, ...]
    producing_stage: str  # "P1" | "P2" | "P3" | "P4"
    emitted_now: bool
    note: str


SIGNAL_TAXONOMY: dict[SignalKind, SignalDescriptor] = {
    SignalKind.DERIVATION_COUNTERS: SignalDescriptor(
        kind=SignalKind.DERIVATION_COUNTERS,
        field_names=(
            "sources_processed",
            "derived_dated",
            "derived_fallback",
            "chunks",
            "skipped_empty",
        ),
        producing_stage="P1",
        emitted_now=True,
        note="Offline re-derivation counts (counts-only summary).",
    ),
    SignalKind.RETRIEVAL_LATENCY: SignalDescriptor(
        kind=SignalKind.RETRIEVAL_LATENCY,
        field_names=("leg", "candidate_count", "latency_ms"),
        producing_stage="P1",
        emitted_now=True,
        note=(
            "Retrieval leg latency: a §4-safe leg label ('sparse'|'dense'|'fused') + "
            "candidate count + query latency (co-emitted). P1 sparse leg; P3 adds dense + "
            "fused emissions through the same kind."
        ),
    ),
    SignalKind.EMBEDDING_COUNTERS: SignalDescriptor(
        kind=SignalKind.EMBEDDING_COUNTERS,
        field_names=(
            "attempted",
            "embedded",
            "failed",
            "skipped_ready",
            "total_tokens",
            "duration_ms",
        ),
        producing_stage="P2",
        emitted_now=True,
        note="Embeddings backfill: per-run counts + token cost + wall-clock (counts/timings only).",
    ),
    SignalKind.GROUNDING_COVERAGE: SignalDescriptor(
        kind=SignalKind.GROUNDING_COVERAGE,
        field_names=("covered", "total"),
        producing_stage="P4",
        emitted_now=True,
        note=(
            "Grounded-ask coverage (M4-P4): cited segment count vs offered segment count for "
            "one answered query (counts only). Emitted by services.query_service.answer_query."
        ),
    ),
    SignalKind.DEGRADATION_EVENT: SignalDescriptor(
        kind=SignalKind.DEGRADATION_EVENT,
        field_names=("mode",),
        producing_stage="P4",
        emitted_now=True,
        note=(
            "Honest-degradation event (M4-P4): a §4-safe bounded mode label ('no_evidence' | "
            "'provider_unavailable' | 'parse_failure' | 'weak_evidence' | 'ambiguous'). "
            "Emitted by services.query_service.answer_query on each degraded contour."
        ),
    ),
}


@runtime_checkable
class Signal(Protocol):
    """A structured signal: a ``kind`` plus a §4-safe counts/ids/timings payload.

    ``kind`` is a read-only member so frozen-dataclass signals satisfy the protocol.
    """

    @property
    def kind(self) -> SignalKind: ...

    def fields(self) -> dict[str, object]:
        """The payload — counts / ids / timings ONLY (no raw_text/chunk_text)."""
        ...


@dataclass(frozen=True)
class DerivationCounters:
    """P1 signal: offline re-derivation counts (mirrors ``DeriveSummary``)."""

    sources_processed: int
    derived_dated: int
    derived_fallback: int
    chunks: int
    skipped_empty: int
    kind: SignalKind = SignalKind.DERIVATION_COUNTERS

    def fields(self) -> dict[str, object]:
        return {
            "sources_processed": self.sources_processed,
            "derived_dated": self.derived_dated,
            "derived_fallback": self.derived_fallback,
            "chunks": self.chunks,
            "skipped_empty": self.skipped_empty,
        }


@dataclass(frozen=True)
class RetrievalLatency:
    """Retrieval-leg signal: a §4-safe leg label + candidate count + query latency.

    ``leg`` is a bounded label (``"sparse"`` | ``"dense"`` | ``"fused"``) — counts/ids
    class, never family-identifying — so the three P3 emissions are distinguishable
    through one kind (M4-DL-004; reuse/extend, not duplicate). It is REQUIRED (no default):
    every emission is labelled, never unlabelled.
    """

    leg: str
    candidate_count: int
    latency_ms: float
    kind: SignalKind = SignalKind.RETRIEVAL_LATENCY

    def fields(self) -> dict[str, object]:
        return {
            "leg": self.leg,
            "candidate_count": self.candidate_count,
            "latency_ms": self.latency_ms,
        }


@dataclass(frozen=True)
class EmbeddingCounters:
    """P2 signal: embeddings-backfill counts + token cost + wall-clock.

    §4-safe: ``total_tokens`` is the embedder usage tally (a count), never the text.
    ``attempted`` = pending/failed rows selected this run; ``skipped_ready`` = rows
    already ``ready`` and left untouched (the idempotent no-op tally).
    """

    attempted: int
    embedded: int
    failed: int
    skipped_ready: int
    total_tokens: int
    duration_ms: float
    kind: SignalKind = SignalKind.EMBEDDING_COUNTERS

    def fields(self) -> dict[str, object]:
        return {
            "attempted": self.attempted,
            "embedded": self.embedded,
            "failed": self.failed,
            "skipped_ready": self.skipped_ready,
            "total_tokens": self.total_tokens,
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True)
class GroundingCoverage:
    """P4 signal: grounded-ask coverage — cited vs offered segment counts (counts only).

    §4-safe: ``covered`` = segments the answer actually cited (validated against the
    assembled context); ``total`` = segments offered to the model. Never carries text or
    family-identifying ids.
    """

    covered: int
    total: int
    kind: SignalKind = SignalKind.GROUNDING_COVERAGE

    def fields(self) -> dict[str, object]:
        return {"covered": self.covered, "total": self.total}


@dataclass(frozen=True)
class DegradationEvent:
    """P4 signal: an honest-degradation event carrying a §4-safe bounded ``mode`` label.

    ``mode`` is one of a bounded set ('no_evidence' | 'provider_unavailable' |
    'parse_failure' | 'weak_evidence' | 'ambiguous') — a label in the counts/ids class,
    like ``RetrievalLatency.leg``, never family-identifying.
    """

    mode: str
    kind: SignalKind = SignalKind.DEGRADATION_EVENT

    def fields(self) -> dict[str, object]:
        return {"mode": self.mode}


@runtime_checkable
class SignalSink(Protocol):
    """The single emission seam. Implementations route a typed ``Signal`` somewhere."""

    def emit(self, signal: Signal) -> None: ...


class LoggingSignalSink:
    """Default sink: emit each signal through the PII-guarded logging boundary.

    §4: only the signal's counts/ids/timings reach the record (``extra=fields()``), and
    ``install_pii_redaction`` (``logging.py``) guards the boundary. Payloads carry no
    ``raw_text`` / ``chunk_text`` / ``community_id`` by construction.
    """

    def emit(self, signal: Signal) -> None:
        logger.info(signal.kind.value, extra=signal.fields())


_DEFAULT_SINK: SignalSink = LoggingSignalSink()


def default_sink() -> SignalSink:
    """The process-default emission seam (the PII-guarded logging sink)."""
    return _DEFAULT_SINK
