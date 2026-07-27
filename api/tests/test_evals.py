"""A2-P3 — the eval pipeline: labeled-set consistency, §4 artifact safety, fail-closed contour.

Four layers:

* **Labeled-set consistency** (no DB): every id the set names exists in the committed
  corpus with the route the case implies, every named concept exists in the lexicon, every
  class is represented and holds a holdout. This is what keeps the set honest independently
  of the runner — a case can be wrong about the corpus without any query ever running.
* **The scripted answers provider** (no DB): its policies, and the prompt-contract guard.
* **The scorecard artifact** (no DB): §4 safety, and the banned metric names.
* **End to end** (DB): the whole set against a seeded contour with BOTH clearance flags
  unset and zero third-party calls, plus the contour guard's refusals.

What this suite does NOT establish: Russian lexical recall, embedder semantic quality, or
answer faithfulness. The corpus is synthetic, the embedder's similarity is authored and the
answers provider is our own policy. That measurement is the M4-CLOSE mini-eval.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from sqlalchemy import Connection, delete

from theygrow_api.adapters.answers.local_scripted import (
    PromptContractError,
    ScriptedAnswersProvider,
)
from theygrow_api.adapters.embeddings.local_deterministic import (
    LocalDeterministicEmbeddingProvider,
)
from theygrow_api.config import Settings
from theygrow_api.db.models import EventChunk
from theygrow_api.domain.parser import _split_non_empty_lines, parse_note
from theygrow_api.evals.queries import CASE_CLASSES, LABELED_SET, LABELED_SET_VERSION
from theygrow_api.evals.runner import ContourNotReady, check_contour, corpus_shape, run_eval
from theygrow_api.evals.scorecard import CaseResult, Scorecard, summarize
from theygrow_api.seed_staging import load_lexicon, seed_staging

CORPUS_ROOT = Path(__file__).resolve().parents[1] / "corpus" / "staging"
EXPORTS_DIR = CORPUS_ROOT / "export-v1"

_STAGING_URL = "postgresql://user@localhost:5432/theygrow_staging"
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)

#: Metric names that must never appear in the artifact. A JSON file from a job called
#: "eval" carrying a field called "recall" IS the evidence somebody would later cite for a
#: port-out that is gated on the REAL corpus (M4-DL-001 / M4-DL-004).
_BANNED_METRIC_NAMES = (
    "recall",
    "recall_at_k",
    "precision",
    "hit_rate",
    "mrr",
    "ndcg",
    "accuracy",
    "quality",
    "score",
)


def _settings(*, url: str = _STAGING_URL) -> Settings:
    """Both clearance flags UNSET — the eval must run without either (ADR-020)."""
    return Settings(database_url=url)


def _corpus_chunk_index() -> dict[str, tuple[str, str]]:
    """chunk_id -> (community_id, detected_route), as the derivation pass would split."""
    index: dict[str, tuple[str, str]] = {}
    for path in sorted(EXPORTS_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for record in document["records"]:
            raw_text = str(record["raw_text"])
            parsed = parse_note(raw_text)
            lines = parsed.events if parsed is not None else _split_non_empty_lines(raw_text)
            for event_index in range(len(lines)):
                chunk_id = f"{record['source_message_id']}#{event_index}"
                index[chunk_id] = (
                    str(record["community_id"]),
                    str(record["detected_route"]),
                )
    return index


# --- Labeled-set consistency (no DB) ----------------------------------------


def test_every_named_chunk_id_exists_in_the_committed_corpus() -> None:
    """A typo'd id would silently weaken a case into a tautology, so it is a hard error."""
    index = _corpus_chunk_index()
    for case in LABELED_SET:
        for chunk_id in (*case.must_contain_chunk_ids, *case.must_exclude_chunk_ids):
            assert chunk_id in index, f"{case.case_id}: {chunk_id} is not in the corpus"


def test_expected_ids_are_note_route_and_in_the_queried_community() -> None:
    """A must_contain id that is draft-route, or another community's, can never be returned."""
    index = _corpus_chunk_index()
    for case in LABELED_SET:
        for chunk_id in case.must_contain_chunk_ids:
            community, route = index[chunk_id]
            assert route == "note", f"{case.case_id}: {chunk_id} is not retrievable"
            assert community == case.community_id, f"{case.case_id}: {chunk_id} is out of scope"


def test_draft_cases_actually_exclude_draft_chunks() -> None:
    """The draft-unreachable class is only meaningful if its excluded ids ARE draft-route."""
    index = _corpus_chunk_index()
    draft_cases = [c for c in LABELED_SET if c.case_class == "draft-unreachable"]
    assert draft_cases
    for case in draft_cases:
        assert case.must_exclude_chunk_ids, case.case_id
        for chunk_id in case.must_exclude_chunk_ids:
            assert index[chunk_id][1] == "draft", f"{case.case_id}: {chunk_id} is not a draft"


