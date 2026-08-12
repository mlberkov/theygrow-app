"""Fixtures for the native-store schema tests (L1-P2).

The helpers live in `harness.py`; only the fixtures live here, because pytest
discovers fixtures from conftest modules and nowhere else.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator

import pytest

from .harness import apply_schema, connect


@pytest.fixture
def store() -> Iterator[sqlite3.Connection]:
    """An empty store with the schema applied, foreign keys enforced."""
    conn = connect()
    apply_schema(conn)
    yield conn
    conn.close()
