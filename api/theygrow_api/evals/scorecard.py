"""A2-P3 — the eval scorecard: a §4-safe, counts-only run artifact.

**What this measures.** Contract conformance on a FIXED SYNTHETIC corpus
(``api/corpus/staging/``) with an in-perimeter, authored-similarity embedder and an
in-perimeter policy answers provider: that a change did not break retrieval fusion,
note-only eligibility, community scoping, the grounding gate, or honest degradation.

**What it does not measure, and cannot.** Russian lexical recall. Embedder semantic
quality. Answer faithfulness. The dense leg's similarity here is *authored* from
``concepts.json``, not learned, so nothing scored against this corpus transfers to the real
embedder — the corpus README says so and this artifact repeats it, because a JSON file
outlives the README in a reader's hands. That measurement is the M4-CLOSE mini-eval:
owner-run, against the REAL corpus, with cleared real providers. It gates the two named
port-out triggers (``M4-DL-001`` ``'simple'`` FTS -> ``'russian'``/ParadeDB; ``M4-DL-004``
``ef_search``), and nothing this artifact contains bears on either.

That is why the document carries ``not_measured`` and ``port_out_triggers_unaffected``
fields, and why no field here is named ``recall``, ``recall_at_k``, ``precision``,
``hit_rate``, ``mrr``, ``ndcg``, ``accuracy``, ``quality`` or ``score``. A JSON artifact
produced by a job called "eval" carrying a field called "recall" IS the evidence somebody
would later cite for a port-out; the naming is a guard, not decoration.

§4 (AGENTS.md): the artifact carries ``case_id`` values, bounded check names, counts and
timings ONLY. Never query text, never chunk text, never ``community_id`` — and never
``chunk_id``, because a synthetic id like ``sm-alpha-0067#3`` still names its community by
substring. ``case_id`` maps back to ``evals/queries.py`` in source, so a failure stays
debuggable with strictly less identifying content than a chunk id would carry.

The eval's refusal to run against a non-staging database (``evals/runner.py``) is what
keeps that guarantee meaningful: the seed's contour guard protects writes, this one
protects the artifact. "It only reads" is precisely the reasoning that would later justify
removing it, so it is written down here rather than assumed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from theygrow_api.evals.queries import CASE_CLASSES, LABELED_SET_VERSION
from theygrow_api.signals import EvalScorecard, SignalSink

__all__ = [
    "SCORECARD_SCHEMA_VERSION",
    "CaseResult",
    "ClassScore",
    "Scorecard",
    "emit_scorecard",
]

#: Structure version of the JSON document below. Bumped when the document's SHAPE changes
#: — a field added or removed — never when a run's numbers change.
SCORECARD_SCHEMA_VERSION = 1

#: The roll-up label. Not a case class; the bounded-label domain is CASE_CLASSES + this,
#: mirroring RetrievalLatency's leg="fused" alongside its per-leg emissions.
TOTAL_LABEL = "total"

#: Restated in the artifact so a stored scorecard cannot be read as more than it is.
_NOT_MEASURED = ("russian_lexical_recall", "embedder_semantic_quality", "answer_faithfulness")

#: Deliberately searchable: anyone grepping these ids to justify a port-out lands on the
#: denial rather than on an inferred metric.
_PORT_OUT_TRIGGERS_UNAFFECTED = ("M4-DL-001", "M4-DL-004")


@dataclass(frozen=True)
class CaseResult:
    """One labeled case's outcome. ``failed_checks`` are bounded check names, not prose."""

    case_id: str
    case_class: str
    holdout: bool
    passed: bool
    failed_checks: tuple[str, ...] = field(default_factory=tuple)
    scope_violations: int = 0
    route_violations: int = 0


@dataclass(frozen=True)
class ClassScore:
    """Aggregated counts for one case class (or the ``"total"`` roll-up)."""

    case_class: str
    cases: int
    passed: int
    holdout_cases: int
    holdout_passed: int
    scope_violations: int
    route_violations: int
    duration_ms: float

    @property
    def failed(self) -> int:
        return self.cases - self.passed