def test_isolation_cases_exclude_another_communitys_chunk() -> None:
    """A same-community 'excluded' id would make the isolation class prove nothing."""
    index = _corpus_chunk_index()
    for case in LABELED_SET:
        if case.case_class != "cross-community-isolation":
            continue
        assert case.must_exclude_chunk_ids, case.case_id
        for chunk_id in case.must_exclude_chunk_ids:
            assert index[chunk_id][0] != case.community_id, f"{case.case_id}: {chunk_id}"


def test_named_concepts_exist_in_the_corpus_lexicon() -> None:
    lexicon = load_lexicon(CORPUS_ROOT)
    for case in LABELED_SET:
        if case.coverage_concept is not None:
            assert case.coverage_concept in lexicon, f"{case.case_id}: {case.coverage_concept}"


def test_coverage_bounds_have_a_term_source() -> None:
    """A coverage floor with no terms to check would pass vacuously."""
    for case in LABELED_SET:
        if case.min_results_covered is not None:
            assert case.coverage_terms or case.coverage_concept is not None, case.case_id


def test_case_ids_are_unique() -> None:
    ids = [case.case_id for case in LABELED_SET]
    assert len(ids) == len(set(ids))


def test_every_class_is_covered_and_holds_a_holdout() -> None:
    """Full coverage of every class at lower per-class depth is the design; holdouts detect
    fitting to the set and must exist in every class to do that job."""
    for case_class in CASE_CLASSES:
        cases = [c for c in LABELED_SET if c.case_class == case_class]
        assert len(cases) >= 4, f"{case_class} has {len(cases)} cases"
        assert sum(1 for c in cases if c.holdout) >= 1, f"{case_class} has no holdout"


def test_adversarial_cases_are_at_least_a_fifth_of_the_set() -> None:
    """no-evidence + isolation + draft-unreachable: the classes that assert absence."""
    adversarial = {"no-evidence", "cross-community-isolation", "draft-unreachable"}
    count = sum(1 for c in LABELED_SET if c.case_class in adversarial)
    assert count * 5 >= len(LABELED_SET), f"{count}/{len(LABELED_SET)} adversarial"


def test_labeled_set_version_is_a_positive_int() -> None:
    assert isinstance(LABELED_SET_VERSION, int) and LABELED_SET_VERSION >= 1


# --- The scripted answers provider (no DB) ----------------------------------


_PROMPT = (
    "Question: alpha\n\nDiary chunks (in retrieval rank order):\n"
    "- chunk_id=sm-1#0 date=2026-01-01 event_index=0 text=alpha\n"
    "- chunk_id=sm-1#1 date=2026-01-01 event_index=1 text=beta\n"
)


def test_scripted_provider_declares_zero_egress() -> None:
    assert ScriptedAnswersProvider.performs_no_egress is True


def test_cite_all_cites_only_what_the_prompt_offered() -> None:
    provider = ScriptedAnswersProvider("cite_all")
    payload = json.loads(provider.complete("sys", _PROMPT).raw_text)
    assert payload["cited_chunk_ids"] == ["sm-1#0", "sm-1#1"]
    assert payload["uncertainty"] == "confident"
    assert provider.call_count == 1


def test_fabricated_citation_is_absent_from_any_context() -> None:
    payload = json.loads(ScriptedAnswersProvider("fabricate_citation").complete("s", _PROMPT).raw_text)
    assert payload["cited_chunk_ids"] == ["not-a-chunk-id-from-any-context#0"]


def test_prompt_contract_drift_is_a_named_failure_not_a_silent_no_evidence() -> None:
    """Without this, a rendering change would re-grade every case to no_evidence — green
    for the wrong reason."""
    with pytest.raises(PromptContractError):
        ScriptedAnswersProvider("cite_all").complete("sys", "Question: x\n\nchunks:\n- id=1 text=y")


def test_empty_chunks_placeholder_is_not_drift() -> None:
    empty = "Question: x\n\nDiary chunks (in retrieval rank order):\n(no chunks retrieved)"
    payload = json.loads(ScriptedAnswersProvider("declare_no_evidence").complete("s", empty).raw_text)
    assert payload["cited_chunk_ids"] == []


# --- The scorecard artifact (no DB) -----------------------------------------


def _sample_scorecard() -> Scorecard:
    return summarize(
        (
            CaseResult(
                case_id="iso-001",
                case_class="cross-community-isolation",
                holdout=False,
                passed=False,
                failed_checks=("must_exclude", "community_scope"),
                scope_violations=1,
            ),
            CaseResult(case_id="lex-001", case_class="lexical-hit", holdout=True, passed=True),
        ),
        durations_ms={"lexical-hit": 2.0},
        total_duration_ms=5.0,
        corpus_chunks=295,
        corpus_communities=3,
        mode="ci",
    )


