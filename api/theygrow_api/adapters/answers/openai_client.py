"""M4-P4 — OpenAI answers/chat adapter (donor lift; ADR-005 §7: transfer, not rewrite).

A concrete ``AnswersProvider`` behind the provider-port (``ports/provider.py``). The donor
``adapters/answers/openai_client.py`` is transferred here; the model is a config knob
(``parameters.answers_model``), so the port stays swappable.

Faithful Slice-4.5 contour: ``chat.completions.create`` with
``response_format={"type": "json_object"}`` and ``temperature=0`` (deterministic, structured
JSON the assembler's parser validates). The donor's resilience/retry module is NOT lifted
(consistent with the M4-P2 embeddings adapter — bounded retry/backoff is deferred); a provider
failure raises ``AnswersProviderUnavailable`` once and the query service grades it as a single
``provider_unavailable`` degradation (no retry, no repair).

Perimeter (ADR-005 / ADR-014): the OpenAI SDK is a *provider* dependency, not the
``diary-memory-service`` engine — there is no ``memory_rag`` import here. This adapter DOES
send the assembled ``chunk_text`` context to the chat model (the second permitted egress),
admitted only because that text leaves the perimeter under the owner-cleared ZDR + DPA + EU
residency surface; ``base_url`` pins that residency-bound endpoint and the query service gates
on ``answers_privacy_cleared`` before constructing this adapter or sending any text.

§4: this adapter sends context text to the model (a permitted egress) but logs nothing —
callers keep text out of logs/telemetry.
"""

from __future__ import annotations

from theygrow_api.ports.provider import AnswerResponse


class AnswersProviderUnavailable(RuntimeError):
    """The answers provider is unreachable / unusable for this call (ADR-015).

    Raised on timeout, HTTP failure, auth failure, or any condition that prevents
    producing a usable ``AnswerResponse``. ``query_service.answer_query`` catches it once
    and grades the call as a ``provider_unavailable`` degradation — no retry, no repair.
    """


class OpenAIAnswersProvider:
    """``AnswersProvider`` over the OpenAI chat API (residency-bound endpoint).

    ``base_url`` selects the ZDR + DPA + EU-residency endpoint; ``model`` is the swappable
    config knob (``parameters.answers_model``).
    """

    def __init__(self, *, api_key: str, base_url: str, model: str) -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url)
        self._model = model

    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        """Send the rendered prompt -> the model's raw answer JSON + token usage.

        Translates any OpenAI SDK / timeout error to ``AnswersProviderUnavailable`` so the
        query service's single ``provider_unavailable`` degradation path handles failures.
        """
        import openai

        try:
            response = self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": system_text},
                    {"role": "user", "content": user_text},
                ],
                response_format={"type": "json_object"},
                temperature=0,
            )
        except (openai.OpenAIError, TimeoutError) as exc:
            raise AnswersProviderUnavailable(
                f"OpenAI answers call failed: {type(exc).__name__}: {exc}"
            ) from exc

        raw_text = response.choices[0].message.content or ""
        usage = response.usage
        total_tokens = usage.total_tokens if usage is not None else 0
        return AnswerResponse(raw_text=raw_text, total_tokens=total_tokens)
