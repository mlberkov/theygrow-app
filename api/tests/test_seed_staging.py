"""A2-P2 — staging seed guard, in-perimeter embedder, and corpus composition.

Three things are enforced here.

**The contour guard** (`L2-P2-INV-001`): the seed refuses unless the target database
carries the staging marker, checked independently at the URL (before connecting) and at
the server (`SELECT current_database()`, before any write). Both layers compare against
an allowlist of one, so an unrecognized or absent database name refuses too.

**The egress posture** (`L2-P2-INV-002`): the narrowed clearance gate keeps its
fail-closed default. A provider that does not declare zero egress is gated exactly as
before — that is the load-bearing half, and `test_unmarked_provider_still_gated_when_uncleared`
is its proof carrier. Only an in-perimeter provider runs with clearance unset, and the
seed then makes zero third-party calls.

**The corpus composition**: the properties P3's case classes depend on are asserted
against the committed files, so the README's table cannot drift from the corpus.

The marker constant is monkeypatched (never bypassed) where a test needs the guard to
accept the CI database: both layers still run and must still agree. There is deliberately
no parameter on `seed_staging` that could retarget the marker in production.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import Connection, func, select

from theygrow_api.adapters.embeddings.local_deterministic import (
    LocalDeterministicEmbeddingProvider,
)
from theygrow_api.config import Settings
from theygrow_api.db.models import EMBEDDING_DIMENSION, EventChunk, SourceMessage
from theygrow_api.domain.parser import _split_non_empty_lines, parse_note
from theygrow_api.embeddings_backfill import EmbedderNotReady, embed_backfill
from theygrow_api.ports.provider import EmbeddingBatch
from theygrow_api.seed_staging import (
    STAGING_DATABASE_NAME,
    CorpusNotUsable,
    NotStagingTarget,
    ensure_staging_target,
    load_lexicon,
    seed_staging,
)

CORPUS_ROOT = Path(__file__).resolve().parents[1] / "corpus" / "staging"
EXPORTS_DIR = CORPUS_ROOT / "export-v1"

#: Reserved probe terms: in the lexicon, absent from every chunk. The semantic-only case
#: class stops existing the moment one of these leaks into a diary line.
RESERVED_PROBES = ("дрёма", "жар", "лепет", "равновесие", "каприз")

#: Tokens that must occur only in ``draft`` records (the draft-unreachable probe).
DRAFT_ONLY_TOKENS = ("аквариум", "телескоп")

#: The exact token the corpus repeats so ``candidate_k`` truncation is reachable.
FREQUENT_TOKEN = "сон"

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)

_STAGING_URL = f"postgresql://user:pw@localhost:5432/{STAGING_DATABASE_NAME}"


class _RecordingLocalProvider:
    """In-perimeter provider that records what it was asked to embed."""

    performs_no_egress = True

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        batch = list(texts)
        self.calls.append(batch)
        return EmbeddingBatch(
            vectors=[[0.1] * EMBEDDING_DIMENSION for _ in batch], total_tokens=0
        )


class _EgressingProvider:
    """Provider with no declaration — must be treated as egressing (the default)."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        self.calls.append(list(texts))
        return EmbeddingBatch(vectors=[[0.1] * EMBEDDING_DIMENSION], total_tokens=1)