@dataclass(frozen=True)
class Scorecard:
    """One eval run, aggregated. ``ok`` is the gate: every case passed, no leak."""

    results: tuple[CaseResult, ...]
    classes: tuple[ClassScore, ...]
    total: ClassScore
    corpus_chunks: int
    corpus_communities: int
    mode: str

    @property
    def ok(self) -> bool:
        """Binary and structural: all cases pass, zero scope leaks, zero route leaks.

        Not a tunable rate. There is no threshold knob on the config surface, on purpose:
        ``RuntimeParameters`` is env-overridable under ``THEYGROW_PARAM_``, so a pass-rate
        knob would mean one stray environment variable turns this gate off, which is the
        same not-fail-closed hole ``L2-DL-002`` rejected for the staging marker
        (``L2-DL-003``). The trigger that would reverse that: the first genuinely
        non-binary, tunable threshold — a soft gate with a configurable value — lands in
        ``parameters.py`` with ``changed_in`` provenance and the schema-version bump that
        implies.
        """
        return (
            self.total.passed == self.total.cases
            and self.total.scope_violations == 0
            and self.total.route_violations == 0
        )

    def to_json_document(self) -> dict[str, object]:
        """The §4-safe artifact: counts, bounded labels, and the disclaimer."""
        return {
            "schema_version": SCORECARD_SCHEMA_VERSION,
            "labeled_set_version": LABELED_SET_VERSION,
            "mode": self.mode,
            "ok": self.ok,
            "measures": "contract-conformance",
            "not_measured": list(_NOT_MEASURED),
            "port_out_triggers_unaffected": list(_PORT_OUT_TRIGGERS_UNAFFECTED),
            "corpus": {
                "root": "api/corpus/staging",
                "chunks": self.corpus_chunks,
                "communities": self.corpus_communities,
                "synthetic": True,
            },
            "embedder": "local-deterministic",
            "answers": "local-scripted",
            "third_party_provider_calls": 0,
            "totals": _class_document(self.total),
            "classes": [_class_document(c) for c in self.classes],
            "failures": [
                {
                    "case_id": r.case_id,
                    "case_class": r.case_class,
                    "holdout": r.holdout,
                    "failed_checks": list(r.failed_checks),
                }
                for r in self.results
                if not r.passed
            ],
        }


def _class_document(score: ClassScore) -> dict[str, object]:
    return {
        "case_class": score.case_class,
        "cases": score.cases,
        "passed": score.passed,
        "failed": score.failed,
        "holdout_cases": score.holdout_cases,
        "holdout_passed": score.holdout_passed,
        "scope_violations": score.scope_violations,
        "route_violations": score.route_violations,
        "duration_ms": round(score.duration_ms, 3),
    }


def summarize(
    results: tuple[CaseResult, ...],
    *,
    durations_ms: dict[str, float],
    total_duration_ms: float,
    corpus_chunks: int,
    corpus_communities: int,
    mode: str,
) -> Scorecard:
    """Aggregate per-case results into per-class scores plus the roll-up.

    Every declared case class gets a row even when it holds no cases, so a class silently
    disappearing from the labeled set shows up as ``cases: 0`` rather than as a missing
    line nobody notices.
    """
    classes = tuple(
        _score_for(case_class, results, durations_ms.get(case_class, 0.0))
        for case_class in CASE_CLASSES
    )
    total = _score_for(TOTAL_LABEL, results, total_duration_ms, all_cases=True)
    return Scorecard(
        results=results,
        classes=classes,
        total=total,
        corpus_chunks=corpus_chunks,
        corpus_communities=corpus_communities,
        mode=mode,
    )


def _score_for(
    label: str,
    results: tuple[CaseResult, ...],
    duration_ms: float,
    *,
    all_cases: bool = False,
) -> ClassScore:
    rows = results if all_cases else tuple(r for r in results if r.case_class == label)
    holdouts = tuple(r for r in rows if r.holdout)
    return ClassScore(
        case_class=label,
        cases=len(rows),
        passed=sum(1 for r in rows if r.passed),
        holdout_cases=len(holdouts),
        holdout_passed=sum(1 for r in holdouts if r.passed),
        scope_violations=sum(r.scope_violations for r in rows),
        route_violations=sum(r.route_violations for r in rows),
        duration_ms=duration_ms,
    )


def emit_scorecard(scorecard: Scorecard, sink: SignalSink) -> None:
    """Emit one ``EVAL_SCORECARD`` signal per case class, plus the ``"total"`` roll-up.

    A pure function over an already-computed :class:`Scorecard` so the emitter is drivable
    without a seeded 295-chunk contour — which is what lets the wired-producer gate
    (``M4-P3-INV-003``, ``api/tests/test_signal_emitters.py``) cover this kind at all.
    """
    for score in (*scorecard.classes, scorecard.total):
        sink.emit(
            EvalScorecard(
                case_class=score.case_class,
                cases=score.cases,
                passed=score.passed,
                failed=score.failed,
                holdout_cases=score.holdout_cases,
                holdout_passed=score.holdout_passed,
                scope_violations=score.scope_violations,
                route_violations=score.route_violations,
                duration_ms=score.duration_ms,
            )
        )
