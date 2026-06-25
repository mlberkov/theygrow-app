"""M4-P4 — grounded-ask seam: query_service contours + the mini-eval.

These tests prove the SEAM MECHANICS deterministically with INJECTED fakes: the contour
wiring (retrieve -> assemble -> grounding gate -> answers-provider -> parse/grade), the
fail-closed answers §4 gate (ADR-014: zero provider calls when uncleared), the closed-corpus
enforcement (fabricated citation rejected; present-but-irrelevant context honestly declared
no_evidence), the ADR-015 honesty-flag policy for grounded-but-uncertain answers, the
per-segment provenance mapping, and the GROUNDING_COVERAGE / DEGRADATION_EVENT emissions.

They do NOT establish real retrieval recall, Russian-FTS adequacy (the 'simple'-config
limitation, M4-DL-001), or whether a real LLM correctly self-declares no_evidence — that
recall/grounding-QUALITY mini-eval is the M4-CLOSE step against the actual corpus with cleared
REAL providers. Scope here is mechanics only.

DB-backed (real Postgres); skips with the rest of the suite when DATABASE_URL is unset.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from datetime import UTC, datetime

import pytest
from sqlalchemy import Connection, insert, text

from theygrow_api.adapters.answers.openai_client import AnswersProviderUnavailable
from theygrow_api.config import Settings
from theygrow_api.db.models import EMBEDDING_DIMENSION, SourceMessage
from theygrow_api.derivation import rederive
from theygrow_api.ports.provider import AnswerResponse, EmbeddingBatch
from theygrow_api.services.query_service import AnswersNotReady, answer_query
from theygrow_api.signals import Signal, SignalKind

_CREATED = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
_seq = 0


# --- fakes + helpers -------------------------------------------------------------------


class _FakeEmbed:
    """Injected embedding provider: records calls, returns a fixed query vector."""

    def __init__(self, vector: list[float]) -> None:
        self.calls: list[list[str]] = []
        self._vector = vector

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        self.calls.append(list(texts))
        return EmbeddingBatch(vectors=[self._vector for _ in texts], total_tokens=1)


class _FakeAnswers:
    """Injected answers provider: records calls, returns a configurable structured answer.

    ``cite`` controls grounding: 'all' cites every chunk_id rendered into the prompt (parsed
    from user_text — the port only sees strings, like a real provider would), 'fabricate'
    cites an id absent from the context (closed-corpus violation), 'none' cites nothing.
    """

    def __init__(
        self,
        *,
        uncertainty: str = "confident",
        cite: str = "all",
        answer_text: str = "grounded answer",
        raise_unavailable: bool = False,
    ) -> None:
        self.calls: list[tuple[str, str]] = []
        self._uncertainty = uncertainty
        self._cite = cite
        self._answer_text = answer_text
        self._raise = raise_unavailable

    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        self.calls.append((system_text, user_text))
        if self._raise:
            raise AnswersProviderUnavailable("simulated provider failure")
        ids = re.findall(r"chunk_id=(\S+) date=", user_text)
        if self._cite == "all":
            cited = ids
        elif self._cite == "fabricate":
            cited = ["bogus-not-in-context"]
        else:
            cited = []
        payload = {
            "answer_text": self._answer_text,
            "cited_chunk_ids": cited,
            "uncertainty": self._uncertainty,
        }
        return AnswerResponse(raw_text=json.dumps(payload), total_tokens=3)


class _RecordingSink:
    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


def _settings(*, embedder_cleared: bool = True, answers_cleared: bool = True) -> Settings:
    return Settings(
        database_url="postgresql://unused",
        embedder_base_url="http://embedder",
        embedder_api_key="k",
        embedder_privacy_cleared=embedder_cleared,
        answers_base_url="http://answers",
        answers_api_key="k",
        answers_privacy_cleared=answers_cleared,
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
        "source_message_id": f"q-smid-{_seq}",
        "community_id": "comm-1",
        "author_user_id": "author-1",
        "external_chat_id": f"q-chat-{_seq}",
        "external_user_id": "user-1",
        "external_message_id": f"q-msg-{_seq}",
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


def _seed_alpha(conn: Connection) -> None:
    """One retrievable note chunk 'alpha' with a ready embedding."""
    _insert_source(conn, raw_text="2026-03-15\nalpha")
    rederive(connection=conn)
    _set_ready_embedding(conn, chunk_text="alpha", vector=_unit_vec(1.0))


# --- contours --------------------------------------------------------------------------


def test_grounded_success_returns_answer_with_provenance(connection: Connection) -> None:
    _seed_alpha(connection)
    answers = _FakeAnswers(uncertainty="confident", cite="all")
    sink = _RecordingSink()

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=_FakeEmbed(_unit_vec(1.0)),
        answers_provider=answers,
        settings=_settings(),
        sink=sink,
    )

    assert result.answer_text == "grounded answer"
    assert result.degradation is None
    assert len(result.provenance) == 1
    assert result.provenance[0].chunk_id and result.provenance[0].note_id
    assert len(answers.calls) == 1
    cov = next(s for s in sink.signals if s.kind == SignalKind.GROUNDING_COVERAGE)
    assert cov.fields() == {"covered": 1, "total": 1}
    # A confident grounded answer is NOT a degradation.
    assert not any(s.kind == SignalKind.DEGRADATION_EVENT for s in sink.signals)


def test_answers_fail_closed_when_uncleared_zero_calls(connection: Connection) -> None:
    # M4-P4-INV-001 (ADR-014): the answers §4 gate runs FIRST — even with a provider in hand,
    # an uncleared process makes zero provider calls and never reaches retrieval/egress.
    _seed_alpha(connection)
    embed = _FakeEmbed(_unit_vec(1.0))
    answers = _FakeAnswers()

    with pytest.raises(AnswersNotReady):
        answer_query(
            connection,
            "comm-1",
            "alpha",
            embedding_provider=embed,
            answers_provider=answers,
            settings=_settings(answers_cleared=False),
        )

    assert answers.calls == []  # zero answers-provider calls (no context left the perimeter)
    assert embed.calls == []  # the gate is before retrieve, so the query was not even embedded


def test_no_context_degrades_with_zero_answers_calls(connection: Connection) -> None:
    # Empty corpus -> empty retrieval -> below the grounding bar (default min=1).
    embed = _FakeEmbed(_unit_vec(1.0))
    answers = _FakeAnswers()
    sink = _RecordingSink()

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=embed,
        answers_provider=answers,
        settings=_settings(),
        sink=sink,
    )

    assert result.answer_text is None
    assert result.degradation == "no_evidence"
    assert result.provenance == ()
    assert answers.calls == []  # honest degradation never calls the answers LLM
    assert any(s.kind == SignalKind.DEGRADATION_EVENT for s in sink.signals)


def test_present_but_irrelevant_context_llm_declares_no_evidence(connection: Connection) -> None:
    # Closed-corpus honesty under PRESENT-but-irrelevant context: >=1 segment is retrieved and
    # the provider IS consulted, but the model declares the chunks not evidence -> the answer is
    # suppressed. (Empty-retrieval alone does not exercise this path.)
    _seed_alpha(connection)
    answers = _FakeAnswers(uncertainty="no_evidence", cite="none")
    sink = _RecordingSink()

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=_FakeEmbed(_unit_vec(1.0)),
        answers_provider=answers,
        settings=_settings(),
        sink=sink,
    )

    assert len(answers.calls) == 1  # context was present, so the provider WAS consulted
    assert result.answer_text is None  # ...but the model declared it not evidence
    assert result.degradation == "no_evidence"
    assert result.provenance == ()
    cov = next(s for s in sink.signals if s.kind == SignalKind.GROUNDING_COVERAGE)
    assert cov.fields() == {"covered": 0, "total": 1}
    assert any(s.kind == SignalKind.DEGRADATION_EVENT for s in sink.signals)


def test_fabricated_citation_is_parse_failure(connection: Connection) -> None:
    # The model cites a chunk_id absent from the context (a closed-corpus violation) -> the
    # answer is rejected and suppressed, never surfaced.
    _seed_alpha(connection)
    answers = _FakeAnswers(uncertainty="confident", cite="fabricate")

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=_FakeEmbed(_unit_vec(1.0)),
        answers_provider=answers,
        settings=_settings(),
    )

    assert result.answer_text is None
    assert result.degradation == "parse_failure"


def test_provider_unavailable_degrades(connection: Connection) -> None:
    _seed_alpha(connection)
    answers = _FakeAnswers(raise_unavailable=True)

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=_FakeEmbed(_unit_vec(1.0)),
        answers_provider=answers,
        settings=_settings(),
    )

    assert result.answer_text is None
    assert result.degradation == "provider_unavailable"


def test_uncertain_but_grounded_returns_with_honesty_flag(connection: Connection) -> None:
    # ADR-015: a grounded-but-uncertain answer is RETURNED WITH an honesty flag — it is still
    # synthesized only from cited retrieved family context (never parametric).
    _seed_alpha(connection)
    answers = _FakeAnswers(uncertainty="uncertain", cite="all")

    result = answer_query(
        connection,
        "comm-1",
        "alpha",
        embedding_provider=_FakeEmbed(_unit_vec(1.0)),
        answers_provider=answers,
        settings=_settings(),
    )

    assert result.answer_text == "grounded answer"
    assert result.degradation == "weak_evidence"
    assert len(result.provenance) == 1


def test_empty_query_degrades_without_any_calls(connection: Connection) -> None:
    embed = _FakeEmbed(_unit_vec(1.0))
    answers = _FakeAnswers()
    sink = _RecordingSink()

    result = answer_query(
        connection,
        "comm-1",
        "   ",
        embedding_provider=embed,
        answers_provider=answers,
        settings=_settings(),
        sink=sink,
    )

    assert result.answer_text is None
    assert result.degradation == "no_evidence"
    assert embed.calls == [] and answers.calls == []
    assert any(s.kind == SignalKind.DEGRADATION_EVENT for s in sink.signals)


def test_missing_community_id_raises(connection: Connection) -> None:
    with pytest.raises(ValueError, match="community_id is required"):
        answer_query(
            connection,
            "",
            "alpha",
            embedding_provider=_FakeEmbed(_unit_vec(1.0)),
            answers_provider=_FakeAnswers(),
            settings=_settings(),
        )
