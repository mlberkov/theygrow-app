"""M4-P1 — signal taxonomy + emission seam.

A typed registry of structured operational signals, emitted through ONE seam from the
birth of retrieval. The taxonomy is defined NOW (so downstream producers slot into a known
shape); each kind is emitted only when its producing code exists — no fabricated emitters.

§4 (AGENTS.md): signal payloads carry COUNTS / IDS / TIMINGS only — never ``raw_text``,
``chunk_text``, or family-identifying ids (``community_id``). The default sink emits through
the PII-guarded logging boundary (``logging.py``).

Taxonomy:
  * ``DERIVATION_COUNTERS`` — P1, emitted: notes/event_chunks re-derivation counts.
  * ``RETRIEVAL_LATENCY``   — P1, emitted: sparse leg candidate count + query latency.
  * ``GROUNDING_COVERAGE``  — P4, defined-not-emitted (grounded-ask assembly).
  * ``DEGRADATION_EVENT``   — P3/P4, defined-not-emitted (honest-degradation events).

P2/P3 signals MUST emit through this SAME seam (M4-DL-002). The seam is an injectable
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
    GROUNDING_COVERAGE = "grounding.coverage"
    DEGRADATION_EVENT = "degradation.event"


@dataclass(frozen=True)
class SignalDescriptor:
    """Taxonomy entry: a kind's payload shape + where/whether it is produced."""

    kind: SignalKind
    field_names: tuple[str, ...]
    producing_stage: str  # "P1" | "P3" | "P4"
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
        field_names=("candidate_count", "latency_ms"),
        producing_stage="P1",
        emitted_now=True,
        note="Sparse FTS leg: candidate count + query latency (co-emitted).",
    ),
    SignalKind.GROUNDING_COVERAGE: SignalDescriptor(
        kind=SignalKind.GROUNDING_COVERAGE,
        field_names=("covered", "total"),
        producing_stage="P4",
        emitted_now=False,
        note="Grounded-ask coverage; emitted when context_assembler/query_service land (P4).",
    ),
    SignalKind.DEGRADATION_EVENT: SignalDescriptor(
        kind=SignalKind.DEGRADATION_EVENT,
        field_names=("mode",),
        producing_stage="P3",
        emitted_now=False,
        note="Honest-degradation event; emitted when retrieval/assembly fallbacks land (P3/P4).",
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
    """P1 signal: sparse leg candidate count + query latency (co-emitted)."""

    candidate_count: int
    latency_ms: float
    kind: SignalKind = SignalKind.RETRIEVAL_LATENCY

    def fields(self) -> dict[str, object]:
        return {"candidate_count": self.candidate_count, "latency_ms": self.latency_ms}


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
