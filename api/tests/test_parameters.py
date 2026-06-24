"""M4-P1 delta — parameters-as-data config surface.

Unit coverage of the surface shape + per-parameter provenance, plus the DB-backed DRIFT
GUARD that links the schema-bound ``fts_config`` surface value to the FROZEN generated
tsvector DDL (the single surface<->schema enforcement; M4-DL-002). ``PARAMETERS_SCHEMA_VERSION``
is the surface-structure version, orthogonal to per-parameter ``changed_in``.
"""

from __future__ import annotations

import pytest
from sqlalchemy import Connection, text

from theygrow_api.parameters import (
    FTS_CONFIG,
    PARAMETERS_SCHEMA_VERSION,
    Parameter,
    current_parameters,
)


def _by_name() -> dict[str, Parameter]:
    return {p.name: p for p in current_parameters()}


def test_schema_version_is_int() -> None:
    assert isinstance(PARAMETERS_SCHEMA_VERSION, int)


def test_fts_config_is_schema_bound_with_provenance() -> None:
    fts = _by_name()["fts_config"]
    assert fts.value == "simple"
    assert fts.scope == "schema-bound"
    assert fts.changed_in == "M4-DL-001"
    assert "port-out" in (fts.note or "")


def test_sparse_limit_is_runtime_with_its_own_provenance() -> None:
    limit = _by_name()["sparse_candidate_limit"]
    assert limit.scope == "runtime"
    # Per-parameter changed_in: distinct from fts_config's — the default value was
    # established by the operability delta, not the base packet.
    assert limit.changed_in == "M4-DL-002"
    assert isinstance(limit.value, int)


def test_sparse_limit_is_env_overridable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THEYGROW_PARAM_SPARSE_CANDIDATE_LIMIT", "7")
    assert _by_name()["sparse_candidate_limit"].value == 7


def test_fts_config_surface_matches_frozen_schema_ddl(connection: Connection) -> None:
    # DRIFT GUARD: the live generated-column DDL must carry the surface's fts_config value.
    # If someone bumps the surface without a matching migration, this fails (M4-DL-002).
    expr = connection.execute(
        text(
            "SELECT generation_expression FROM information_schema.columns "
            "WHERE table_name = 'event_chunks' AND column_name = 'chunk_text_tsv'"
        )
    ).scalar_one()
    assert FTS_CONFIG in expr
    assert f"to_tsvector('{FTS_CONFIG}'" in expr
