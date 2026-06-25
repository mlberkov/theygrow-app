"""M4-P4 — grounded-ask context assembly + the grounding contract.

Lifts the engine's channel-neutral context assembler plus the answer-prompt contract and the
citation-grounding parser (``memory_rag.services.context_assembler`` +
``memory_rag.core.domain.answer_prompt`` + ``...answer_schema``; ADR-005 §7: transfer, not
rewrite — the donor is out of perimeter, so the algorithm is transferred, not imported).

Three faithful transfers, all PURE (no retrieval, no persistence, no providers, no DB):

  * :func:`assemble_context` — maps the RRF-fused candidates to an :class:`AssembledContext`
    (the ordered family segments + the query). RRF already dedups by ``chunk_id`` and applies
    the deterministic tiebreak upstream, so the order is taken as-is and no re-dedup/re-scope
    is done here. Community scoping is enforced upstream (``retrieve`` is community-scoped).
  * :func:`build_answer_prompt` — renders the CLOSED-CORPUS prompt: the model answers ONLY
    from the provided family segments, every factual claim must cite a ``chunk_id``, and if
    the segments do not contain the answer it must return ``uncertainty="no_evidence"``. A
    defensive cross-community guard (R-8) refuses a context spanning >1 community.
  * :func:`parse_structured_answer` — strict JSON parse + the grounding gate at the contract
    boundary: every ``cited_chunk_id`` MUST be present in the assembled context (a fabricated
    citation is rejected — this is the structural closed-corpus enforcement, never a
    parametric/web fallback). Empty citations are permitted only with ``no_evidence``.

§4: this module handles ``chunk_text`` (it renders it into the prompt the answers LLM will
read) but logs nothing and emits no signals — text stays out of telemetry.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal, cast

from theygrow_api.retrieval.search_repository import Candidate
from theygrow_api.services.retrieval import FusedCandidate

__all__ = [
    "AnswerPrompt",
    "AssembledContext",
    "CrossCommunityContextError",
    "PROMPT_VERSION",
    "StructuredAnswer",
    "StructuredAnswerError",
    "UncertaintyMarker",
    "assemble_context",
    "build_answer_prompt",
    "parse_structured_answer",
]

PROMPT_VERSION: Final[str] = "v1"

UncertaintyMarker = Literal["confident", "uncertain", "no_evidence", "ambiguous"]

_VALID_UNCERTAINTY: Final[frozenset[str]] = frozenset(
    {"confident", "uncertain", "no_evidence", "ambiguous"}
)
_REQUIRED_FIELDS: Final[frozenset[str]] = frozenset(
    {"answer_text", "cited_chunk_ids", "uncertainty"}
)

_SYSTEM_TEXT: Final[str] = (
    "You answer the user's question using only the provided family-diary chunks. "
    "Every factual claim must cite at least one chunk_id from the list. "
    "Return a single JSON object with these fields: "
    '"answer_text" (string), '
    '"cited_chunk_ids" (array of chunk_id strings drawn from the list), '
    '"uncertainty" (one of "confident", "uncertain", "no_evidence", "ambiguous"). '
    'If the chunks do not contain the answer, return uncertainty="no_evidence" '
    "with an empty cited_chunk_ids array."
)

_NO_CHUNKS_PLACEHOLDER: Final[str] = "(no diary chunks were retrieved for this question)"


@dataclass(frozen=True)
class AssembledContext:
    """The minimal grounded-ask payload: the query plus the ordered family segments.

    ``ordered`` is the RRF rank order (deterministic tiebreak already applied upstream); each
    element is a retrieved :class:`Candidate` carrying its own provenance (chunk/note/source
    ids, date, event index). The prompt builder and the parser both read this; the query
    service maps the cited segments back to provenance from it.
    """

    query_text: str
    ordered: tuple[Candidate, ...]


@dataclass(frozen=True)
class AnswerPrompt:
    """Versioned prompt rendered from an :class:`AssembledContext`.

    ``cited_chunk_ids`` lists the chunk_ids the prompt body references, in the same order
    they appear in ``context.ordered``. The answers-provider port consumes ``system_text`` /
    ``user_text``; the service keeps ``cited_chunk_ids`` / ``prompt_version`` for provenance.
    """

    prompt_version: str
    system_text: str
    user_text: str
    cited_chunk_ids: tuple[str, ...]


class CrossCommunityContextError(ValueError):
    """Raised when an :class:`AssembledContext` mixes chunks from more than one community.

    Enforces R-8 defensively: prompt assembly never mixes chunks from more than one
    ``community_id`` (``retrieve`` is already community-scoped, so this is a guard).
    """


class StructuredAnswerError(ValueError):
    """Base class for structured-answer parse / grounding failures."""


class MalformedAnswerJSONError(StructuredAnswerError):
    """Raw LLM response is not valid JSON."""


class AnswerSchemaMismatchError(StructuredAnswerError):
    """JSON object does not match the structured-answer shape."""


class FabricatedCitationError(StructuredAnswerError):
    """A ``cited_chunk_id`` was not present in the assembled context (closed-corpus gate)."""


@dataclass(frozen=True)
class StructuredAnswer:
    """The parsed, citation-grounded LLM response."""

    answer_text: str
    cited_chunk_ids: tuple[str, ...]
    uncertainty: UncertaintyMarker


def assemble_context(query_text: str, fused: Sequence[FusedCandidate]) -> AssembledContext:
    """Build an :class:`AssembledContext` from the query and the RRF-fused candidates."""
    return AssembledContext(
        query_text=query_text,
        ordered=tuple(f.candidate for f in fused),
    )


def build_answer_prompt(context: AssembledContext) -> AnswerPrompt:
    """Render the closed-corpus grounded prompt for one :class:`AssembledContext`.

    Asserts R-8 (single ``community_id`` across ``ordered``) and raises
    :class:`CrossCommunityContextError` on violation. Output is deterministic given input.
    """
    communities = {chunk.community_id for chunk in context.ordered}
    if len(communities) > 1:
        raise CrossCommunityContextError(
            f"AssembledContext.ordered spans multiple communities: {sorted(communities)}"
        )

    cited_chunk_ids = tuple(chunk.chunk_id for chunk in context.ordered)

    if not context.ordered:
        chunks_block = _NO_CHUNKS_PLACEHOLDER
    else:
        chunks_block = "\n".join(
            f"- chunk_id={chunk.chunk_id} "
            f"date={chunk.note_date.isoformat()} "
            f"event_index={chunk.event_index} "
            f"text={chunk.chunk_text}"
            for chunk in context.ordered
        )

    user_text = (
        f"Question: {context.query_text}\n\nDiary chunks (in retrieval rank order):\n{chunks_block}"
    )

    return AnswerPrompt(
        prompt_version=PROMPT_VERSION,
        system_text=_SYSTEM_TEXT,
        user_text=user_text,
        cited_chunk_ids=cited_chunk_ids,
    )


def parse_structured_answer(raw: str, *, context: AssembledContext) -> StructuredAnswer:
    """Parse ``raw`` JSON, validate the shape, enforce citation grounding (closed corpus).

    Every ``cited_chunk_id`` must be a chunk_id present in ``context.ordered`` — a fabricated
    citation is rejected (the model may not ground on anything outside the retrieved family
    context). Empty ``cited_chunk_ids`` is permitted only when ``uncertainty == "no_evidence"``;
    ``"uncertain"`` and ``"ambiguous"`` therefore require non-empty citations.
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MalformedAnswerJSONError(f"raw response is not valid JSON: {exc.msg}") from exc

    if not isinstance(payload, dict):
        raise AnswerSchemaMismatchError("expected a JSON object at the top level")

    keys = set(payload.keys())
    missing = _REQUIRED_FIELDS - keys
    if missing:
        raise AnswerSchemaMismatchError(f"missing required fields: {sorted(missing)}")
    extra = keys - _REQUIRED_FIELDS
    if extra:
        raise AnswerSchemaMismatchError(f"unexpected fields: {sorted(extra)}")

    answer_text = payload["answer_text"]
    if not isinstance(answer_text, str):
        raise AnswerSchemaMismatchError("answer_text must be a string")

    raw_citations = payload["cited_chunk_ids"]
    if not isinstance(raw_citations, list) or not all(
        isinstance(item, str) for item in raw_citations
    ):
        raise AnswerSchemaMismatchError("cited_chunk_ids must be a list of strings")
    cited_chunk_ids = tuple(raw_citations)

    uncertainty_raw = payload["uncertainty"]
    if uncertainty_raw not in _VALID_UNCERTAINTY:
        raise AnswerSchemaMismatchError(
            f"uncertainty must be one of {sorted(_VALID_UNCERTAINTY)}, got {uncertainty_raw!r}"
        )
    uncertainty = cast(UncertaintyMarker, uncertainty_raw)

    context_chunk_ids = {chunk.chunk_id for chunk in context.ordered}
    fabricated = [cid for cid in cited_chunk_ids if cid not in context_chunk_ids]
    if fabricated:
        raise FabricatedCitationError(
            f"cited_chunk_ids not present in AssembledContext: {fabricated}"
        )

    if not cited_chunk_ids and uncertainty != "no_evidence":
        raise AnswerSchemaMismatchError(
            'empty cited_chunk_ids is only permitted with uncertainty="no_evidence"'
        )

    return StructuredAnswer(
        answer_text=answer_text,
        cited_chunk_ids=cited_chunk_ids,
        uncertainty=uncertainty,
    )
