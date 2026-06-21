"""Provider-port stub: a structural impl satisfies the Protocol (no engine wiring)."""

from theygrow_api.ports.provider import MemoryProvider


class _FakeProvider:
    def health(self) -> bool:
        return True


def test_fake_satisfies_provider_port() -> None:
    provider: MemoryProvider = _FakeProvider()
    assert isinstance(provider, MemoryProvider)  # runtime_checkable Protocol
    assert provider.health() is True
