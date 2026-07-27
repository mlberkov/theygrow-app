"""A2-P2 — in-perimeter deterministic embedding provider (staging seed only).

An ``EmbeddingProvider`` that computes vectors **inside the perimeter**: no network, no
client, no clock, no filesystem. It exists so the staging contour can carry a populated
dense leg while both clearance flags stay unset and the contour makes ZERO third-party
provider calls (ADR-020 / ADR-011 §1). It declares that property structurally via
``performs_no_egress = True``, which is what
``embeddings_backfill._performs_no_egress`` reads to decide whether the per-egress
clearance gate applies at all: privacy clearance is a property of an egress surface, and
an in-perimeter embedder removes that surface rather than satisfying it.

**This is not an embedder.** It is a deterministic stand-in whose similarity structure is
supplied by the corpus, not learned. Two texts are close when they share tokens the
corpus lexicon maps to the same concept, and otherwise near-orthogonal. That is exactly
enough to make the dense leg's *plumbing* exercisable end to end — and to let an eval
author a "semantic-only hit" case, where the query term never appears literally in the
matching chunk (``FTS_CONFIG='simple'`` does no stemming, so the sparse leg misses it and
only the dense leg can find it). It says NOTHING about real embedder recall or semantic
quality; that judgement needs the real provider and is not what staging measures.

Determinism is load-bearing (a seeded corpus must produce byte-identical vectors on every
machine and every run, or an eval baseline means nothing), so the vector basis comes from
``hashlib.blake2b`` — never ``hash()`` (salted per process), ``random`` or any clock.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Mapping, Sequence

from theygrow_api.db.models import EMBEDDING_DIMENSION
from theygrow_api.ports.provider import EmbeddingBatch

#: Word tokenizer. Unicode-aware (``\w`` matches Cyrillic under Python 3 ``str``
#: patterns), so the Russian corpus tokenizes the same way the caller reads it.
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)

#: Weight of the lexical residue relative to the concept signal. Small on purpose:
#: concepts must dominate, or "same concept, different words" stops being closer than
#: "different concept" and the semantic-only case class becomes unauthorable. Non-zero on
#: purpose too, so texts sharing no concept are still separated from each other rather
#: than collapsing onto one shared vector.
_LEXICAL_WEIGHT = 0.15

#: Bytes drawn per blake2b block; each pair of bytes yields one component.
_DIGEST_SIZE = 64


def _basis_vector(seed: str) -> list[float]:
    """A deterministic, L2-normalized pseudo-random unit vector for ``seed``.

    Derived from a blake2b keystream so it is identical across processes, machines and
    Python builds — ``hash()`` is salted per process and would silently break baselines.
    """
    components: list[float] = []
    counter = 0
    while len(components) < EMBEDDING_DIMENSION:
        block = hashlib.blake2b(
            f"{seed}:{counter}".encode(), digest_size=_DIGEST_SIZE
        ).digest()
        for offset in range(0, _DIGEST_SIZE, 2):
            components.append(int.from_bytes(block[offset : offset + 2], "big") / 32767.5 - 1.0)
        counter += 1
    return _normalize(components[:EMBEDDING_DIMENSION])


def _normalize(vector: list[float]) -> list[float]:
    """Scale to unit length; an all-zero vector is returned unchanged (no NaNs)."""
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0:
        return vector
    return [component / norm for component in vector]


class LocalDeterministicEmbeddingProvider:
    """``EmbeddingProvider`` computed in-perimeter from a corpus-supplied concept lexicon.

    ``concepts`` maps a concept name to the surface forms that load it — supplied as
    corpus DATA (``concepts.json``), never hardcoded here, so this module carries no
    staging vocabulary and the shipped package stays corpus-agnostic.

    ``performs_no_egress`` is the structural declaration the backfill reads. It is a
    plain class attribute rather than a method so it cannot be made conditional at call
    time: a provider either never leaves the perimeter or it does not get to claim this.
    """

    #: Structural, checked declaration: this provider performs no network egress.
    performs_no_egress = True

    def __init__(self, concepts: Mapping[str, Sequence[str]]) -> None:
        # token -> concept names it loads. A surface form may load several concepts.
        self._token_concepts: dict[str, list[str]] = {}
        for concept, surface_forms in concepts.items():
            for form in surface_forms:
                self._token_concepts.setdefault(form.lower(), []).append(concept)
        self._cache: dict[str, list[float]] = {}

    def _cached_basis(self, seed: str) -> list[float]:
        cached = self._cache.get(seed)
        if cached is None:
            cached = _basis_vector(seed)
            self._cache[seed] = cached
        return cached

    def _vector_for(self, text: str) -> list[float]:
        tokens = _TOKEN_RE.findall(text.lower())
        accumulator = [0.0] * EMBEDDING_DIMENSION

        for token in tokens:
            for concept in self._token_concepts.get(token, ()):
                basis = self._cached_basis(f"concept:{concept}")
                for index, component in enumerate(basis):
                    accumulator[index] += component
            basis = self._cached_basis(f"token:{token}")
            for index, component in enumerate(basis):
                accumulator[index] += _LEXICAL_WEIGHT * component

        normalized = _normalize(accumulator)
        if any(normalized):
            return normalized
        # Empty or punctuation-only text: fall back to a whole-text basis so no chunk is
        # ever stored as an all-zero vector (cosine distance is undefined against zero).
        return self._cached_basis(f"text:{text}")

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        """Embed ``texts`` -> vectors aligned by position. Zero egress, zero tokens billed.

        ``total_tokens`` is reported as 0 because nothing was billed by anyone — the
        §4-safe cost signal should read zero for the staging contour, not a fabricated
        estimate that would make a seeded run look like it spent money.
        """
        return EmbeddingBatch(vectors=[self._vector_for(text) for text in texts], total_tokens=0)
