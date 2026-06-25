"""M4-P2 — embeddings activation: per-chunk vector column; drop the dormant shell.

Activates the dense leg's storage (ADR-011 / M4-DL-003): adds the per-chunk
``event_chunks.embedding`` ``vector(1536)`` column and DROPS the M3 dormant
per-``source_message`` ``embedding`` shell, since ADR-011 §3 fixed per-CHUNK
granularity — an unwritten per-message column would only misread as "messages are
embeddable".

Scope guardrails (M4-P2):
  * Dimension is the FROZEN literal ``vector(1536)`` (ADR-011 §2). A migration is an
    immutable historical artifact: a later dimension change is a NEW migration plus a
    matching ``parameters.EMBEDDING_DIMENSION`` bump — never an edit here, and never a
    lone ``parameters.py`` edit. The surface<->schema link is the drift guard in
    ``test_parameters`` (``format_type`` over the live column).
  * NO HNSW index here. The index is built by the offline backfill AFTER bulk
    population (M4-DL-003) — building HNSW on an all-NULL column then filling it
    row-by-row yields a worse graph.

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Per-chunk dense vector — FROZEN literal vector(1536) (see module docstring).
    op.add_column(
        "event_chunks",
        sa.Column("embedding", Vector(1536), nullable=True),
    )
    # Drop the dormant M3 per-message shell (per-chunk granularity is final; M4-DL-003).
    op.drop_column("source_messages", "embedding")


def downgrade() -> None:
    # Re-add the dormant shell (nullable, unindexed — its M3 shape) and drop the
    # per-chunk column. The backfill-built HNSW index, if present, is dropped with it.
    op.add_column(
        "source_messages",
        sa.Column("embedding", Vector(1536), nullable=True),
    )
    op.drop_column("event_chunks", "embedding")
