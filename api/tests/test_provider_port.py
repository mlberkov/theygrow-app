"""Provider-port stubs: structural impls satisfy the Protocols (no engine wiring)."""

from theygrow_api.ports.provider import AnswerResponse, AnswersProvider, MemoryProvider


class _FakeProvider:
    def health(self) -> bool:
        return True


class _FakeAnswers:
    def complete(self, system_text: str, user_text: str) -> AnswerResponse:
        return AnswerResponse(raw_text="{}", total_tokens=0)


def test_fake_satisfies_provider_port() -> None:
    provider: MemoryProvider = _FakeProvider()
    assert isinstance(provider, MemoryProvider)  # runtime_checkable Protocol
    assert provider.health() is True


def test_fake_satisfies_answers_provider_port() -> None:
    # M4-P4 (ADR-014): a structural impl satisfies AnswersProvider (strings in / response out,
    # so the port stays free of any domain import).
    provider: AnswersProvider = _FakeAnswers()
    assert isinstance(provider, AnswersProvider)  # runtime_checkable Protocol
    assert provider.complete("sys", "user").total_tokens == 0
