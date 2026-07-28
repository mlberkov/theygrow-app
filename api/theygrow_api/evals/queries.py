"""A2-P3 — the labeled query set, frozen as code.

Every case is one query against the synthetic staging corpus plus the expectations that
query must satisfy. The set IS the baseline: expectations are recorded per case, so a run
is compared against what was authored, never against an absolute aggregate number and
never against a separately recorded score file. A separate re-recordable baseline was
rejected deliberately — "re-record until green" is the affordance this gate exists to
remove (``L2-DL-003``).

**Authoring rule.** Every expectation is decidable from committed data — the corpus text
under ``api/corpus/staging/`` and its ``concepts.json`` lexicon — never harvested from a
runner output. Where an exact id set is genuinely underivable it is NOT asserted: 66
eligible chunks carry the token ``сон`` and ``ts_rank_cd`` ties across nearly all of them,
so "which ids land in ``top_k``" is decided by RRF against the dense leg, and writing those
ids down would be a transcription of current behaviour dressed as a specification. Those
cases carry PREDICATES instead (result count, leg provenance, term/concept coverage) at
bounds deliberately looser than the observed values, so a tie shuffle is not a false alarm
while a leg dropping out still is. Exact ids are reserved for cases whose match set is
complete or unique.

**No case here is reachable only via stemming.** Every lexical case queries a surface form
present verbatim in the corpus, because ``FTS_CONFIG`` is ``'simple'`` and does no Russian
morphological stemming. A red lexical case is therefore a fusion / scoping / eligibility
regression — it is NEVER evidence about ``FTS_CONFIG``, and it does not bear on the
``'simple'`` -> ``'russian'`` / ParadeDB port-out trigger (``M4-DL-001``) or on ``ef_search``
(``M4-DL-004``). Both remain gated on a recall metric against the REAL corpus with cleared
real providers, which is the M4-CLOSE mini-eval and is not this.

**Holdout.** One case per class carries ``holdout=True``. They exist to detect fitting to
the set: if a future packet tunes a retrieval knob (``candidate_k``, the RRF weights,
``FTS_CONFIG``) to turn a red case green, the holdout cases must pass unchanged and
UNEDITED in the same commit. They are gated identically to the rest — a reported-only
holdout would manufacture a class of silent failures — and reported separately so the
distinction survives into the artifact. **Holdout cases are not to be edited to make a run
green.** Any change to this set at all bumps :data:`LABELED_SET_VERSION`.

§4: the query strings and expected ids here describe an authored-fiction corpus and live in
source. They never reach the scorecard artifact, which carries ``case_id`` and counts only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Literal

from theygrow_api.adapters.answers.local_scripted import AnswerPolicy

__all__ = [
    "LABELED_SET",
    "LABELED_SET_VERSION",
    "CASE_CLASSES",
    "CaseClass",
    "LabeledQuery",
]

#: Bumped on ANY change to the set below — an added case, a removed case, a changed
#: expectation. The scorecard carries it so a stored artifact names the set it scored.
LABELED_SET_VERSION = 1

CaseClass = Literal[
    "lexical-hit",
    "semantic-only-hit",
    "no-evidence",
    "ambiguous",
    "cross-community-isolation",
    "draft-unreachable",
]

#: The six classes the A2-P2 corpus was built to support, in the order the corpus README
#: tabulates them. Used as the scorecard's bounded ``case_class`` label domain.
CASE_CLASSES: tuple[CaseClass, ...] = (
    "lexical-hit",
    "semantic-only-hit",
    "no-evidence",
    "ambiguous",
    "cross-community-isolation",
    "draft-unreachable",
)


@dataclass(frozen=True)
class LabeledQuery:
    """One labeled case: a query, and every expectation it must satisfy.

    The optional fields are independent predicates; a ``None`` / empty one is simply not
    checked. Four properties are deliberately NOT expressible here because they are
    checked on EVERY case unconditionally — every returned chunk belongs to the queried
    community, every returned chunk is note-route, provenance is a subset of what was
    retrieved, and provenance preserves citation order. Those are structural, and a
    per-case opt-in would be a way to forget them.
    """

    case_id: str
    case_class: CaseClass
    community_id: str
    query_text: str
    answer_policy: AnswerPolicy
    expect_degradation: str | None
    expect_answers_calls: int
    holdout: bool = False

    #: Inclusive ``note_date`` bound handed to both legs (used by the grounding-gate case).
    date_range_start: date | None = None
    date_range_end: date | None = None

    #: Ids that MUST appear in the fused top_k / MUST NOT appear at all.
    must_contain_chunk_ids: tuple[str, ...] = field(default_factory=tuple)
    must_exclude_chunk_ids: tuple[str, ...] = field(default_factory=tuple)

    #: Result-count predicates (exact / floor).
    expect_result_count: int | None = None
    min_results: int | None = None

    #: Coverage: how many returned chunks must carry at least one of the given terms.
    #: ``coverage_concept`` names a key in the corpus lexicon and supplies its surface
    #: forms as the term set; ``coverage_terms`` gives literal forms directly.
    coverage_terms: tuple[str, ...] = field(default_factory=tuple)
    coverage_concept: str | None = None
    min_results_covered: int | None = None

    #: Leg provenance. ``expect_no_sparse_leg`` asserts EVERY hit has ``sparse_rank is
    #: None`` — the load-bearing assertion for a semantic-only case, since it is what
    #: proves the lexical leg could not have found the hit.
    expect_no_sparse_leg: bool = False
    min_results_from_sparse_leg: int | None = None


# ---------------------------------------------------------------------------------------
# The set. Grouped by class; the last case of each class is its holdout.
# ---------------------------------------------------------------------------------------

_LEXICAL: tuple[LabeledQuery, ...] = (
    # Unique match set: 'лестнице приставным' AND-matches exactly one eligible alpha chunk,
    # so the id is structural rather than rank-dependent.
    LabeledQuery(
        case_id="lex-001",
        case_class="lexical-hit",
        community_id="comm-staging-alpha",
        query_text="лестнице приставным",
        must_contain_chunk_ids=("sm-alpha-0004#1",),
        min_results=1,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="lex-002",
        case_class="lexical-hit",
        community_id="comm-staging-alpha",
        query_text="отменили прогулку",
        must_contain_chunk_ids=("sm-alpha-0020#1",),
        min_results=1,
        answer_policy="cite_first",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    # The competition case: a surplus of eligible matches, truncated to top_k. Ids are NOT
    # asserted (see the module docstring); the predicates are that the fused result is full,
    # that the lexical leg genuinely contributed, and that the results carry the token.
    # Bounds are 8, below the observed 10, so a tie shuffle is not a false alarm.
    LabeledQuery(
        case_id="lex-003",
        case_class="lexical-hit",
        community_id="comm-staging-alpha",
        query_text="сон",
        expect_result_count=10,
        coverage_terms=("сон",),
        min_results_covered=8,
        min_results_from_sparse_leg=8,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="lex-004",
        case_class="lexical-hit",
        community_id="comm-staging-alpha",
        query_text="врач назначил полоскание",
        must_contain_chunk_ids=("sm-alpha-0018#1", "sm-alpha-0059#2"),
        min_results=2,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
        holdout=True,
    ),
)

# The five reserved probe terms: each is in concepts.json and in NO corpus text, so the
# sparse leg CANNOT match and only the dense leg can find anything. `expect_no_sparse_leg`
# is what makes that a semantic-only case rather than an assertion about ranking.
_SEMANTIC: tuple[LabeledQuery, ...] = (
    LabeledQuery(
        case_id="sem-001",
        case_class="semantic-only-hit",
        community_id="comm-staging-alpha",
        query_text="дрёма",
        min_results=1,
        expect_no_sparse_leg=True,
        coverage_concept="sleep",
        min_results_covered=8,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="sem-002",
        case_class="semantic-only-hit",
        community_id="comm-staging-alpha",
        query_text="жар",
        min_results=1,
        expect_no_sparse_leg=True,
        coverage_concept="illness",
        min_results_covered=8,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="sem-003",
        case_class="semantic-only-hit",
        community_id="comm-staging-alpha",
        query_text="лепет",
        min_results=1,
        expect_no_sparse_leg=True,
        coverage_concept="speech",
        min_results_covered=8,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="sem-004",
        case_class="semantic-only-hit",
        community_id="comm-staging-alpha",
        query_text="равновесие",
        min_results=1,
        expect_no_sparse_leg=True,
        coverage_concept="motor",
        min_results_covered=8,
        answer_policy="declare_uncertain",
        expect_degradation="weak_evidence",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="sem-005",
        case_class="semantic-only-hit",
        community_id="comm-staging-alpha",
        query_text="каприз",
        min_results=1,
        expect_no_sparse_leg=True,
        coverage_concept="emotion",
        min_results_covered=8,
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
        holdout=True,
    ),
)

# Two distinct honest-degradation contours live here, and they are NOT the same mechanism.
#  * gamma is off-topic household texture: retrieval DOES return its chunks (neither leg has
#    a similarity threshold — the dense leg always returns its nearest rows), so the honest
#    outcome is the MODEL declaring no_evidence and the answer being suppressed.
#  * an empty query and an empty date window return nothing, so the PRE-provider grounding
#    gate fires and the answers provider is never called at all.
# Asserting both is the point: "no evidence" must be honest in both shapes.
_NO_EVIDENCE: tuple[LabeledQuery, ...] = (
    LabeledQuery(
        case_id="nev-001",
        case_class="no-evidence",
        community_id="comm-staging-gamma",
        query_text="первые шаги и первые слова",
        expect_result_count=10,
        answer_policy="declare_no_evidence",
        expect_degradation="no_evidence",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="nev-002",
        case_class="no-evidence",
        community_id="comm-staging-gamma",
        query_text="когда прорезался первый зуб",
        expect_result_count=10,
        answer_policy="declare_no_evidence",
        expect_degradation="no_evidence",
        expect_answers_calls=1,
    ),
    # Empty query: short-circuits before any embed, any DB round trip, any provider call.
    LabeledQuery(
        case_id="nev-003",
        case_class="no-evidence",
        community_id="comm-staging-alpha",
        query_text="   ",
        expect_result_count=0,
        answer_policy="cite_all",
        expect_degradation="no_evidence",
        expect_answers_calls=0,
    ),
    # A real query over a date window entirely outside the corpus span (2024-06-15 …
    # 2026-06-11): both legs return nothing, so the grounding gate degrades with ZERO
    # answers calls and no client built.
    LabeledQuery(
        case_id="nev-004",
        case_class="no-evidence",
        community_id="comm-staging-alpha",
        query_text="сон",
        date_range_start=date(2020, 1, 1),
        date_range_end=date(2020, 12, 31),
        expect_result_count=0,
        answer_policy="cite_all",
        expect_degradation="no_evidence",
        expect_answers_calls=0,
    ),
    LabeledQuery(
        case_id="nev-005",
        case_class="no-evidence",
        community_id="comm-staging-gamma",
        query_text="сколько слов говорит",
        expect_result_count=10,
        answer_policy="declare_no_evidence",
        expect_degradation="no_evidence",
        expect_answers_calls=1,
        holdout=True,
    ),
)

# amb-001 is the corpus's designed conflict: two records each claiming a FIRST utterance of
# the same word, on different dates. The rest are the same claim repeated across dates.
# In every case both/all competing chunks must surface TOGETHER — surfacing one and
# dropping the other is what silently resolves an ambiguity the corpus does not resolve.
_AMBIGUOUS: tuple[LabeledQuery, ...] = (
    LabeledQuery(
        case_id="amb-001",
        case_class="ambiguous",
        community_id="comm-staging-alpha",
        query_text="впервые произнёс слово мама",
        must_contain_chunk_ids=("sm-alpha-0067#0", "sm-alpha-0068#0"),
        min_results=2,
        answer_policy="declare_ambiguous",
        expect_degradation="ambiguous",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="amb-002",
        case_class="ambiguous",
        community_id="comm-staging-alpha",
        query_text="Ночной сон без пробуждений",
        must_contain_chunk_ids=("sm-alpha-0014#0", "sm-alpha-0032#0", "sm-alpha-0050#0"),
        answer_policy="declare_ambiguous",
        expect_degradation="ambiguous",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="amb-003",
        case_class="ambiguous",
        community_id="comm-staging-alpha",
        query_text="Сон под шум дождя",
        must_contain_chunk_ids=("sm-alpha-0016#0", "sm-alpha-0034#0", "sm-alpha-0052#0"),
        answer_policy="declare_ambiguous",
        expect_degradation="ambiguous",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="amb-004",
        case_class="ambiguous",
        community_id="comm-staging-alpha",
        query_text="Уложила в восемь, сон пришёл минут через десять",
        must_contain_chunk_ids=("sm-alpha-0017#0", "sm-alpha-0035#0", "sm-alpha-0053#0"),
        answer_policy="declare_ambiguous",
        expect_degradation="ambiguous",
        expect_answers_calls=1,
        holdout=True,
    ),
)

# Each query targets text that exists VERBATIM in more than one community. The twin's id is
# in must_exclude, so a community-scope regression is a named failure rather than an
# unnoticed extra row. (The runner also checks scope on every case unconditionally; these
# cases are the ones where a leak is actually reachable.)
_ISOLATION: tuple[LabeledQuery, ...] = (
    LabeledQuery(
        case_id="iso-001",
        case_class="cross-community-isolation",
        community_id="comm-staging-alpha",
        query_text="Первый раз скатился с горки сам, без поддержки",
        must_contain_chunk_ids=("sm-alpha-0043#2",),
        must_exclude_chunk_ids=("sm-beta-0001#0",),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="iso-002",
        case_class="cross-community-isolation",
        community_id="comm-staging-beta",
        query_text="Первый раз скатился с горки сам, без поддержки",
        must_contain_chunk_ids=("sm-beta-0001#0",),
        must_exclude_chunk_ids=("sm-alpha-0043#2",),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="iso-003",
        case_class="cross-community-isolation",
        community_id="comm-staging-gamma",
        query_text="Приезжала бабушка, привезла банки с вареньем",
        must_contain_chunk_ids=("sm-gamma-0001#0",),
        must_exclude_chunk_ids=("sm-alpha-0071#0",),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="iso-004",
        case_class="cross-community-isolation",
        community_id="comm-staging-alpha",
        query_text="Гуляли во дворе полтора часа",
        must_contain_chunk_ids=("sm-alpha-0011#1",),
        must_exclude_chunk_ids=("sm-beta-0011#1",),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
        holdout=True,
    ),
)

# drf-001/002 query tokens that occur ONLY in draft records, so the answer must never
# contain them. drf-003/004 are the sharper form: the queried text exists in BOTH note and
# draft records, so the note copies must surface while the draft twins stay unreachable —
# a filter that silently stopped applying would show up here and nowhere else.
_DRAFT: tuple[LabeledQuery, ...] = (
    LabeledQuery(
        case_id="drf-001",
        case_class="draft-unreachable",
        community_id="comm-staging-alpha",
        query_text="аквариум",
        must_exclude_chunk_ids=("sm-alpha-0099#0",),
        answer_policy="declare_no_evidence",
        expect_degradation="no_evidence",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="drf-002",
        case_class="draft-unreachable",
        community_id="comm-staging-alpha",
        query_text="телескоп",
        must_exclude_chunk_ids=("sm-alpha-0100#0",),
        answer_policy="declare_no_evidence",
        expect_degradation="no_evidence",
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="drf-003",
        case_class="draft-unreachable",
        community_id="comm-staging-alpha",
        query_text="Пазл из шести деталей собрал без подсказок",
        must_contain_chunk_ids=("sm-alpha-0024#1", "sm-alpha-0038#2"),
        must_exclude_chunk_ids=("sm-alpha-0084#1", "sm-alpha-0089#1", "sm-alpha-0094#1"),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
    ),
    LabeledQuery(
        case_id="drf-004",
        case_class="draft-unreachable",
        community_id="comm-staging-alpha",
        query_text="Собрал башню из кубиков в семь этажей",
        must_contain_chunk_ids=("sm-alpha-0006#1", "sm-alpha-0020#2", "sm-alpha-0051#1"),
        must_exclude_chunk_ids=(
            "sm-alpha-0081#1",
            "sm-alpha-0086#1",
            "sm-alpha-0091#1",
            "sm-alpha-0096#1",
        ),
        answer_policy="cite_all",
        expect_degradation=None,
        expect_answers_calls=1,
        holdout=True,
    ),
)

LABELED_SET: tuple[LabeledQuery, ...] = (
    *_LEXICAL,
    *_SEMANTIC,
    *_NO_EVIDENCE,
    *_AMBIGUOUS,
    *_ISOLATION,
    *_DRAFT,
)