def test_scorecard_carries_no_community_id_chunk_id_or_text() -> None:
    """§4: case ids and bounded check names only. A chunk_id names its community by
    substring, so it is excluded too."""
    rendered = json.dumps(_sample_scorecard().to_json_document(), ensure_ascii=False)
    for community in ("comm-staging-alpha", "comm-staging-beta", "comm-staging-gamma"):
        assert community not in rendered
    for case in LABELED_SET:
        query_text = case.query_text.strip()
        if query_text:  # nev-003 is a whitespace query — an empty needle matches anything
            assert query_text not in rendered
        for chunk_id in (*case.must_contain_chunk_ids, *case.must_exclude_chunk_ids):
            assert chunk_id not in rendered


def test_scorecard_uses_no_banned_metric_name() -> None:
    document = _sample_scorecard().to_json_document()
    rendered = json.dumps(document)
    keys = set(re.findall(r'"(\w+)":', rendered))
    for banned in _BANNED_METRIC_NAMES:
        assert banned not in keys, banned


def test_scorecard_states_what_it_does_not_measure() -> None:
    document = _sample_scorecard().to_json_document()
    assert document["measures"] == "contract-conformance"
    not_measured = document["not_measured"]
    assert isinstance(not_measured, list)
    assert "russian_lexical_recall" in not_measured
    assert document["port_out_triggers_unaffected"] == ["M4-DL-001", "M4-DL-004"]
    assert document["third_party_provider_calls"] == 0


def test_scorecard_is_not_ok_when_a_case_failed() -> None:
    scorecard = _sample_scorecard()
    assert scorecard.ok is False
    assert scorecard.total.cases == 2
    assert scorecard.total.passed == 1

    failures = scorecard.to_json_document()["failures"]
    assert isinstance(failures, list)
    assert len(failures) == 1
    assert failures[0]["case_id"] == "iso-001"
    assert failures[0]["failed_checks"] == ["must_exclude", "community_scope"]


def test_every_declared_class_gets_a_row_even_when_empty() -> None:
    """A class silently vanishing from the set must show as cases=0, not as a missing line."""
    classes = {c.case_class for c in _sample_scorecard().classes}
    assert classes == set(CASE_CLASSES)


def test_corpus_shape_is_derived_from_the_corpus_on_disk() -> None:
    shape = corpus_shape(CORPUS_ROOT)
    assert shape.chunks == 295
    assert shape.communities == 3


# --- End to end against a seeded contour (DB) -------------------------------


@pytest.fixture
def staging_marker(connection: Connection, monkeypatch: pytest.MonkeyPatch) -> str:
    """Retarget the marker at the CI database — both guard layers still run and agree."""
    actual = connection.exec_driver_sql("SELECT current_database()").scalar_one()
    monkeypatch.setattr("theygrow_api.seed_staging.STAGING_DATABASE_NAME", actual)
    return str(actual)


@pytest.fixture
def seeded_contour(connection: Connection, staging_marker: str, tmp_path: Path) -> str:
    seed_staging(
        corpus_root=CORPUS_ROOT,
        connection=connection,
        settings=_settings(url=f"postgresql://user@localhost:5432/{staging_marker}"),
        quarantine_dir=tmp_path,
    )
    return staging_marker


def test_labeled_set_passes_on_the_seeded_contour(
    connection: Connection, seeded_contour: str
) -> None:
    """The gate itself: every case passes, with BOTH clearance flags unset and zero egress."""
    scorecard = run_eval(
        corpus_root=CORPUS_ROOT,
        connection=connection,
        settings=_settings(url=f"postgresql://user@localhost:5432/{seeded_contour}"),
    )

    failures = [(r.case_id, r.failed_checks) for r in scorecard.results if not r.passed]
    assert failures == [], failures
    assert scorecard.ok is True
    assert scorecard.total.cases == len(LABELED_SET)
    assert scorecard.total.holdout_cases == scorecard.total.holdout_passed == len(CASE_CLASSES)
    assert scorecard.total.scope_violations == 0
    assert scorecard.total.route_violations == 0


def test_eval_refuses_an_unseeded_contour_before_running_a_case(
    connection: Connection, seeded_contour: str
) -> None:
    """Three classes assert ABSENCE, so an empty contour would pass them and report green."""
    connection.execute(delete(EventChunk))

    with pytest.raises(ContourNotReady):
        run_eval(
            corpus_root=CORPUS_ROOT,
            connection=connection,
            settings=_settings(url=f"postgresql://user@localhost:5432/{seeded_contour}"),
        )


def test_eval_refuses_when_stored_vectors_disagree_with_the_lexicon(
    connection: Connection, seeded_contour: str
) -> None:
    """Nothing in the database records which concepts.json produced its vectors, so a stale
    seed or an edited lexicon would silently turn the dense leg into noise."""
    lexicon = load_lexicon(CORPUS_ROOT)
    drifted = {name: forms for name, forms in lexicon.items() if name != "sleep"}

    with pytest.raises(ContourNotReady):
        check_contour(
            connection,
            corpus_root=CORPUS_ROOT,
            provider=LocalDeterministicEmbeddingProvider(drifted),
        )
