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
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import URL, make_url

from theygrow_api.config import get_settings

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
    """Construct the engine from the process environment (FastAPI/CLI seam)."""
    return create_db_engine(get_settings().database_url)
