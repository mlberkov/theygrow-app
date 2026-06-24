"""M4-P1 — parameters-as-data: the typed, versioned configuration surface.

Layered over the M2 infra ``Settings`` (``config.py``): ``Settings`` binds *infra*
(``database_url``, ``log_level``); THIS surface holds *product / algorithm* knobs as
data, each with value provenance, so a later read-only "current parameters + when they
changed" view is built by RENDERING ``current_parameters()`` — not by code archaeology
(M4-DL-002). This is data shape + a decision-log trace only: NO UI, endpoint, write-admin,
or auth.

Two provenance axes, deliberately ORTHOGONAL (M4-DL-002):
  * ``PARAMETERS_SCHEMA_VERSION`` — the SURFACE-STRUCTURE version. It bumps when the
    registry's *shape* changes (a ``Parameter`` field added, a knob added/removed), NOT
    when a knob's *value* changes. It is NOT a substitute for ``changed_in``; the later
    render must not conflate "surface structure changed" with "this value changed".
  * ``Parameter.changed_in`` — per-knob VALUE provenance: the decision-log id that last
    set this parameter's value. The dated, human-readable history lives in the
    decision-log; the render joins ``changed_in`` -> that entry.

Parameter scope:
  * ``"schema-bound"`` — baked into a FROZEN schema artifact (e.g. ``fts_config`` in the
    ``0002`` generated-tsvector DDL and ``models.py`` ``Computed``). NOT env/runtime
    mutable: changing it is a NEW-migration event (a new revision whose DDL hardcodes the
    new literal, plus a matching surface bump), never an edit to ``0002`` nor a lone
    ``parameters.py`` edit (M4-DL-002). The link between this surface value and the real
    schema is the DRIFT GUARD in ``test_parameters`` (``information_schema``'s
    ``generation_expression`` carries this exact value).
  * ``"runtime"`` — env-overridable via ``RuntimeParameters`` (pydantic-settings), the
    same pattern as the M2 ``Settings``.

P2 (embedding model + final <=1536 dimension) and P3 (top_k / candidate_k, RRF weights)
MUST land their knobs in THIS surface and emit through the ``signals.py`` seam (M4-DL-002).

§4: this surface holds configuration only — never child data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

#: SURFACE-STRUCTURE version — orthogonal to per-parameter ``changed_in`` (M4-DL-002).
#: Bump only when the registry's shape / the ``Parameter`` descriptor changes; NEVER on a
#: value change. v2 (M4-DL-003): the ``embedding_model`` + ``embedding_dimension`` knobs
#: were added (a knob-count change, not a value change).
PARAMETERS_SCHEMA_VERSION = 2

#: Sparse-FTS text-search configuration — the SURFACE value of this knob. ``'simple'``
#: does no Russian stemming (known recall limitation, ADR-008; port-out trigger ->
#: ``'russian'`` / ParadeDB by a recall metric, M4-DL-001). SCHEMA-BOUND: the frozen
#: ``0002`` DDL and ``models.py`` ``Computed`` hardcode the literal ``'simple'``; this is
#: the mutable surface value; the drift guard links the two. Changing it is a new-migration
#: event (M4-DL-002).
FTS_CONFIG = "simple"

#: Per-chunk embedding dimension — the SURFACE value of this knob (ADR-011 §2,
#: FINAL = 1536). SCHEMA-BOUND: the frozen ``0003`` DDL hardcodes ``vector(1536)`` on
#: ``event_chunks.embedding`` (and ``models.EMBEDDING_DIMENSION`` mirrors the literal);
#: this is the mutable surface value, and the drift guard in ``test_parameters`` links
#: the two (the live column's ``format_type`` must read ``vector(1536)``). Changing it is
#: a new-migration event (M4-DL-002 discipline) AND a re-embed — a mixed-dimension column
#: is not indexable.
EMBEDDING_DIMENSION = 1536


ParameterScope = Literal["schema-bound", "runtime"]


@dataclass(frozen=True)
class Parameter:
    """One configuration knob rendered as data.

    ``changed_in`` is the decision-log id of the last *value* change (per-knob
    provenance), distinct from ``PARAMETERS_SCHEMA_VERSION`` (surface structure).
    """

    name: str
    value: object
    type_label: str
    scope: ParameterScope
    changed_in: str
    note: str | None = None


class RuntimeParameters(BaseSettings):
    """Env-overridable product knobs, layered over the M2 ``Settings`` pattern.

    Distinct from ``Settings`` (infra-only). Defaults live here; an operator may override
    via the environment (prefix ``THEYGROW_PARAM_``), the same discipline as ``Settings``.
    """

    model_config = SettingsConfigDict(env_prefix="THEYGROW_PARAM_", env_file=None, extra="ignore")

    #: Default candidate cap for the sparse FTS leg when a caller passes no explicit limit.
    sparse_candidate_limit: int = 20

    #: Embedder model id (M4-P2 / ADR-011 §1). Default is the donor model,
    #: MRL-truncated to ``EMBEDDING_DIMENSION``. Env-overridable, BUT "runtime" here
    #: means swappable-WITH-BACKFILL: changing it against already-populated rows
    #: requires a re-embed (a mixed-model HNSW index is incoherent), and the new
    #: provider must be ZDR + DPA + EU-residency-bound (an operational precondition).
    embedding_model: str = "text-embedding-3-large"


def current_parameters() -> tuple[Parameter, ...]:
    """The current parameter set as data — the shape a later read-only view RENDERS.

    A pure accessor (reads env-bound runtime values only); NOT a view/endpoint. P2/P3 add
    their knobs here (M4-DL-002).
    """
    runtime = RuntimeParameters()
    return (
        Parameter(
            name="fts_config",
            value=FTS_CONFIG,
            type_label="str",
            scope="schema-bound",
            changed_in="M4-DL-001",
            note=(
                "PostgreSQL FTS config for the sparse leg. 'simple' = no Russian stemming "
                "(known recall limitation, ADR-008); port-out trigger -> 'russian' / "
                "ParadeDB by a recall metric. Schema-bound: changing it is a new-migration "
                "event."
            ),
        ),
        Parameter(
            name="sparse_candidate_limit",
            value=runtime.sparse_candidate_limit,
            type_label="int",
            scope="runtime",
            changed_in="M4-DL-002",
            note="Default candidate cap for the sparse FTS leg when no explicit limit is passed.",
        ),
        Parameter(
            name="embedding_model",
            value=runtime.embedding_model,
            type_label="str",
            scope="runtime",
            changed_in="M4-DL-003",
            note=(
                "Embedder model behind the provider-port (ADR-011 §1), MRL-truncated to "
                "embedding_dimension. Runtime/env-overridable, but swappable-WITH-BACKFILL: "
                "changing it against populated rows requires a re-embed (a mixed-model index "
                "is incoherent), and the provider must be ZDR+DPA+EU-residency-bound."
            ),
        ),
        Parameter(
            name="embedding_dimension",
            value=EMBEDDING_DIMENSION,
            type_label="int",
            scope="schema-bound",
            changed_in="M4-DL-003",
            note=(
                "Per-chunk embedding dimension (ADR-011 §2, FINAL=1536). Schema-bound: frozen "
                "as vector(1536) in the 0003 event_chunks.embedding DDL; changing it is a "
                "new-migration event AND a re-embed. The drift guard links this surface value "
                "to the live column type."
            ),
        ),
    )
