"""Provider-port seam for the family-memory engine.

The ``diary-memory-service`` ENGINE stays OUT of the live perimeter
(AGENTS.md §3 / ADR-005): it is a code/data donor for the M3 ``/export`` import
and the M4 retrieval lift, never a live dependency of theygrow-app. ``MemoryProvider``
remains an interface stub.

``EmbeddingProvider`` is the M4-P2 embeddings seam (ADR-011 §1). Its concrete
adapter (``adapters/embeddings/openai_client.py``) is a faithful donor lift that
DOES reach the cloud embedder — but that is a provider call, not an engine call,
and is admitted only because child ``chunk_text`` leaves the perimeter under the
owner-cleared ZDR + DPA + EU-residency surface (the offline backfill gates on that
clearance before sending any text).

``AnswersProvider`` is the M4-P4 grounded-ask seam — the SECOND third-party egress:
the assembled family context (retrieved ``chunk_text``) is sent to the chat/answers
LLM to synthesize an answer. It is a distinct service/DPA/residency surface from the
embedder (ADR-014, per-egress clearance), so ``query_service`` gates it on its OWN
``answers_privacy_cleared`` flag, fail-closed, before constructing this adapter or
sending any text. The method takes the rendered prompt strings (not the domain
``AnswerPrompt``) so this port stays decoupled from the service/domain layer, mirroring
``EmbeddingProvider`` taking a plain ``Sequence[str]``.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@runtime_checkable
class MemoryProvider(Protocol):
    """Structural interface a future family-memory provider adapter satisfies.

    Stub-only at M2-P2. The real adapter (and its concrete methods) land with the
    M4 retrieval lift; this seam exists so the boundary is explicit from the
    start and the engine never becomes a live import.
    """

    def health(self) -> bool:
        """Liveness of the provider seam. Concrete impl lands in M4."""
        ...


@dataclass(frozen=True)
class EmbeddingBatch:
    """One embedder response: the vectors plus the §4-safe usage tally.

    ``vectors`` are positionally aligned with the input texts (each of the
    configured dimension). ``total_tokens`` is the embedder-reported usage,
    carried so the backfill's cost signal sources real numbers (counts only).
    """

    vectors: list[list[float]]
    total_tokens: int


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Structural interface the M4-P2 embeddings adapter satisfies.

    One batch method: embed the given texts and return aligned vectors + usage.
    The concrete adapter is bound by ZDR + DPA + EU-residency (ADR-011 §1); the
    model + dimension are config knobs behind this port, so it is swappable.
    """

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        """Embed ``texts`` -> vectors aligned by position, plus token usage."""
        ...


@dataclass(frozen=True)
class AnswerResponse:
    """One answers/chat response: the raw model text plus the §4-safe token tally.

    ``raw_text`` is the provider's structured-answer JSON, parsed + citation-grounded
    by ``services.context_assembler.parse_structured_answer``. ``total_tokens`` is the
    provider-reported usage (a count), carried so a future cost signal sources real
    numbers; it is never the text. ``0`` when the backend cannot report usage.
    """

    raw_text: str
    total_tokens: int


@runtime_checkable
class AnswersProvider(Protocol):
    """Structural interface the M4-P4 grounded-ask adapter satisfies (ADR-014).

    One method: given the rendered prompt strings, return the model's answer text +
    usage. Strings in / response out keeps the port free of any domain import; the
    ``cited_chunk_ids`` / ``prompt_version`` provenance stays in the service layer. The
    concrete adapter is bound by ZDR + DPA + EU-residency; the model is a config knob
    (``parameters.answers_model``) behind this port, so it is swappable.
    """

    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        """Send the rendered prompt -> the model's raw answer text + token usage."""
        ...
