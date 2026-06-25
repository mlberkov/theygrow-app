"""M4-P2 — OpenAI embeddings adapter (donor lift; ADR-005 §7: transfer, not rewrite).

A concrete ``EmbeddingProvider`` behind the provider-port (``ports/provider.py``).
The donor ``adapters/embeddings/openai_client.py`` is transferred here; the model +
dimension are config knobs (``parameters.embedding_model`` / ``EMBEDDING_DIMENSION``),
so the port stays swappable.

Perimeter (ADR-005 / ADR-011 §1): the OpenAI SDK is a *provider* dependency, not the
``diary-memory-service`` engine — there is no ``memory_rag`` import here. This adapter
DOES reach the cloud embedder, which is admitted only because child ``chunk_text``
leaves the perimeter under the owner-cleared ZDR + DPA + EU-residency surface. The
``base_url`` pins that residency-bound endpoint; the offline backfill is what gates on
the clearance flag before constructing this adapter or sending any text.

§4: this adapter sends ``chunk_text`` to the embedder (the one permitted egress) but
logs nothing — callers keep text out of logs/telemetry.
"""

from __future__ import annotations

from collections.abc import Sequence

from openai import OpenAI

from theygrow_api.ports.provider import EmbeddingBatch


class OpenAIEmbeddingProvider:
    """``EmbeddingProvider`` over the OpenAI embeddings API (residency-bound endpoint).

    ``dimension`` is passed through as the API ``dimensions`` argument so the donor
    model (``text-embedding-3-large``) is MRL-truncated to the schema-bound dimension
    (ADR-011 §2). ``base_url`` selects the ZDR + DPA + EU-residency endpoint.
    """

    def __init__(self, *, api_key: str, base_url: str, model: str, dimension: int) -> None:
        self._client = OpenAI(api_key=api_key, base_url=base_url)
        self._model = model
        self._dimension = dimension

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        """Embed ``texts`` -> vectors aligned by position, plus token usage.

        The response preserves input order, so ``data[i]`` aligns with ``texts[i]``;
        we still sort by ``index`` defensively to keep alignment a property, not an
        assumption.
        """
        response = self._client.embeddings.create(
            model=self._model,
            input=list(texts),
            dimensions=self._dimension,
        )
        vectors = [item.embedding for item in sorted(response.data, key=lambda d: d.index)]
        return EmbeddingBatch(vectors=vectors, total_tokens=response.usage.total_tokens)
