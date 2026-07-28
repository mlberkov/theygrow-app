"""A2-P3 — in-perimeter scripted answers provider (eval pipeline only).

An ``AnswersProvider`` that answers **inside the perimeter**: no network, no client, no
clock, no filesystem. It exists so the eval pipeline can drive the whole grounded-ask
contour while ``answers_privacy_cleared`` stays unset and the run makes ZERO third-party
provider calls (ADR-020 / ADR-014). It declares that structurally via
``performs_no_egress = True``, which is what ``ports.provider.performs_no_egress`` reads
to decide whether the per-egress clearance gate applies at all — the answers-side twin of
``adapters/embeddings/local_deterministic.py``.

**The declaration grants no clearance.** It removes the answers egress surface for this
one provider; the real adapter's path is untouched and still fail-closed, and owner
clearance for the answers residency surface remains an open prerequisite (see
``services/query_service`` module docstring).

**This is not a model.** It is a POLICY — a pure function of the prompt it was handed —
deliberately not a per-case script. A per-case script whose ``cited_chunk_ids`` were the
eval's expected ids would make a retrieval miss surface as a fabricated citation, so one
root cause would paint two case classes red and send the reader to the wrong leg. A
policy citing only what the prompt actually offered keeps the two legs independent.

What driving the answers leg through this provider therefore DOES prove, all of it
mechanical: that ``build_answer_prompt`` really renders every offered ``chunk_id`` into
the prompt; that ``parse_structured_answer``'s closed-corpus citation check runs against a
real ``AssembledContext`` built from real rows; that every branch of the service's
uncertainty-marker grading is reachable — including ``parse_failure`` and
``provider_unavailable``, which no live model can be made to produce on demand; that
provenance maps citations back to the right rows in citation order; and that the grounding
gate makes zero calls below the bar.

What it proves NOTHING about: answer quality, faithfulness, or whether a real model would
declare uncertainty where this policy is told to. The answer text here is our own string.
"""

from __future__ import annotations

import json
import re
from typing import Literal

from theygrow_api.adapters.answers.openai_client import AnswersProviderUnavailable
from theygrow_api.ports.provider import AnswerResponse

#: The chunk_id rendering ``context_assembler.build_answer_prompt`` emits, one per offered
#: segment. Parsed rather than injected so this provider sees exactly what a real model
#: would see — if the prompt stops carrying chunk_ids, this provider stops citing, which
#: is precisely the drift ``PromptContractError`` below exists to make loud.
_CHUNK_ID_RE = re.compile(r"^- chunk_id=(\S+) ", re.MULTILINE)

#: The placeholder ``build_answer_prompt`` renders when there are no chunks at all. Its
#: presence means "legitimately empty", as opposed to "the rendering changed".
_NO_CHUNKS_MARKER = "(no chunks retrieved)"

AnswerPolicy = Literal[
    "cite_all",
    "cite_first",
    "declare_uncertain",
    "declare_ambiguous",
    "declare_no_evidence",
    "fabricate_citation",
    "malformed_json",
    "raise_unavailable",
]

#: Which uncertainty marker each citing policy declares.
_POLICY_MARKER: dict[str, str] = {
    "cite_all": "confident",
    "cite_first": "confident",
    "declare_uncertain": "uncertain",
    "declare_ambiguous": "ambiguous",
    "declare_no_evidence": "no_evidence",
    "fabricate_citation": "confident",
}

#: The citation a ``fabricate_citation`` run emits. Deliberately not corpus-shaped: it must
#: be absent from any assembled context so the parser's closed-corpus check is what rejects
#: it, never a coincidence of ids.
_FABRICATED_CHUNK_ID = "not-a-chunk-id-from-any-context#0"


class PromptContractError(RuntimeError):
    """The rendered prompt did not carry the chunk_ids this provider parses.

    Raised when a non-empty chunks block yields zero ``chunk_id=`` matches. Without it, a
    change to ``build_answer_prompt``'s rendering would silently make every policy cite
    nothing, every case would quietly re-grade to ``no_evidence``, and an eval could go
    GREEN FOR THE WRONG REASON. A named failure is the whole point.
    """


class ScriptedAnswersProvider:
    """``AnswersProvider`` that answers by policy, in-perimeter, deterministically.

    ``performs_no_egress`` is a plain class attribute rather than a method so it cannot be
    made conditional at call time: a provider either never leaves the perimeter or it does
    not get to claim this.

    ``call_count`` is the observable the eval asserts on — the grounding gate's "ZERO
    provider calls below the bar" property is only checkable against a counter.
    """

    #: Structural, checked declaration: this provider performs no network egress.
    performs_no_egress = True

    def __init__(self, policy: AnswerPolicy = "cite_all", *, answer_text: str = "ok") -> None:
        self.policy: AnswerPolicy = policy
        self.call_count = 0
        self._answer_text = answer_text

    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        """Answer per ``policy``, citing only chunk_ids the prompt actually offered."""
        self.call_count += 1

        if self.policy == "raise_unavailable":
            raise AnswersProviderUnavailable("scripted provider: simulated unavailability")

        offered = _CHUNK_ID_RE.findall(user_text)
        if not offered and _NO_CHUNKS_MARKER not in user_text:
            raise PromptContractError(
                "parsed zero chunk_ids from a non-empty chunks block — the answer-prompt "
                "rendering changed under this provider. Refusing to answer rather than "
                "silently citing nothing (which would grade every case to no_evidence)."
            )

        if self.policy == "malformed_json":
            return AnswerResponse(raw_text="{not json at all", total_tokens=0)

        if self.policy == "fabricate_citation":
            cited = [_FABRICATED_CHUNK_ID]
        elif self.policy == "declare_no_evidence":
            # The one marker the parser permits with an empty citation list.
            cited = []
        elif self.policy == "cite_first":
            cited = offered[:1]
        else:
            cited = list(offered)

        payload = {
            "answer_text": self._answer_text,
            "cited_chunk_ids": cited,
            "uncertainty": _POLICY_MARKER[self.policy],
        }
        return AnswerResponse(raw_text=json.dumps(payload, ensure_ascii=False), total_tokens=0)
