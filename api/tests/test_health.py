"""Health endpoint: 200, structured body, no PII."""

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
