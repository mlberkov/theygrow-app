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
    DegradationEvent,
    DerivationCounters,
    EmbeddingCounters,
    EvalScorecard,
    GroundingCoverage,
    LoggingSignalSink,
    ReadinessProbe,
    RetrievalLatency,
    SignalKind,
    default_sink,
)

#: §4-forbidden keys that must never appear in a signal payload.
_FORBIDDEN = {"raw_text", "chunk_text", "community_id", "author_user_id"}

#: Bounded enum-style label keys (counts/ids class, §4-safe) whose values are short labels
#: rather than numeric counts/timings — e.g. the retrieval ``leg`` discriminator, the
#: degradation ``mode`` label (M4-P4), the eval ``case_class`` label (A2-P3) and the readiness
#: ``outcome`` / ``failure_class`` labels (A3-P2).
_LABEL_KEYS = {"leg", "mode", "case_class", "outcome", "failure_class"}


def test_taxonomy_defines_every_kind() -> None:
    assert set(SIGNAL_TAXONOMY) == set(SignalKind)
    for kind, desc in SIGNAL_TAXONOMY.items():
        assert desc.kind == kind
        # M4 packet ids for the engine spine; milestone-qualified for non-spine tracks,
        # which do not share M4's packet numbering (A2-P3 is the eval pipeline, A3-P2 the
        # deployed readiness probe).
        assert desc.producing_stage in {"P1", "P2", "P3", "P4", "A2-P3", "A3-P2"}


def test_all_kinds_are_emitted_now_as_of_p4() -> None:
    # As of M4-P4 every declared kind has a live producer (the two P4 kinds — GROUNDING_COVERAGE
    # and DEGRADATION_EVENT — were activated when query_service landed); A2-P3 added
    # EVAL_SCORECARD and A3-P2 added READINESS_PROBE, each with its emitter in the same packet.
    # INV-003 (test_signal_emitters) is the producer-coupling guarantee; here we just pin the
    # taxonomy.
    for kind, desc in SIGNAL_TAXONOMY.items():
        assert desc.emitted_now is True, f"{kind} should be emitted as of A3-P2"
    assert SIGNAL_TAXONOMY[SignalKind.GROUNDING_COVERAGE].producing_stage == "P4"
    assert SIGNAL_TAXONOMY[SignalKind.DEGRADATION_EVENT].producing_stage == "P4"
    assert SIGNAL_TAXONOMY[SignalKind.EMBEDDING_COUNTERS].producing_stage == "P2"
    assert SIGNAL_TAXONOMY[SignalKind.EVAL_SCORECARD].producing_stage == "A2-P3"
    assert SIGNAL_TAXONOMY[SignalKind.READINESS_PROBE].producing_stage == "A3-P2"


def test_signal_payloads_are_safe_counts_and_timings() -> None:
    for sig in (
        DerivationCounters(
            sources_processed=1,
            derived_dated=1,
            derived_fallback=0,
            chunks=2,
            skipped_empty=0,
        ),
        RetrievalLatency(leg="sparse", candidate_count=3, latency_ms=1.5),
        EmbeddingCounters(
            attempted=2,
            embedded=2,
            failed=0,
            skipped_ready=0,
            total_tokens=11,
            duration_ms=3.0,
        ),
        GroundingCoverage(covered=1, total=3),
        DegradationEvent(mode="no_evidence"),
        EvalScorecard(
            case_class="lexical-hit",
            cases=4,
            passed=4,
            failed=0,
            holdout_cases=1,
            holdout_passed=1,
            scope_violations=0,
            route_violations=0,
            duration_ms=12.5,
        ),
        ReadinessProbe(outcome="unavailable", failure_class="connect_failed", latency_ms=4.0),
    ):
        payload = sig.fields()
        assert not (_FORBIDDEN & set(payload)), "signal payload must carry no §4 fields"
        # Non-label fields are numeric counts/timings; label fields (e.g. leg) are short str.
        for key, value in payload.items():
            if key in _LABEL_KEYS:
                assert isinstance(value, str)
            else:
                assert isinstance(value, int | float)
        # The payload keys match the taxonomy descriptor for this kind.
        assert set(payload) == set(SIGNAL_TAXONOMY[sig.kind].field_names)


def test_retrieval_latency_leg_label_is_distinguishing_and_safe() -> None:
    # The leg discriminator (M4-DL-004) distinguishes the three P3 emissions through one
    # kind; it is a bounded label, NOT a §4-forbidden identifier.
    assert "leg" not in _FORBIDDEN
    for leg in ("sparse", "dense", "fused"):
        payload = RetrievalLatency(leg=leg, candidate_count=1, latency_ms=0.5).fields()
        assert payload["leg"] == leg
        assert set(payload) == set(SIGNAL_TAXONOMY[SignalKind.RETRIEVAL_LATENCY].field_names)


def test_logging_sink_emits_through_logging_boundary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="theygrow_api.signals"):
        default_sink().emit(RetrievalLatency(leg="sparse", candidate_count=3, latency_ms=2.0))
    records = [r for r in caplog.records if r.getMessage() == "retrieval.latency"]
    assert len(records) == 1
    # The signal's count field rode through as a structured record attribute (extra=).
    assert records[0].__dict__["candidate_count"] == 3
    assert isinstance(default_sink(), LoggingSignalSink)
