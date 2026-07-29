"""SQLAlchemy engine factory — the first real DB connection from product code.

The engine is built lazily from ``Settings.database_url`` (the env-driven,
default-less value validated since M2-P2). No connection is opened at import
time; ``create_engine`` only dials when a consumer first asks for a connection.

The driver is normalized to ``postgresql+psycopg`` (psycopg3) regardless of the
scheme the environment supplies, so callers can keep the canonical
``postgresql://`` form in ``DATABASE_URL`` (e.g. the dev compose value) without
encoding the Python driver into infra config.

Privacy (AGENTS.md §4): ``echo`` stays off so bound parameters — which carry
child PII (``raw_text``, identifiers) — never reach stdout/logs.

Two engine lifecycles live here since A3-P2, and they are deliberately NOT the same
function (A3-DL-002):

  * ``create_db_engine`` / ``get_engine`` — the ORIGINAL, unchanged: one engine per RUN,
    built and disposed by an offline CLI or by ``alembic/env.py``. A process that exits
    when its job is done must not inherit a long-lived pool.
  * ``create_served_engine`` / ``served_engine`` — A3-P2: ONE process-cached engine for
    the deployed FastAPI service, with an explicitly bounded pool. Its size is not a
    comfort setting: ``db_pool_size`` x Cloud Run ``--max-instances`` must fit inside the
    application role's ``CONNECTION LIMIT``, with headroom left for the owner's Cloud SQL
    Auth Proxy sessions and migration runs (docs/RUNBOOK.md "Production database
    enablement"). The knobs are rendered in ``parameters.py``.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import URL, make_url

from theygrow_api.config import get_settings
from theygrow_api.parameters import RuntimeParameters

_PSYCOPG_DRIVER = "postgresql+psycopg"


def engine_url(database_url: str) -> URL:
    """Normalize a connection string to the psycopg3 driver URL.

    Accepts either ``postgresql://`` or an already-qualified
    ``postgresql+<driver>://`` form and pins the driver to ``psycopg`` (v3).
    """
    return make_url(database_url).set(drivername=_PSYCOPG_DRIVER)


def create_db_engine(database_url: str) -> Engine:
    """Build a SQLAlchemy ``Engine`` for the given connection string.

    Opens no connection here; ``echo=False`` keeps PII out of logs (§4).
    """
    return create_engine(engine_url(database_url), echo=False, future=True)


def get_engine() -> Engine:
    """Construct a per-run engine from the process environment (offline-CLI seam)."""
    return create_db_engine(get_settings().database_url)


def create_served_engine(database_url: str) -> Engine:
    """Build the DEPLOYED service's engine, with an explicitly bounded pool (A3-P2).

    Opens no connection here — like ``create_db_engine``, it only dials when a consumer
    first asks. ``echo=False`` keeps PII out of logs (§4).

    ``pool_pre_ping`` is hardcoded ``True`` and is deliberately NOT a knob: with it off, a
    connection the server has already recycled makes readiness report a false negative.
    That is a correctness setting, not a tuning choice. Everything else comes from the
    versioned parameter surface, where the ceiling arithmetic is recorded.
    """
    params = RuntimeParameters()
    return create_engine(
        engine_url(database_url),
        echo=False,
        future=True,
        pool_size=params.db_pool_size,
        max_overflow=params.db_max_overflow,
        pool_timeout=params.db_pool_timeout_seconds,
        pool_recycle=params.db_pool_recycle_seconds,
        pool_pre_ping=True,
        connect_args={"connect_timeout": params.db_connect_timeout_seconds},
    )


@lru_cache(maxsize=1)
def served_engine() -> Engine:
    """The deployed service's process-cached engine (A3-P2).

    Cached so the pool is shared across requests rather than rebuilt per request — a
    per-request engine would make ``db_pool_size`` meaningless and blow past the role's
    ``CONNECTION LIMIT``. Construction is LAZY: ``Settings`` is read on the first
    readiness request, never at import time, which is what keeps liveness environment-free.

    Raises whatever ``Settings()`` raises when ``DATABASE_URL`` is absent or unusable; the
    readiness path turns that into the ``config_invalid`` failure class.
    """
    return create_served_engine(get_settings().database_url)
