"""Config guard: required infra fields fail loudly; env binds read-only."""

import pytest
from pydantic import ValidationError

from theygrow_api.config import Settings, get_settings


def test_missing_required_env_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_reads_database_url_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://placeholder/db")
    settings = get_settings()
    assert settings.database_url == "postgresql://placeholder/db"
    assert settings.log_level == "INFO"  # non-secret knob, safe default
