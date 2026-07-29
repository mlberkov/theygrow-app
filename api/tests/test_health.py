"""Health endpoint: 200, structured body, no PII, and no environment.

A3-P2-INV-001 (a): liveness stays environment-free. The exact body below is also asserted by
the eval runner's ``--health-url`` probe (``evals/runner.py::assert_staging_live``) and by both
promotion smokes, so it is frozen in three places at once — readiness got its own route rather
than a key here.
"""

import pytest
from fastapi.testclient import TestClient

from theygrow_api.logging import PII_FIELDS
from theygrow_api.main import create_app


def test_health_returns_structured_ok() -> None:
    client = TestClient(create_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"status": "ok", "service": "theygrow-api"}


def test_health_body_carries_no_pii_fields() -> None:
    client = TestClient(create_app())
    body = client.get("/api/health").json()
    for field in PII_FIELDS:
        assert field not in body


def test_health_is_env_free_and_answers_without_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A3-P2-INV-001 (a). This is the route that keeps answering after a rollback to a
    revision with no Cloud SQL attachment and no DATABASE_URL — liveness must never acquire a
    database dependency, or the promotion gate loses its only signal that a revision is up."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    resp = TestClient(create_app()).get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "theygrow-api"}