def _settings(url: str = _STAGING_URL, *, cleared: bool = False) -> Settings:
    return Settings(database_url=url, embedder_privacy_cleared=cleared)


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def _corpus_records() -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for path in sorted(EXPORTS_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        records.extend(document["records"])
    return records


def _corpus_chunks() -> list[tuple[str, str, str]]:
    """(community_id, detected_route, chunk_text) as the derivation pass would split."""
    chunks: list[tuple[str, str, str]] = []
    for record in _corpus_records():
        raw_text = str(record["raw_text"])
        parsed = parse_note(raw_text)
        lines = parsed.events if parsed is not None else _split_non_empty_lines(raw_text)
        for line in lines:
            chunks.append((str(record["community_id"]), str(record["detected_route"]), line))
    return chunks


# --- Layer 1: the URL guard (no DB, no connection) ------------------------


def test_url_guard_accepts_the_staging_marker() -> None:
    ensure_staging_target(_STAGING_URL)


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://user:pw@prod-host:5432/theygrow",
        "postgresql://user:pw@localhost:5432/theygrow_production",
        "postgresql://user:pw@localhost:5432/theygrow_staging_old",
        "postgresql://user:pw@localhost:5432/",
        "postgresql://user:pw@localhost:5432",
    ],
)
def test_url_guard_refuses_anything_but_the_marker(url: str) -> None:
    """Allowlist of one: a production name, a near-miss, and a missing name all refuse."""
    with pytest.raises(NotStagingTarget):
        ensure_staging_target(url)


def test_url_guard_refusal_does_not_echo_the_connection_string() -> None:
    """The URL carries a password; only the database name may reach the message (§4)."""
    with pytest.raises(NotStagingTarget) as excinfo:
        ensure_staging_target("postgresql://user:sup3rsecret@prod-host:5432/theygrow")
    assert "sup3rsecret" not in str(excinfo.value)
    assert "prod-host" not in str(excinfo.value)


def test_seed_refuses_before_touching_the_corpus_when_url_is_not_staging() -> None:
    """Layer 1 runs first: a wrong URL refuses even with a corpus root that cannot exist."""
    with pytest.raises(NotStagingTarget):
        seed_staging(
            corpus_root=Path("/nonexistent-corpus"),
            settings=_settings("postgresql://user:pw@localhost:5432/theygrow"),
        )


# --- Layer 2: the server guard (needs a real connection) ------------------


def test_server_guard_refuses_when_url_and_server_disagree(connection: Connection) -> None:
    """URL claims staging, the connected server is something else -> refuse, write nothing.

    This is the layer that catches a socket/pooler override the URL string cannot show.
    """
    before = connection.execute(select(func.count()).select_from(SourceMessage)).scalar_one()
    with pytest.raises(NotStagingTarget):
        seed_staging(
            corpus_root=CORPUS_ROOT,
            connection=connection,
            settings=_settings(),  # URL says theygrow_staging; the CI database does not
        )
    after = connection.execute(select(func.count()).select_from(SourceMessage)).scalar_one()
    assert after == before


# --- The seed, end to end, with BOTH clearance flags unset ----------------


@pytest.fixture
def staging_marker(connection: Connection, monkeypatch: pytest.MonkeyPatch) -> str:
    """Retarget the marker at the CI database — both guard layers still run and agree."""
    actual = connection.exec_driver_sql("SELECT current_database()").scalar_one()
    monkeypatch.setattr("theygrow_api.seed_staging.STAGING_DATABASE_NAME", actual)
    return str(actual)


def test_seed_populates_the_contour_with_zero_third_party_calls(
    connection: Connection, staging_marker: str, tmp_path: Path
) -> None:
    """The whole point: a populated staging contour with clearance UNSET and no egress."""
    provider = _RecordingLocalProvider()
    settings = _settings(f"postgresql://user:pw@localhost:5432/{staging_marker}", cleared=False)

    summary = seed_staging(
        corpus_root=CORPUS_ROOT,
        connection=connection,
        settings=settings,
        provider=provider,
        quarantine_dir=tmp_path,
    )

    assert summary.exports == 3
    assert summary.inserted == 136
    assert summary.quarantined == 0
    assert summary.sources_processed == 136
    assert summary.chunks == summary.embedded > 0
    # Every embedding call went to the in-perimeter provider.
    assert sum(len(call) for call in provider.calls) == summary.chunks
    assert not settings.embedder_privacy_cleared

    ready = connection.execute(
        select(func.count()).select_from(EventChunk).where(EventChunk.embedding_status == "ready")
    ).scalar_one()
    assert ready == summary.chunks


