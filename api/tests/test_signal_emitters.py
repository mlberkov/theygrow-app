"""M4-P3 — operability invariant: emitted_now kinds are wired to real producers.

M4-P3-INV-003 (operability, ADR-013): the set of ``SignalKind`` declared
``emitted_now=True`` in the taxonomy equals the set actually emitted when the known
producers run. This is the EXPLICIT-COUPLING form: the test drives each producer
(``rederive`` -> DERIVATION_COUNTERS, the sparse leg -> RETRIEVAL_LATENCY, the embeddings
backfill -> EMBEDDING_COUNTERS, ``evals.scorecard.emit_scorecard`` -> EVAL_SCORECARD) with a
recording sink and compares.

Consequences this enforces:
  * Flipping a defined-not-emitted kind to ``emitted_now=True`` WITHOUT a producer emitting it
    fails here (expected grows, emitted does not). As of M4-P4 the two P4 kinds
    (GROUNDING_COVERAGE / DEGRADATION_EVENT) are emitted by ``query_service.answer_query`` —
    the present-but-irrelevant contour (the model declares retrieved chunks not evidence)
    emits BOTH in one call (coverage counts + a degradation event).
  * Adding a new emitted producer means adding its driver to this test — the coupling is
    explicit by design, not a fragile reflective scan. A2-P3's EVAL_SCORECARD is driven from
    a hand-built ``Scorecard``: its emitter is a pure function over an already-computed
    scorecard precisely so this test never needs a seeded 295-chunk contour to cover it.
DB-backed (the producers need a real Postgres); skips with the rest of the suite when
``DATABASE_URL`` is unset.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import Connection, insert

from theygrow_api.config import Settings
from theygrow_api.db.models import EMBEDDING_DIMENSION, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.embeddings_backfill import embed_backfill
from theygrow_api.evals.scorecard import CaseResult, emit_scorecard, summarize
from theygrow_api.ports.provider import AnswerResponse, EmbeddingBatch
from theygrow_api.retrieval.search_repository import sparse_candidates
from theygrow_api.services.query_service import answer_query
from theygrow_api.signals import SIGNAL_TAXONOMY, Signal

_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


class _RecordingSink:
    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


class _FakeProvider:
    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        return EmbeddingBatch(vectors=[[0.1] * EMBEDDING_DIMENSION for _ in texts], total_tokens=1)


class _FakeAnswers:
    """Answers provider that declares the retrieved chunks not-evidence (one call emits both
    GROUNDING_COVERAGE and a no_evidence DEGRADATION_EVENT)."""

    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        payload = {"answer_text": "", "cited_chunk_ids": [], "uncertainty": "no_evidence"}
        return AnswerResponse(raw_text=json.dumps(payload), total_tokens=1)


def _cleared_settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        embedder_base_url="http://embedder",
        embedder_api_key="k",
        embedder_privacy_cleared=True,
        answers_base_url="http://answers",
        answers_api_key="k",
        answers_privacy_cleared=True,
    )


def test_every_emitted_now_kind_has_a_wired_producer(connection: Connection) -> None:
    connection.execute(
        insert(SourceMessage),
        {
            "source_message_id": "se-smid-1",
            "community_id": "comm-1",
            "author_user_id": "author-1",
            "external_chat_id": "se-chat-1",
            "external_user_id": "user-1",
            "external_message_id": "se-msg-1",
            "edit_seq": 0,
            "raw_text": "2026-03-15\nfever spiked",
            "detected_route": "note",
            "created_at": _CREATED,
            "valid_at": _CREATED,
        },
    )
    sink = _RecordingSink()

    # Drive every emitted_now producer through the one sink.
    rederive(connection=connection, sink=sink)  # DERIVATION_COUNTERS
    sparse_candidates(connection, "comm-1", "fever", limit=10, sink=sink)  # RETRIEVAL_LATENCY
    embed_backfill(  # EMBEDDING_COUNTERS (also makes the chunk's embedding 'ready')
        connection=connection, provider=_FakeProvider(), settings=_cleared_settings(), sink=sink
    )
    # GROUNDING_COVERAGE + DEGRADATION_EVENT: a present-but-irrelevant contour (>=1 segment
    # retrieved, model declares no_evidence) emits both kinds in one grounded-ask call.
    answer_query(
        connection,
        "comm-1",
        "fever",
        embedding_provider=_FakeProvider(),
        answers_provider=_FakeAnswers(),
        settings=_cleared_settings(),
        sink=sink,
    )
    # EVAL_SCORECARD: the A2-P3 emitter is a pure function over a computed scorecard, so it
    # is driven here without seeding a contour (see the module docstring).
    emit_scorecard(
        summarize(
            (CaseResult(case_id="lex-001", case_class="lexical-hit", holdout=False, passed=True),),
            durations_ms={"lexical-hit": 1.0},
            total_duration_ms=1.0,
            corpus_chunks=1,
            corpus_communities=1,
            mode="ci",
        ),
        sink,
    )

    emitted = {s.kind for s in sink.signals}
    expected = {kind for kind, desc in SIGNAL_TAXONOMY.items() if desc.emitted_now}
    assert emitted == expected, (
        "emitted_now taxonomy must match what producers actually emit; "
        f"declared-but-unemitted={expected - emitted}, emitted-but-undeclared={emitted - expected}"
    )


def test_no_defined_not_emitted_kinds_remain_as_of_p4() -> None:
    # M4-P4 activated the last two deferred kinds; the defined-not-emitted set is now empty.
    # A future deferred-then-activated kind re-enters via the coupling test above.
    not_emitted = {kind for kind, desc in SIGNAL_TAXONOMY.items() if not desc.emitted_now}
    assert not_emitted == set()
