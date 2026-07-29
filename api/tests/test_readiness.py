"""A3-P2 — GET /api/health/ready: route shape on both paths, §4-safety, pool policy.

A3-P2-INV-001 (b): readiness fails CLOSED and MUTE. Any failure to construct ``Settings``,
dial, or execute ``SELECT 1`` yields 503 carrying exactly ``{"status": "unavailable"}`` — no
DSN, host, user, driver text, timing or exception text in the body, and none in the
``readiness.probe`` signal either, whose payload is two bounded labels and a latency.

The DB-backed half runs against CI's pgvector service and skips elsewhere. It proves the route
and pool mechanics over TCP and NOTHING about the production socket URL form, the secret, the
Cloud SQL attachment or the IAM decision — none of which exist off Cloud Run (docs/RUNBOOK.md,
"Production database enablement", step 13).
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Iterator
from typing import cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.pool import QueuePool

from theygrow_api.db.engine import create_db_engine, create_served_engine, served_engine
from theygrow_api.db.readiness import (
    FAILURE_CLASSES,
    FAILURE_CONFIG_INVALID,
    FAILURE_CONNECT_FAILED,
    FAILURE_NONE,
    FAILURE_QUERY_FAILED,
    check_readiness,
    probe_readiness,
)
from theygrow_api.logging import PII_FIELDS, PiiRedactionFilter
from theygrow_api.main import create_app
from theygrow_api.parameters import RuntimeParameters
from theygrow_api.signals import SIGNAL_TAXONOMY, ReadinessProbe, Signal, SignalKind

#: An unreachable URL in the SOCKET form production actually uses — empty authority (``@/``)
#: plus ``?host=<socket dir>`` (docs/RUNBOOK.md, "Production database enablement", step 5).
#: Two reasons for that shape rather than a bogus hostname: it fails instantly (no DNS, no
#: TCP), and it makes the failure-path needle sweep cover the socket path, which is the most
#: sensitive string a psycopg connection error can carry. Every component below is a §4
#: needle: if exception text ever reached a body, a payload or a log record, one of them
#: would come with it.
_UNREACHABLE_URL = (
    "postgresql://appuser_n33dle:sup3rsecret@/theygrow_secret?host=/nonexistent/cloudsql/socket"
)
_URL_SECRETS = (
    "appuser_n33dle",
    "sup3rsecret",
    "theygrow_secret",
    "/nonexistent/cloudsql/socket",
    "psycopg",
)


class _RecordingSink:
    def __init__(self) -> None:
        self.signals: list[Signal] = []

    def emit(self, signal: Signal) -> None:
        self.signals.append(signal)


class _FakeConnection:
    """A connection whose statement fails — the ``query_failed`` leg."""

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(f"could not execute against {_UNREACHABLE_URL}")


class _QueryFailsEngine:
    def connect(self) -> _FakeConnection:
        return _FakeConnection()


class _ConnectFailsEngine:
    def connect(self) -> _FakeConnection:
        raise RuntimeError(f"could not connect to {_UNREACHABLE_URL}")


@pytest.fixture(autouse=True)
def _clear_served_engine_cache() -> Iterator[None]:
    """The served engine is process-cached; tests must not inherit each other's."""
    served_engine.cache_clear()
    yield
    served_engine.cache_clear()


# --- Route shape, both paths -------------------------------------------------------------


def test_ready_returns_200_and_the_ready_enum(migrated_engine: Engine) -> None:
    resp = TestClient(create_app()).get("/api/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ready"}