def test_seed_is_idempotent(
    connection: Connection, staging_marker: str, tmp_path: Path
) -> None:
    """Re-seeding converges: the second run inserts nothing new and re-embeds nothing."""
    settings = _settings(f"postgresql://user:pw@localhost:5432/{staging_marker}")
    first = seed_staging(
        corpus_root=CORPUS_ROOT,
        connection=connection,
        settings=settings,
        provider=_RecordingLocalProvider(),
        quarantine_dir=tmp_path,
    )
    second_provider = _RecordingLocalProvider()
    second = seed_staging(
        corpus_root=CORPUS_ROOT,
        connection=connection,
        settings=settings,
        provider=second_provider,
        quarantine_dir=tmp_path,
    )

    assert second.inserted == 0
    assert second.updated == first.inserted
    assert second.sources_processed == first.sources_processed
    # Re-derivation rebuilds chunks (delete-then-insert), so they return to 'pending' and
    # are re-embedded — but by the SAME in-perimeter provider, at zero cost and zero egress.
    assert second.chunks == first.chunks
    assert second_provider.calls


def test_seed_refuses_a_corpus_without_a_lexicon(
    connection: Connection, staging_marker: str, tmp_path: Path
) -> None:
    (tmp_path / "export-v1").mkdir()
    (tmp_path / "export-v1" / "x.json").write_text("{}", encoding="utf-8")
    with pytest.raises(CorpusNotUsable):
        seed_staging(
            corpus_root=tmp_path,
            connection=connection,
            settings=_settings(f"postgresql://user:pw@localhost:5432/{staging_marker}"),
        )


# --- The narrowed clearance gate keeps its fail-closed default ------------


def test_unmarked_provider_still_gated_when_uncleared(connection: Connection) -> None:
    """`L2-P2-INV-002`'s load-bearing half: no declaration means gated, exactly as before.

    The narrowing must not become a bypass by omission — a provider that simply forgets
    to declare anything is treated as egressing and refused with clearance unset.
    """
    provider = _EgressingProvider()
    with pytest.raises(EmbedderNotReady):
        embed_backfill(connection=connection, provider=provider, settings=_settings())
    assert provider.calls == []


def test_truthy_declaration_is_not_enough(connection: Connection) -> None:
    """Only an exact ``True`` counts — a truthy stand-in stays gated."""

    class _Sloppy:
        performs_no_egress = "yes"

        def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:  # pragma: no cover
            raise AssertionError("must not be called")

    with pytest.raises(EmbedderNotReady):
        embed_backfill(connection=connection, provider=_Sloppy(), settings=_settings())


def test_in_perimeter_provider_runs_with_clearance_unset(connection: Connection) -> None:
    settings = _settings(cleared=False)
    summary = embed_backfill(
        connection=connection, provider=_RecordingLocalProvider(), settings=settings
    )
    assert summary.failed == 0


# --- The in-perimeter provider --------------------------------------------


def test_local_provider_is_deterministic_across_instances() -> None:
    """Byte-identical vectors across instances and processes — baselines depend on it."""
    lexicon = load_lexicon(CORPUS_ROOT)
    first = LocalDeterministicEmbeddingProvider(lexicon).embed_texts(["дневной сон был крепкий"])
    second = LocalDeterministicEmbeddingProvider(lexicon).embed_texts(["дневной сон был крепкий"])
    assert first.vectors == second.vectors
    assert first.total_tokens == 0


def test_local_provider_vectors_are_dimension_pinned_and_normalized() -> None:
    provider = LocalDeterministicEmbeddingProvider(load_lexicon(CORPUS_ROOT))
    batch = provider.embed_texts(["сон был спокойный", "", "   "])
    assert [len(vector) for vector in batch.vectors] == [EMBEDDING_DIMENSION] * 3
    for vector in batch.vectors:
        assert math.isclose(math.sqrt(sum(c * c for c in vector)), 1.0, rel_tol=1e-9)


