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