def test_ready_returns_503_when_the_environment_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    resp = TestClient(create_app()).get("/api/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}


def test_ready_returns_503_when_the_database_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    resp = TestClient(create_app()).get("/api/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}


def test_both_failure_paths_return_the_identical_body(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing config and a dead database are indistinguishable to the caller, by design."""
    client = TestClient(create_app())
    monkeypatch.delenv("DATABASE_URL", raising=False)
    absent = client.get("/api/health/ready").json()
    served_engine.cache_clear()
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    unreachable = client.get("/api/health/ready").json()
    assert absent == unreachable == {"status": "unavailable"}


# --- §4 safety: the body ------------------------------------------------------------------


def test_failure_body_leaks_no_dsn_host_user_or_driver_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    raw = TestClient(create_app()).get("/api/health/ready").text
    for needle in _URL_SECRETS:
        assert needle not in raw, f"{needle!r} reached the readiness body"


def test_body_is_the_status_key_alone_and_carries_no_pii_or_timing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    body = TestClient(create_app()).get("/api/health/ready").json()
    assert set(body) == {"status"}
    assert "latency_ms" not in body  # timings belong in the signal, not the response
    for field in PII_FIELDS:
        assert field not in body


def test_ready_body_is_the_status_key_alone_on_the_success_path(
    migrated_engine: Engine,
) -> None:
    body = TestClient(create_app()).get("/api/health/ready").json()
    assert set(body) == {"status"}
    for field in PII_FIELDS:
        assert field not in body


# --- §4 safety: the signal ----------------------------------------------------------------


def test_failure_class_enum_is_closed_and_never_exception_derived() -> None:
    """A3-P2-INV-001 (b): the label set is fixed; no exception-derived string reaches it.

    Both failing legs are driven by fakes whose exception text embeds the whole connection
    string, so if ``failure_class`` were derived from the exception rather than from the
    control-flow branch, the needle sweep below would find it.
    """
    sink = _RecordingSink()
    connect_failed = probe_readiness(cast(Engine, _ConnectFailsEngine()), sink=sink)
    query_failed = probe_readiness(cast(Engine, _QueryFailsEngine()), sink=sink)

    assert connect_failed.ready is False
    assert connect_failed.failure_class == FAILURE_CONNECT_FAILED
    assert query_failed.ready is False
    assert query_failed.failure_class == FAILURE_QUERY_FAILED

    for signal in sink.signals:
        payload = signal.fields()
        assert payload["failure_class"] in FAILURE_CLASSES
        assert payload["outcome"] == "unavailable"
        rendered = repr(payload)
        for needle in _URL_SECRETS:
            assert needle not in rendered, f"{needle!r} reached the readiness signal"


def test_missing_configuration_is_its_own_failure_class(monkeypatch: pytest.MonkeyPatch) -> None:
    sink = _RecordingSink()
    monkeypatch.delenv("DATABASE_URL", raising=False)
    result = check_readiness(sink=sink)
    assert result.failure_class == FAILURE_CONFIG_INVALID
    assert sink.signals[-1].fields()["failure_class"] == FAILURE_CONFIG_INVALID


def test_success_carries_the_none_failure_class(migrated_engine: Engine) -> None:
    sink = _RecordingSink()
    result = check_readiness(sink=sink)
    assert result.ready is True
    assert result.failure_class == FAILURE_NONE
    payload = sink.signals[-1].fields()
    assert payload == {"outcome": "ready", "failure_class": FAILURE_NONE, **_latency(payload)}


def _latency(payload: dict[str, object]) -> dict[str, object]:
    """The one field whose value is not fixed; asserted for type, not for value."""
    assert isinstance(payload["latency_ms"], float)
    return {"latency_ms": payload["latency_ms"]}


def test_signal_payload_matches_the_taxonomy_descriptor() -> None:
    payload = ReadinessProbe(outcome="ready", failure_class=FAILURE_NONE, latency_ms=1.5).fields()
    descriptor = SIGNAL_TAXONOMY[SignalKind.READINESS_PROBE]
    assert set(payload) == set(descriptor.field_names)
    assert isinstance(payload["outcome"], str)
    assert isinstance(payload["failure_class"], str)
    assert isinstance(payload["latency_ms"], float)


def test_the_served_app_installs_the_pii_redaction_boundary(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A signal emitted into an unconfigured logger reaches nothing.

    The served app configured no logging before A3-P2 because it emitted no signals. Now it
    does, and the default sink's §4 guarantee — "emits through the PII-guarded logging
    boundary" — is only true if ``install_pii_redaction`` ran in this process.
    """
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    with caplog.at_level(logging.INFO):
        TestClient(create_app()).get("/api/health/ready")
    probes = [r for r in caplog.records if r.getMessage() == "readiness.probe"]
    assert probes, "the readiness signal did not reach the logging boundary"
    assert probes[-1].__dict__["failure_class"] == FAILURE_CONNECT_FAILED
    assert any(isinstance(f, PiiRedactionFilter) for f in logging.getLogger().filters), (
        "the §4 redaction filter is not installed on this process's root logger"
    )


def test_readiness_logs_nothing_but_the_bounded_signal(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The failure path logs no exception text: it carries host, user and socket path."""
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    with caplog.at_level(logging.DEBUG):
        TestClient(create_app()).get("/api/health/ready")
    rendered = " ".join(
        [record.getMessage() for record in caplog.records]
        + [repr(record.__dict__) for record in caplog.records]
    )
    for needle in _URL_SECRETS:
        assert needle not in rendered, f"{needle!r} reached the logging boundary"


# --- Engine lifecycle + pool policy -------------------------------------------------------


def test_served_engine_is_process_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A per-request engine would make db_pool_size meaningless against CONNECTION LIMIT."""
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    assert served_engine() is served_engine()


def test_served_engine_pool_is_bounded_by_the_parameter_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", _UNREACHABLE_URL)
    params = RuntimeParameters()
    pool = cast(QueuePool, served_engine().pool)
    assert pool.size() == params.db_pool_size
    # The hard-ceiling half of the arithmetic: pool_size x --max-instances <= CONNECTION LIMIT
    # only holds because nothing may burst above pool_size.
    assert getattr(pool, "_max_overflow", None) == params.db_max_overflow
    assert params.db_max_overflow == 0


def test_building_the_served_engine_opens_no_connection() -> None:
    pool = cast(QueuePool, create_served_engine(_UNREACHABLE_URL).pool)
    assert pool.checkedout() == 0


def test_offline_engine_factory_keeps_its_signature_and_its_own_pool(
    database_url: str,
) -> None:
    """create_db_engine is untouched: the CLIs and alembic must not inherit the served pool."""
    assert list(inspect.signature(create_db_engine).parameters) == ["database_url"]
    engine = create_db_engine(database_url)
    try:
        assert cast(QueuePool, engine.pool).size() != RuntimeParameters().db_pool_size
    finally:
        engine.dispose()