def test_concept_synonyms_are_closer_than_unrelated_text() -> None:
    """The precondition for P3's semantic-only case class.

    A reserved probe term shares no token with the chunk it should match, so only the
    concept axes can bring them together.
    """
    provider = LocalDeterministicEmbeddingProvider(load_lexicon(CORPUS_ROOT))
    probe, same_concept, other_concept = provider.embed_texts(
        ["дрёма", "дневной сон длился почти два часа", "прорезался нижний зуб"]
    ).vectors

    def cosine(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    assert cosine(probe, same_concept) > cosine(probe, other_concept)


# --- Corpus composition ----------------------------------------------------


def test_corpus_scope_matches_its_records() -> None:
    """One export per community, envelope scope agreeing with every record in it."""
    for path in sorted(EXPORTS_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        scope = document["export"]["scope"]["community_id"]
        assert {record["community_id"] for record in document["records"]} == {scope}
        assert document["export"]["record_count"] == len(document["records"])


def test_corpus_note_draft_mix_supports_eligibility() -> None:
    records = _corpus_records()
    notes = sum(1 for record in records if record["detected_route"] == "note")
    assert len(records) == 136
    assert 0.75 <= notes / len(records) <= 0.85


def test_corpus_spans_two_years_across_three_communities() -> None:
    records = _corpus_records()
    assert len({record["community_id"] for record in records}) == 3
    days: list[date] = []
    for record in records:
        parsed = parse_note(str(record["raw_text"]))
        if parsed is not None:
            days.append(parsed.note_date)
        else:
            days.append(date.fromisoformat(str(record["created_at"])[:10]))
    assert (max(days) - min(days)).days >= 700


def test_corpus_carries_both_parser_paths() -> None:
    records = _corpus_records()
    dated = sum(1 for record in records if parse_note(str(record["raw_text"])) is not None)
    fallback = len(records) - dated
    assert dated > 0 and fallback > 0
    assert fallback / len(records) >= 0.2


def test_corpus_carries_live_routes_only() -> None:
    """No quarantine sidecar can be produced, so a seed never writes beside the corpus."""
    assert {record["detected_route"] for record in _corpus_records()} == {"note", "draft"}


def test_frequent_token_exceeds_candidate_k_in_one_community() -> None:
    """`candidate_k=50` only truncates if >50 ELIGIBLE chunks carry one literal token.

    'simple' FTS does no stemming, so this must be the exact surface form.
    """
    eligible = [
        text
        for community, route, text in _corpus_chunks()
        if community == "comm-staging-alpha" and route == "note"
    ]
    assert sum(1 for text in eligible if FREQUENT_TOKEN in _tokens(text)) > 50


def test_reserved_probes_are_in_the_lexicon_and_in_no_chunk() -> None:
    """Both halves, or the semantic-only case class quietly becomes a lexical one."""
    lexicon = load_lexicon(CORPUS_ROOT)
    all_forms = {form for forms in lexicon.values() for form in forms}
    corpus_tokens: set[str] = set()
    for _, _, text in _corpus_chunks():
        corpus_tokens |= _tokens(text)
    for probe in RESERVED_PROBES:
        assert probe in all_forms, probe
        assert probe not in corpus_tokens, probe


def test_draft_only_tokens_never_appear_in_an_eligible_chunk() -> None:
    """A query for these must return nothing — they exist only behind the route filter."""
    for token in DRAFT_ONLY_TOKENS:
        routes = {route for _, route, text in _corpus_chunks() if token in _tokens(text)}
        assert routes == {"draft"}, token


def test_a_distinctive_line_is_shared_across_two_communities() -> None:
    """Isolation is only provable if the communities actually collide lexically."""
    counts: dict[str, set[str]] = {}
    for community, _, text in _corpus_chunks():
        counts.setdefault(text, set()).add(community)
    assert any(len(communities) > 1 for communities in counts.values())
