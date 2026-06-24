"""Concrete ``AnswersProvider`` implementations (M4-P4 grounded-ask seam).

The ``diary-memory-service`` ENGINE stays OUT of the perimeter (ADR-005): the donor
answers adapter is TRANSFERRED here, never imported. The OpenAI SDK is a *provider*
dependency, not an engine call. This adapter sends the assembled family context to the
chat/answers LLM — the second permitted egress (ADR-014), admitted only under the
owner-cleared ``answers_privacy_cleared`` residency surface, which the query service
gates on before constructing this adapter.
"""
