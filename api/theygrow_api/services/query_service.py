"""M4-P4 — grounded-ask orchestrator (the callable seam that makes M4 demoable end-to-end).

Lifts the engine's channel-neutral query service (``memory_rag.services.query_service``;
ADR-005 §7: transfer, not rewrite — the donor is out of perimeter, transferred not imported),
MINUS persistence: theygrow has no ``Query`` / ``AnswerTrace`` / ``RetrievalHit`` tables — this
is a library seam, not a webhook, and writes nothing (no migration this packet).

:func:`answer_query` orchestrates one grounded ask: ``retrieve()`` (P3 fused dense+sparse+RRF,
note-only by construction) -> :func:`assemble_context` -> the grounding gate -> the
answers-provider -> parse + grade -> a :class:`GroundedAnswer` carrying the answer text,
per-segment family-observation provenance, and an honest degradation mode.

Closed corpus, honest degradation (ADR-015): the answer is synthesized ONLY from retrieved
family episodic memory — NEVER a parametric/model or web fallback. This is enforced
structurally on three independent edges:
  * the prompt carries only the retrieved ``chunk_text`` (no outside knowledge invited);
  * :func:`parse_structured_answer` rejects any fabricated citation (the model may only ground
    on retrieved chunk_ids);
  * the PRE-provider grounding gate refuses below ``grounding_min_segments`` — returning an
    honest "no verified information" result with ZERO provider calls.

§4 / second egress (ADR-014, per-egress clearance): the assembled family context is sent to
the chat/answers LLM — a distinct third-party residency surface from the embedder. The answers
clearance flag (``answers_privacy_cleared``) is checked FIRST, before any egress: an uncleared
process raises ``AnswersNotReady`` and makes ZERO answers-provider calls. Logs/signals carry
counts + a bounded mode label only — never text or family-identifying ids.

Since A2-P3 (``L2-DL-003``) that check is scoped to EGRESS, mirroring what A2-P2 did for the
embedder: it is asked of the real provider path and of any injected provider that does not
structurally declare ``performs_no_egress is True``, and is skipped only for an in-perimeter
answers provider, which removes the third-party surface instead of crossing it. The
declaration check is fail-closed — absent or non-``True`` reads as egressing.

**The narrowing grants no clearance.** It changes WHO must be cleared, never WHETHER:
``answers_privacy_cleared`` remains unset and default-false, the real-provider path stays
fail-closed exactly as before, and owner clearance for the answers residency surface (ZDR +
DPA + EU) remains an OPEN PREREQUISITE ahead of the chat milestone's go-live. Nothing in this
module, and nothing downstream of it, may read the in-perimeter exemption as that clearance
having been obtained.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import Connection

from theygrow_api.adapters.answers.openai_client import AnswersProviderUnavailable
from theygrow_api.config import Settings, get_settings
from theygrow_api.parameters import RuntimeParameters
from theygrow_api.ports.provider import AnswersProvider, EmbeddingProvider, performs_no_egress
from theygrow_api.retrieval.search_repository import DateRange
from theygrow_api.services.context_assembler import (
    AssembledContext,
    StructuredAnswer,
    StructuredAnswerError,
    UncertaintyMarker,
    assemble_context,
    build_answer_prompt,
    parse_structured_answer,
)
from theygrow_api.services.retrieval import retrieve
from theygrow_api.signals import DegradationEvent, GroundingCoverage, SignalSink, default_sink

__all__ = [
    "AnswersNotReady",
    "GroundedAnswer",
    "SegmentProvenance",
    "answer_query",
]

#: §4-safe bounded degradation mode labels (mirrors the DEGRADATION_EVENT taxonomy note).
_MODE_NO_EVIDENCE = "no_evidence"
_MODE_PROVIDER_UNAVAILABLE = "provider_unavailable"
_MODE_PARSE_FAILURE = "parse_failure"
_MODE_WEAK_EVIDENCE = "weak_evidence"
_MODE_AMBIGUOUS = "ambiguous"

#: How an LLM-declared uncertainty marker (confident/uncertain/no_evidence/ambiguous) maps to
#: this packet's contract (ADR-015): confident -> a clean grounded answer (no degradation);
#: uncertain/ambiguous -> the answer is RETURNED WITH an honesty flag (it is still grounded in
#: cited retrieved family context, never parametric); LLM-declared no_evidence -> the model
#: says the retrieved chunks are not evidence, so the answer text is SUPPRESSED.
_MARKER_TO_MODE: dict[UncertaintyMarker, str | None] = {
    "confident": None,
    "uncertain": _MODE_WEAK_EVIDENCE,
    "ambiguous": _MODE_AMBIGUOUS,
    "no_evidence": _MODE_NO_EVIDENCE,
}


class AnswersNotReady(RuntimeError):
    """Fail-closed: the §4 answers-clearance / provider-config precondition is unmet (ADR-014).

    Raised BEFORE any context text is sent or any provider call made, so an uncleared or
    misconfigured process is a loud no-op rather than a silent leak.
    """


@dataclass(frozen=True)
class SegmentProvenance:
    """Per-segment family-observation provenance for one cited grounded chunk.

    Family episodic memory is the ONLY grounded source at M4 (canon/KB is M5, out of
    perimeter), so provenance is family-observation lineage only — no canon source.
    """

    chunk_id: str
    note_id: str
    source_message_id: str
    note_date: date
    event_index: int


@dataclass(frozen=True)
class GroundedAnswer:
    """The result of one grounded ask.

    ``answer_text`` is non-``None`` ONLY when synthesized from retrieved + cited family
    context (closed corpus). ``degradation`` is ``None`` for a clean confident answer, else a
    bounded mode label. ``provenance`` lists the cited grounded segments (empty when the answer
    is suppressed).
    """

    answer_text: str | None
    degradation: str | None
    provenance: tuple[SegmentProvenance, ...]
    query_text: str


def _ensure_answers_cleared(settings: Settings) -> None:
    """§4 gate (ADR-014): refuse unless the operator affirmed the answers clearance flag.

    Asked of every path that actually crosses the answers residency boundary. An
    in-perimeter provider does not reach here — not because it is cleared, but because it
    crosses nothing (see the module docstring: the narrowing grants no clearance).
    """
    if not settings.answers_privacy_cleared:
        raise AnswersNotReady(
            "answers_privacy_cleared is not set; refusing to send family context to the "
            "answers LLM (ADR-014 per-egress ZDR+DPA+EU gate). Nothing sent, nothing synthesized."
        )


def _build_answers_provider(settings: Settings) -> AnswersProvider:
    """Construct the donor OpenAI answers adapter; enforce endpoint/key presence (real path)."""
    base_url = settings.answers_base_url
    api_key = settings.answers_api_key
    if not base_url or not api_key:
        raise AnswersNotReady(
            "answers endpoint/key missing; cannot reach the residency-bound answers LLM."
        )
    # Lazy import so the OpenAI SDK is pulled in only on the live answer path.
    from theygrow_api.adapters.answers.openai_client import OpenAIAnswersProvider

    return OpenAIAnswersProvider(
        api_key=api_key,
        base_url=base_url,
        model=RuntimeParameters().answers_model,
    )


def _provenance_for(
    structured: StructuredAnswer, context: AssembledContext
) -> tuple[SegmentProvenance, ...]:
    """Map the validated cited chunk_ids back to per-segment provenance, in citation order."""
    by_id = {c.chunk_id: c for c in context.ordered}
    return tuple(
        SegmentProvenance(
            chunk_id=c.chunk_id,
            note_id=c.note_id,
            source_message_id=c.source_message_id,
            note_date=c.note_date,
            event_index=c.event_index,
        )
        for cid in structured.cited_chunk_ids
        if (c := by_id.get(cid)) is not None
    )


def _degrade(query_text: str, mode: str, sink: SignalSink) -> GroundedAnswer:
    """Emit the DEGRADATION_EVENT and return an honest "no verified information" result."""
    sink.emit(DegradationEvent(mode=mode))
    return GroundedAnswer(answer_text=None, degradation=mode, provenance=(), query_text=query_text)


def answer_query(
    connection: Connection,
    community_id: str,
    query_text: str,
    *,
    embedding_provider: EmbeddingProvider | None = None,
    answers_provider: AnswersProvider | None = None,
    settings: Settings | None = None,
    sink: SignalSink | None = None,
    candidate_k: int | None = None,
    top_k: int | None = None,
    date_range: DateRange | None = None,
) -> GroundedAnswer:
    """Answer ``query_text`` grounded ONLY in retrieved family episodic memory.

    Contour order (closed corpus, honest degradation):
      1. validate ``community_id``; empty/whitespace query -> honest ``no_evidence`` (no calls).
      2. ``_ensure_answers_cleared`` -> the §4 answers gate FIRST (fail-closed before any
         egress), skipped only for an injected provider declaring zero egress (A2-P3).
      3. ``retrieve()`` (its own embedder gate runs inside) -> fused note-only candidates.
      4. ``assemble_context`` -> the grounded context.
      5. grounding gate: below ``grounding_min_segments`` -> honest ``no_evidence``, ZERO
         answers-provider calls (no client built).
      6. build the provider, render the prompt, call the answers LLM.
      7. parse + citation-ground (fabricated citation -> ``parse_failure``); grade the
         uncertainty marker (ADR-015) and emit GROUNDING_COVERAGE + any DEGRADATION_EVENT.
    """
    sink = sink if sink is not None else default_sink()
    settings = settings if settings is not None else get_settings()
    params = RuntimeParameters()

    if not community_id:
        raise ValueError("community_id is required")
    if not query_text.strip():
        return _degrade(query_text, _MODE_NO_EVIDENCE, sink)

    # §4 answers gate, BEFORE any egress (ADR-014). Scoped to egress (A2-P3): asked of the
    # real path and of any injected provider that does not declare zero egress (default:
    # gated). Deliberately NOT restructured into the backfill's gate-and-build block — the
    # provider is built LATER, after the grounding gate, so nothing is constructed below the
    # bar. The gate moves; the build does not.
    if answers_provider is None or not performs_no_egress(answers_provider):
        _ensure_answers_cleared(settings)

    fused = retrieve(
        connection,
        community_id,
        query_text,
        candidate_k=candidate_k,
        top_k=top_k,
        date_range=date_range,
        provider=embedding_provider,
        settings=settings,
        sink=sink,
    )
    context = assemble_context(query_text, fused)

    # Grounding gate (ADR-015): below the bar -> honest degradation, ZERO answers calls.
    if len(fused) < params.grounding_min_segments:
        return _degrade(query_text, _MODE_NO_EVIDENCE, sink)

    provider = (
        answers_provider if answers_provider is not None else _build_answers_provider(settings)
    )
    prompt = build_answer_prompt(context)

    try:
        response = provider.complete(prompt.system_text, prompt.user_text)
    except AnswersProviderUnavailable:
        # The adapter translates any provider/network failure to this one error; it grades to
        # a single provider_unavailable degradation — no retry, no repair.
        return _degrade(query_text, _MODE_PROVIDER_UNAVAILABLE, sink)

    try:
        structured = parse_structured_answer(response.raw_text, context=context)
    except StructuredAnswerError:
        # Malformed JSON, schema mismatch, or a FABRICATED CITATION (closed-corpus violation)
        # all collapse to one honest parse_failure — the answer is suppressed.
        return _degrade(query_text, _MODE_PARSE_FAILURE, sink)

    # §4: counts only — cited vs offered. Emitted for every parsed contour (incl. no_evidence).
    sink.emit(
        GroundingCoverage(covered=len(structured.cited_chunk_ids), total=len(context.ordered))
    )

    mode = _MARKER_TO_MODE[structured.uncertainty]
    if structured.uncertainty == "no_evidence":
        # The model declared the retrieved chunks are not evidence -> suppress the answer.
        return _degrade(query_text, _MODE_NO_EVIDENCE, sink)

    # confident -> clean answer (mode None); uncertain/ambiguous -> RETURN WITH honesty flag
    # (still grounded in cited retrieved family context, never parametric — ADR-015).
    if mode is not None:
        sink.emit(DegradationEvent(mode=mode))
    return GroundedAnswer(
        answer_text=structured.answer_text,
        degradation=mode,
        provenance=_provenance_for(structured, context),
        query_text=query_text,
    )
