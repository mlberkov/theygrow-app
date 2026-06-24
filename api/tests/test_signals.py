"""M4-P1 delta — signal taxonomy + emission seam.

Unit coverage: the taxonomy defines every kind; downstream kinds are defined-not-emitted;
signal payloads are §4-safe (counts/timings only — no raw_text/chunk_text/community_id);
the default sink emits through the logging boundary.
"""

from __future__ import annotations

import logging

import pytest

from theygrow_api.signals import (
    SIGNAL_TAXONOMY,
    DerivationCounters,
    EmbeddingCounters,
    LoggingSignalSink,
    RetrievalLatency,
    SignalKind,
    default_sink,
)

#: §4-forbidden keys that must never appear in a signal payload.
_FORBIDDEN = {"raw_text", "chunk_text", "community_id", "author_user_id"}


def test_taxonomy_defines_every_kind() -> None:
    assert set(SIGNAL_TAXONOMY) == set(SignalKind)
    for kind, desc in SIGNAL_TAXONOMY.items():
        assert desc.kind == kind
        assert desc.producing_stage in {"P1", "P2", "P3", "P4"}


def test_downstream_kinds_defined_but_not_emitted_in_p1() -> None:
    assert SIGNAL_TAXONOMY[SignalKind.GROUNDING_COVERAGE].emitted_now is False
    assert SIGNAL_TAXONOMY[SignalKind.DEGRADATION_EVENT].emitted_now is False
    # The P1 producers and the P2 embeddings backfill are emitted now.
    assert SIGNAL_TAXONOMY[SignalKind.DERIVATION_COUNTERS].emitted_now is True
    assert SIGNAL_TAXONOMY[SignalKind.RETRIEVAL_LATENCY].emitted_now is True
    assert SIGNAL_TAXONOMY[SignalKind.EMBEDDING_COUNTERS].emitted_now is True
    assert SIGNAL_TAXONOMY[SignalKind.EMBEDDING_COUNTERS].producing_stage == "P2"


def test_signal_payloads_are_safe_counts_and_timings() -> None:
    for sig in (
        DerivationCounters(
            sources_processed=1,
            derived_dated=1,
            derived_fallback=0,
            chunks=2,
            skipped_empty=0,
        ),
        RetrievalLatency(candidate_count=3, latency_ms=1.5),
        EmbeddingCounters(
            attempted=2,
            embedded=2,
            failed=0,
            skipped_ready=0,
            total_tokens=11,
            duration_ms=3.0,
        ),
    ):
        payload = sig.fields()
        assert not (_FORBIDDEN & set(payload)), "signal payload must carry no §4 fields"
        assert all(isinstance(v, int | float) for v in payload.values())
        # The payload keys match the taxonomy descriptor for this kind.
        assert set(payload) == set(SIGNAL_TAXONOMY[sig.kind].field_names)


def test_logging_sink_emits_through_logging_boundary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="theygrow_api.signals"):
        default_sink().emit(RetrievalLatency(candidate_count=3, latency_ms=2.0))
    records = [r for r in caplog.records if r.getMessage() == "retrieval.latency"]
    assert len(records) == 1
    # The signal's count field rode through as a structured record attribute (extra=).
    assert records[0].__dict__["candidate_count"] == 3
    assert isinstance(default_sink(), LoggingSignalSink)
