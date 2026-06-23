"""Shared fixtures for DB-backed schema tests (M3-P1).

These tests require a real Postgres (the constraints under test — PK, composite
UNIQUE, route CHECK, pgvector column — have no faithful SQLite/in-memory
equivalent). The whole DB-backed suite SKIPS when ``DATABASE_URL`` is unset or
Postgres is unreachable, so ``pytest api`` stays green in environments without
the dev compose stack; CI provides a pgvector service so the suite runs there.

The migration (``alembic upgrade head``) is applied once per session and rolled
back (``downgrade base``) at teardown — exercising the migration's reversibility.
Each test runs inside a transaction that is rolled back for data isolation.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import OperationalError

from alembic import command
from alembic.config import Config
from theygrow_api.db.engine import create_db_engine

_API_DIR = Path(__file__).resolve().parent.parent


def _alembic_config() -> Config:
    cfg = Config(str(_API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_API_DIR / "alembic"))
    return cfg


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set; DB-backed schema tests require Postgres")
    return url


@pytest.fixture(scope="session")
def migrated_engine(database_url: str) -> Iterator[Engine]:
    engine = create_db_engine(database_url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:  # pragma: no cover - env-dependent
        engine.dispose()
        pytest.skip(f"Postgres not reachable: {exc}")
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    try:
        yield engine
    finally:
        command.downgrade(cfg, "base")
        engine.dispose()


@pytest.fixture
def connection(migrated_engine: Engine) -> Iterator[Connection]:
    conn = migrated_engine.connect()
    trans = conn.begin()
    try:
        yield conn
    finally:
        trans.rollback()
        conn.close()
