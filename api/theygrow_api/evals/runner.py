"""A2-P3 — the eval runner: drive the labeled set, score it, refuse if the contour is wrong.

One entry point, ``theygrow-eval``, with two run modes:

* ``--mode ci`` — against the ephemeral pgvector service in ``.github/workflows/ci.yml``.
  Proves the pipeline itself on every push.
* ``--mode staging`` — owner-run against the staging contour, adding a liveness assertion
  on the staging service's ``/api/health``. That service is private
  (``--no-allow-unauthenticated``), so liveness needs an identity token, not a bare curl;
  the token is read from an environment variable the owner fills from
  ``gcloud auth print-identity-token`` (``docs/RUNBOOK.md``, staging contour). **This
  runner never invokes ``gcloud`` and never touches GCP.**

  The liveness probe proves INGRESS only. The staging service opens no database connection
  and exposes nothing but ``/api/health``, so a green probe says nothing about the database
  this eval actually reads. Both are asserted because both are part of "staging is green";
  neither stands in for the other.

**Zero third-party egress.** Both providers are in-perimeter — the P2 deterministic
embedder and the A2-P3 policy answers provider — so a run makes ZERO provider calls and
both clearance flags stay unset. That works because the clearance gates are scoped to
egress and fail closed on an absent declaration (``ports.provider.performs_no_egress``);
the eval does not set, and must never set, a clearance flag the owner never granted.

**Fail-closed on the contour, before any case runs.** :func:`check_contour` refuses unless
the target database carries the staging marker AND is seeded as the corpus on disk
describes AND its stored vectors agree with the eval's lexicon. The marker check matters
even though this is a read-only pass: three of the six case classes assert ABSENCE, so an
empty, stale or wrong database would pass them trivially and report green. The seed's
contour guard protects writes; this one protects the artifact.

Exit codes: ``0`` all cases passed; ``1`` at least one case failed; ``2`` the run could not
happen (wrong database, unseeded contour, lexicon disagreement, staging not live).

Privacy (AGENTS.md §4): every log line and the scorecard carry case ids, bounded check
names, counts and timings only — never query text, chunk text, chunk ids or a
``community_id``, and never a connection string.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import time
import urllib.error
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, func, select

from theygrow_api.adapters.answers.local_scripted import ScriptedAnswersProvider
from theygrow_api.adapters.embeddings.local_deterministic import (
    LocalDeterministicEmbeddingProvider,
)
from theygrow_api.config import Settings, get_settings
from theygrow_api.db.engine import get_engine
from theygrow_api.db.models import EventChunk
from theygrow_api.domain.parser import _split_non_empty_lines, parse_note
from theygrow_api.evals.queries import LABELED_SET, LabeledQuery
from theygrow_api.evals.scorecard import CaseResult, Scorecard, emit_scorecard, summarize
from theygrow_api.logging import install_pii_redaction
from theygrow_api.ports.provider import EmbeddingProvider
from theygrow_api.retrieval.search_repository import DateRange
from theygrow_api.seed_staging import (
    CorpusNotUsable,
    NotStagingTarget,
    ensure_staging_server,
    ensure_staging_target,
    load_lexicon,
)
from theygrow_api.services.query_service import answer_query
from theygrow_api.services.retrieval import retrieve
from theygrow_api.signals import SignalSink, default_sink

logger = logging.getLogger(__name__)

__all__ = ["ContourNotReady", "check_contour", "run_eval"]

#: Word tokenizer for the coverage predicates. Same shape as the local embedder's, so
#: "carries this term" means the same thing on both sides of the dense leg.
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)

#: Stored vectors are ``vector(1536)`` = float4, so a re-embedded float64 vector agrees to
#: single precision, not to the bit. Normalized components are <= 1 in magnitude and
#: float32 eps is ~1.2e-7, so this tolerance is tight enough to catch a different lexicon
#: (which moves components by orders of magnitude more) and loose enough never to flap.
_VECTOR_TOLERANCE = 1e-6

#: Degradation modes under which the answer text MUST be suppressed (ADR-015). The two
#: honesty-flag modes ('weak_evidence', 'ambiguous') deliberately keep their answer.
_SUPPRESSING_MODES = frozenset({"no_evidence", "provider_unavailable", "parse_failure"})

#: HTTP timeout for the staging liveness probe, in seconds.
_HEALTH_TIMEOUT = 15.0


class ContourNotReady(RuntimeError):
    """The target contour cannot be evaluated: wrong database, unseeded, or drifted.

    Raised before any case runs. Distinct from a case failure, and reported with its own
    exit code, because "the gate found a regression" and "the gate never really ran" must
    never look the same to a reader of CI output.
    """


class StagingNotLive(RuntimeError):
    """The staging service did not answer its health check (``--mode staging`` only)."""


@dataclass(frozen=True)
class _CorpusShape:
    """Counts derived from the corpus ON DISK, used to check the contour matches it."""

    chunks: int
    communities: int


def corpus_shape(corpus_root: Path) -> _CorpusShape:
    """Derive the chunk / community counts the corpus on disk implies.

    Derived rather than hardcoded so the check is "the contour matches this corpus", not
    "the contour matches a number somebody wrote down". Uses the SAME parser the
    derivation pass uses, so the chunk boundary cannot drift between the two.
    """
    exports_dir = corpus_root / "export-v1"
    if not exports_dir.is_dir():
        raise CorpusNotUsable(f"corpus is missing its {exports_dir.name}/ directory")
    chunks = 0
    communities: set[str] = set()
    for path in sorted(exports_dir.glob("*.json")):
        document: Any = json.loads(path.read_text(encoding="utf-8"))
        for record in document["records"]:
            communities.add(record["community_id"])
            parsed = parse_note(record["raw_text"])
            events = parsed.events if parsed is not None else _split_non_empty_lines(
                record["raw_text"]
            )
            chunks += len(events)
    if not communities:
        raise CorpusNotUsable(f"corpus {exports_dir.name}/ contains no records")
    return _CorpusShape(chunks=chunks, communities=len(communities))


def check_contour(
    connection: Connection,
    *,
    corpus_root: Path,
    provider: EmbeddingProvider,
) -> _CorpusShape:
    """Refuse unless this is the staging contour, seeded from THIS corpus, with THIS lexicon.

    Three independent checks, cheapest first:

    1. the connected server carries the staging marker (the seed's own layer-2 guard,
       reused rather than re-implemented);
    2. the derived layer matches the corpus on disk (chunk count + community count) —
       without this, an empty contour passes every absence-asserting case and reports green;
    3. **lexicon agreement**: one stored vector, re-embedded with the eval's provider, must
       match. Nothing in the database records which ``concepts.json`` produced its vectors,
       so a stale seed or an edited lexicon would silently turn the dense leg into noise and
       fail the semantic-only cases for a reason no output would explain.
    """
    ensure_staging_server(connection, action="evaluate")

    expected = corpus_shape(corpus_root)
    actual_chunks = connection.execute(select(func.count()).select_from(EventChunk)).scalar_one()
    actual_communities = connection.execute(
        select(func.count(func.distinct(EventChunk.community_id)))
    ).scalar_one()
    if actual_chunks != expected.chunks or actual_communities != expected.communities:
        raise ContourNotReady(
            f"contour is not seeded as this corpus describes: chunks={actual_chunks} "
            f"(expected {expected.chunks}), communities={actual_communities} "
            f"(expected {expected.communities}). Run theygrow-seed-staging first. "
            "Nothing was evaluated."
        )

    row = connection.execute(
        select(EventChunk.chunk_text, EventChunk.embedding)
        .where(EventChunk.embedding_status == "ready")
        .order_by(EventChunk.chunk_id)
        .limit(1)
    ).first()
    if row is None or row.embedding is None:
        raise ContourNotReady(
            "contour carries no embedded chunk; the dense leg would be empty and every "
            "semantic-only case would fail for the wrong reason. Nothing was evaluated."
        )
    reembedded = provider.embed_texts([row.chunk_text]).vectors[0]
    if len(reembedded) != len(row.embedding) or any(
        abs(a - b) > _VECTOR_TOLERANCE for a, b in zip(reembedded, row.embedding, strict=True)
    ):
        raise ContourNotReady(
            "stored vectors disagree with this run's lexicon — the contour was seeded from "
            "a different concepts.json, or the embedder's arithmetic changed. The dense leg "
            "would be noise. Nothing was evaluated."
        )
    return expected


def _carries(text: str, terms: Sequence[str]) -> bool:
    tokens = set(_TOKEN_RE.findall(text.lower()))
    return any(term.lower() in tokens for term in terms)


def _evaluate_case(
    connection: Connection,
    case: LabeledQuery,
    *,
    lexicon: dict[str, list[str]],
    embedding_provider: EmbeddingProvider,
    settings: Settings,
    sink: SignalSink,
) -> CaseResult:
    """Run one labeled case through both seams and grade it against its expectations.

    Both seams are driven: ``retrieve()`` for the retrieval predicates (``answer_query``
    discards the per-leg ranks, and ``sparse_rank is None`` is the load-bearing assertion
    for a semantic-only case) and ``answer_query()`` for the answer-side ones. The second
    embed is in-perimeter and free.
    """
    failed: list[str] = []
    date_range = (
        DateRange(start=case.date_range_start, end=case.date_range_end)
        if case.date_range_start is not None or case.date_range_end is not None
        else None
    )

    fused = retrieve(
        connection,
        case.community_id,
        case.query_text,
        provider=embedding_provider,
        settings=settings,
        sink=sink,
        date_range=date_range,
    )
    returned_ids = [f.candidate.chunk_id for f in fused]

    # --- structural checks, applied to EVERY case (never per-case opt-in) ---------------
    scope_violations = sum(1 for f in fused if f.candidate.community_id != case.community_id)
    if scope_violations:
        failed.append("community_scope")
    # Note-only eligibility is enforced by an FK join in both legs; the eval observes the
    # consequence it can see from here — no excluded draft id may surface. The per-case
    # must_exclude ids below are the draft twins that make that observable.
    route_violations = 0

    # --- per-case predicates -------------------------------------------------------------
    if case.expect_result_count is not None and len(fused) != case.expect_result_count:
        failed.append("result_count")
    if case.min_results is not None and len(fused) < case.min_results:
        failed.append("min_results")
    if any(cid not in returned_ids for cid in case.must_contain_chunk_ids):
        failed.append("must_contain")
    forbidden = [cid for cid in case.must_exclude_chunk_ids if cid in returned_ids]
    if forbidden:
        failed.append("must_exclude")
        route_violations = len(forbidden)

    if case.min_results_covered is not None:
        terms = (
            tuple(lexicon.get(case.coverage_concept, ()))
            if case.coverage_concept is not None
            else case.coverage_terms
        )
        covered = sum(1 for f in fused if _carries(f.candidate.chunk_text, terms))
        if covered < case.min_results_covered:
            failed.append("coverage")
    if case.expect_no_sparse_leg and any(f.sparse_rank is not None for f in fused):
        failed.append("no_sparse_leg")
    if case.min_results_from_sparse_leg is not None:
        from_sparse = sum(1 for f in fused if f.sparse_rank is not None)
        if from_sparse < case.min_results_from_sparse_leg:
            failed.append("sparse_leg_count")

    # --- the answer leg -------------------------------------------------------------------
    answers = ScriptedAnswersProvider(case.answer_policy)
    answer = answer_query(
        connection,
        case.community_id,
        case.query_text,
        embedding_provider=embedding_provider,
        answers_provider=answers,
        settings=settings,
        sink=sink,
        date_range=date_range,
    )
    if answers.call_count != case.expect_answers_calls:
        failed.append("answers_calls")
    if answer.degradation != case.expect_degradation:
        failed.append("degradation")
    suppressed = answer.answer_text is None
    if suppressed != (answer.degradation in _SUPPRESSING_MODES):
        failed.append("answer_suppression")

    provenance_ids = [p.chunk_id for p in answer.provenance]
    if any(cid not in returned_ids for cid in provenance_ids):
        failed.append("provenance_subset")
    if [cid for cid in returned_ids if cid in provenance_ids] != provenance_ids:
        failed.append("provenance_order")

    return CaseResult(
        case_id=case.case_id,
        case_class=case.case_class,
        holdout=case.holdout,
        passed=not failed,
        failed_checks=tuple(failed),
        scope_violations=scope_violations,
        route_violations=route_violations,
    )


def _run(
    connection: Connection,
    *,
    corpus_root: Path,
    settings: Settings,
    sink: SignalSink,
    mode: str,
) -> Scorecard:
    lexicon = load_lexicon(corpus_root)
    embedding_provider = LocalDeterministicEmbeddingProvider(lexicon)
    shape = check_contour(connection, corpus_root=corpus_root, provider=embedding_provider)

    results: list[CaseResult] = []
    durations_ms: dict[str, float] = {}
    started = time.perf_counter()
    for case in LABELED_SET:
        case_started = time.perf_counter()
        results.append(
            _evaluate_case(
                connection,
                case,
                lexicon=lexicon,
                embedding_provider=embedding_provider,
                settings=settings,
                sink=sink,
            )
        )
        elapsed = (time.perf_counter() - case_started) * 1000.0
        durations_ms[case.case_class] = durations_ms.get(case.case_class, 0.0) + elapsed
    total_duration_ms = (time.perf_counter() - started) * 1000.0

    scorecard = summarize(
        tuple(results),
        durations_ms=durations_ms,
        total_duration_ms=total_duration_ms,
        corpus_chunks=shape.chunks,
        corpus_communities=shape.communities,
        mode=mode,
    )
    emit_scorecard(scorecard, sink)
    return scorecard


def run_eval(
    *,
    corpus_root: Path,
    connection: Connection | None = None,
    settings: Settings | None = None,
    sink: SignalSink | None = None,
    mode: str = "ci",
) -> Scorecard:
    """Run the whole labeled set against the staging contour and score it.

    Both contour guards run before any case: the URL marker before an engine exists, the
    server marker (plus the seeded-and-agreeing checks) immediately after. When
    ``connection`` is supplied the caller owns the transaction (tests); otherwise one is
    opened here. Read-only: the eval writes nothing.
    """
    settings = settings if settings is not None else get_settings()
    sink = sink if sink is not None else default_sink()

    # Layer 1 — before an engine exists, let alone a connection.
    ensure_staging_target(settings.database_url, action="evaluate")

    if connection is not None:
        return _run(connection, corpus_root=corpus_root, settings=settings, sink=sink, mode=mode)
    engine = get_engine()
    with engine.connect() as conn:
        return _run(conn, corpus_root=corpus_root, settings=settings, sink=sink, mode=mode)


def assert_staging_live(health_url: str, identity_token: str) -> None:
    """Assert the private staging service answers ``/api/health`` (``--mode staging``).

    A single authenticated GET. The token is supplied by the owner (via the environment,
    from ``gcloud auth print-identity-token``) — this process never shells out to
    ``gcloud`` and holds no credential of its own. Uses stdlib ``urllib`` on purpose: one
    GET does not justify a runtime HTTP dependency.
    """
    request = urllib.request.Request(  # noqa: S310 - https URL supplied by the operator
        health_url, headers={"Authorization": f"Bearer {identity_token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=_HEALTH_TIMEOUT) as response:  # noqa: S310
            status = int(response.status)
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as exc:
        raise StagingNotLive(f"staging health check did not answer usably: {exc}") from exc
    if status != 200 or payload.get("status") != "ok":
        raise StagingNotLive(f"staging health check returned status={status}, payload={payload!r}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theygrow-eval",
        description=(
            "Run the labeled query set against the seeded STAGING contour and write a "
            "counts-only scorecard. Refuses unless the target database carries the staging "
            "marker and is seeded from the given corpus. Makes zero third-party provider "
            "calls. Contract conformance on a synthetic corpus — NOT a recall or "
            "answer-quality measure."
        ),
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help=(
            "Corpus root: the directory the contour was seeded from. Required and "
            "default-less — the corpus is not package data and is absent from the runtime "
            "image, so a default path would work from a checkout and fail anywhere else."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=("ci", "staging"),
        default="ci",
        help=(
            "'ci': database only (the ephemeral pgvector service). 'staging': additionally "
            "assert the private staging service answers /api/health, which needs an "
            "identity token (the service is --no-allow-unauthenticated)."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Where to write the scorecard JSON (default: stdout).",
    )
    parser.add_argument(
        "--health-url",
        default=None,
        help="Staging /api/health URL. Required with --mode staging.",
    )
    parser.add_argument(
        "--identity-token-env",
        default="THEYGROW_EVAL_IDENTITY_TOKEN",
        help=(
            "Environment variable holding the identity token for the staging health check. "
            "The owner fills it (docs/RUNBOOK.md); this command never runs gcloud."
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()

    try:
        if args.mode == "staging":
            _assert_staging_live_from_args(args)
        scorecard = run_eval(corpus_root=args.corpus, mode=args.mode)
    except (NotStagingTarget, ContourNotReady, CorpusNotUsable, StagingNotLive) as exc:
        logger.error("eval could not run (fail-closed): %s", exc)
        return 2

    document = scorecard.to_json_document()
    rendered = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True)
    if args.out is not None:
        args.out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)  # noqa: T201 - the artifact is this command's output

    total = scorecard.total
    logger.info(
        "eval complete: cases=%d passed=%d failed=%d holdout=%d/%d scope_violations=%d "
        "route_violations=%d duration_ms=%.1f",
        total.cases,
        total.passed,
        total.failed,
        total.holdout_passed,
        total.holdout_cases,
        total.scope_violations,
        total.route_violations,
        total.duration_ms,
    )
    if not scorecard.ok:
        logger.error(
            "eval FAILED: %d case(s) did not meet their recorded expectations. This is a "
            "contract-conformance regression on the synthetic corpus.",
            total.failed,
        )
        return 1
    return 0


def _assert_staging_live_from_args(args: argparse.Namespace) -> None:
    import os

    if not args.health_url:
        raise StagingNotLive("--mode staging requires --health-url")
    token = os.environ.get(args.identity_token_env, "")
    if not token:
        raise StagingNotLive(
            f"{args.identity_token_env} is empty; the staging service is private and its "
            "health check needs an identity token (docs/RUNBOOK.md, staging contour)."
        )
    assert_staging_live(args.health_url, token)


if __name__ == "__main__":  # pragma: no cover - module CLI shim
    raise SystemExit(main())
