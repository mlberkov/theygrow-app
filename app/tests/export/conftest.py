"""Fixtures for the export-contour suite (L1-P3)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from .harness import build_artifact, seeded_store


@pytest.fixture
def store() -> Iterator[sqlite3.Connection]:
    """A store carrying the frozen schema and the fixture family."""
    conn = seeded_store()
    yield conn
    conn.close()


@pytest.fixture
def artifact(store: sqlite3.Connection, tmp_path: Path) -> bytes:
    """The artifact bytes, built by the shipped builder from the fixture family."""
    return build_artifact(store, tmp_path)
