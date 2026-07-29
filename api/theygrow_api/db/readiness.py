"""A3-P2 — readiness probe: the first DB-touching behaviour of the DEPLOYED service.

``GET /api/health/ready`` (``main.py``) is the only caller in product code. The probe does
exactly one thing per request — borrow a connection from the process-cached engine and run
``SELECT 1`` — because nothing rate-limits the path in front of it: the route is reachable
anonymously from the internet through the PWA's same-origin proxy, so per-request work is a
cost multiplier. The bound is structural rather than defensive: ``db_max_overflow = 0`` makes
the per-process connection ceiling hard, and ``db_pool_timeout_seconds`` turns an excess
request into the ordinary 503 instead of a pile-up (``parameters.py``).

Privacy (AGENTS.md §4), and the reason this module logs nothing itself:

  * The HTTP body carries a fixed status enum and NOTHING else — no instance name, no driver
    version, no timings, and above all no exception text, on either path.
  * Diagnosis rides the signal instead, as two BOUNDED labels: ``outcome`` (mirroring the
    body's enum) and ``failure_class``, which says *where* it failed. ``failure_class`` is
    derived from which control-flow branch was taken — never from an exception — because
    psycopg/SQLAlchemy connection errors carry the host, the user and the socket path.
  * Consequently the ``except`` clauses here bind nothing and re-raise nothing. Swallowing the
    exception object is the point: there is no path by which its text can reach a sink.

That matters more than usual for this packet: the production socket URL form is exercised for
the first time by the owner smoke, with no staging contour to rehearse it on, so
``failure_class`` is the only thing that distinguishes "the secret's value is wrong" from
"the Cloud SQL attachment is missing" from "the role cannot query" (docs/RUNBOOK.md,
"Production database enablement").
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from sqlalchemy import Engine, text

from theygrow_api.db.engine import served_engine
from theygrow_api.signals import ReadinessProbe, SignalSink, default_sink

#: Bounded ``failure_class`` label values. CLOSED by construction: every value is a literal
#: in this module and none is derived from an exception, a URL or the environment.
FAILURE_NONE = "none"
FAILURE_CONFIG_INVALID = "config_invalid"
FAILURE_CONNECT_FAILED = "connect_failed"
FAILURE_QUERY_FAILED = "query_failed"

#: The complete label set — asserted closed by ``A3-P2-INV-001``.
FAILURE_CLASSES = frozenset(
    {FAILURE_NONE, FAILURE_CONFIG_INVALID, FAILURE_CONNECT_FAILED, FAILURE_QUERY_FAILED}
)

#: Bounded ``outcome`` label values; they mirror the HTTP body's status enum exactly, so a
#: log line and a response correlate without a mapping table.
OUTCOME_READY = "ready"
OUTCOME_UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class ReadinessResult:
    """The probe's verdict: a boolean for the status code, a bounded class for the signal."""

    ready: bool
    failure_class: str


def _emit(sink: SignalSink, failure_class: str, started_at: float) -> ReadinessResult:
    """Emit the one signal and return the verdict. The single emission point."""
    ready = failure_class == FAILURE_NONE
    sink.emit(
        ReadinessProbe(
            outcome=OUTCOME_READY if ready else OUTCOME_UNAVAILABLE,
            failure_class=failure_class,
            latency_ms=(time.perf_counter() - started_at) * 1000.0,
        )
    )
    return ReadinessResult(ready=ready, failure_class=failure_class)


def probe_readiness(engine: Engine, sink: SignalSink | None = None) -> ReadinessResult:
    """Borrow a connection from ``engine`` and run ``SELECT 1``.

    Distinguishes the dial from the query so the emitted ``failure_class`` is actionable:
    ``connect_failed`` points at the socket path, the attachment or the role's ability to log
    in; ``query_failed`` points past all of those, at the connected session itself.
    """
    sink = sink if sink is not None else default_sink()
    started_at = time.perf_counter()
    try:
        connection = engine.connect()
    except Exception:
        return _emit(sink, FAILURE_CONNECT_FAILED, started_at)
    try:
        with connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        return _emit(sink, FAILURE_QUERY_FAILED, started_at)
    return _emit(sink, FAILURE_NONE, started_at)


def check_readiness(sink: SignalSink | None = None) -> ReadinessResult:
    """Environment-facing entry point: resolve the served engine, then probe it.

    Building the engine is where ``Settings`` is constructed, so a missing or unusable
    ``DATABASE_URL`` — the shape a rollback to an unattached revision produces — lands as
    ``config_invalid`` rather than as an unhandled 500.
    """
    sink = sink if sink is not None else default_sink()
    started_at = time.perf_counter()
    try:
        engine = served_engine()
    except Exception:
        return _emit(sink, FAILURE_CONFIG_INVALID, started_at)
    return probe_readiness(engine, sink=sink)
