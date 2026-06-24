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
    EMBEDDING_DIMENSION,
    FTS_CONFIG,
    PARAMETERS_SCHEMA_VERSION,
    Parameter,
    current_parameters,
)


def _by_name() -> dict[str, Parameter]:
    return {p.name: p for p in current_parameters()}


def test_schema_version_is_int() -> None:
    assert isinstance(PARAMETERS_SCHEMA_VERSION, int)
    # v3 (M4-DL-004): the P3 fusion knobs were added.
    assert PARAMETERS_SCHEMA_VERSION == 3


def test_every_parameter_carries_nonempty_changed_in() -> None:
    # M4-P3-INV-002 (operability, ADR-013): the surface is decision-log-traceable — every
    # rendered Parameter carries a non-empty changed_in. A new knob added without provenance
    # fails here. Enforced-only: this assertion IS the guarantee.
    params = current_parameters()
    assert params, "the parameter surface must not be empty"
    for p in params:
        assert isinstance(p.changed_in, str) and p.changed_in.strip(), (
            f"parameter {p.name!r} is missing changed_in provenance"
        )


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


def test_embedding_model_is_runtime_with_provenance() -> None:
    model = _by_name()["embedding_model"]
    assert model.scope == "runtime"
    assert model.changed_in == "M4-DL-003"
    assert isinstance(model.value, str) and model.value
    # The note records the swappable-WITH-BACKFILL contract (model swap ⇒ re-embed).
    assert "re-embed" in (model.note or "")


def test_embedding_model_is_env_overridable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THEYGROW_PARAM_EMBEDDING_MODEL", "custom-embed-model")
    assert _by_name()["embedding_model"].value == "custom-embed-model"


def test_p3_fusion_knobs_are_runtime_with_provenance() -> None:
    by = _by_name()
    for name, type_label in (
        ("candidate_k", "int"),
        ("top_k", "int"),
        ("rrf_k", "int"),
        ("rrf_dense_weight", "float"),
        ("rrf_sparse_weight", "float"),
    ):
        p = by[name]
        assert p.scope == "runtime"
        assert p.changed_in == "M4-DL-004"
        assert p.type_label == type_label
    # The candidate_k note records the cap precedence + the deliberate ef_search deferral.
    assert "ef_search" in (by["candidate_k"].note or "")
    assert by["rrf_k"].value == 60  # donor/standard default


def test_p3_fusion_knobs_are_env_overridable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THEYGROW_PARAM_CANDIDATE_K", "33")
    monkeypatch.setenv("THEYGROW_PARAM_TOP_K", "4")
    monkeypatch.setenv("THEYGROW_PARAM_RRF_DENSE_WEIGHT", "2.5")
    by = _by_name()
    assert by["candidate_k"].value == 33
    assert by["top_k"].value == 4
    assert by["rrf_dense_weight"].value == 2.5


def test_embedding_dimension_is_schema_bound_with_provenance() -> None:
    dim = _by_name()["embedding_dimension"]
    assert dim.value == EMBEDDING_DIMENSION == 1536
    assert dim.scope == "schema-bound"
    assert dim.changed_in == "M4-DL-003"


def test_embedding_dimension_surface_matches_frozen_schema_ddl(connection: Connection) -> None:
    # DRIFT GUARD (mirrors fts_config): the live event_chunks.embedding column type must
    # carry the surface's dimension. A surface bump without a matching migration fails here.
    col_type = connection.execute(
        text(
            "SELECT format_type(a.atttypid, a.atttypmod) "
            "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
            "WHERE c.relname = 'event_chunks' AND a.attname = 'embedding'"
        )
    ).scalar_one()
    assert col_type == f"vector({EMBEDDING_DIMENSION})"


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
