"""M3-P1 — episodic source layer: source_messages.

Creates the raw, pre-enrichment source table mirroring the v1 ``/export`` wire
contract (M3-DL-001) plus the M3-owned derived columns (ADR-004 dual-timestamp,
persona stub, reserved <=1536 embedding shell). Enables the pgvector extension
so the reserved vector column type resolves; builds NO vector index (M4).

Revision ID: 0001
Revises:
Create Date: 2026-06-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op
from theygrow_api.db.models import EMBEDDING_DIM_CEILING, ROUTE_KINDS

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ROUTE_CHECK = "detected_route IN (" + ", ".join(f"'{r}'" for r in ROUTE_KINDS) + ")"


def upgrade() -> None:
    # Portable to managed prod (Cloud SQL), where the dev init-pgvector.sql does
    # not run. Idempotent; the dev compose pre-enables it.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "source_messages",
        # v1 wire fields (engine-faithful types: all identifiers TEXT).
        sa.Column("source_message_id", sa.Text(), nullable=False),
        sa.Column("community_id", sa.Text(), nullable=False),
        sa.Column("author_user_id", sa.Text(), nullable=False),
        sa.Column("external_chat_id", sa.Text(), nullable=False),
        sa.Column("external_user_id", sa.Text(), nullable=False),
        sa.Column("external_message_id", sa.Text(), nullable=False),
        # BIGINT (not the engine's INTEGER): edit_seq can be an epoch (overflows
        # int32). Deliberate divergence from the engine baseline DDL.
        sa.Column("edit_seq", sa.BigInteger(), nullable=False),
        sa.Column("raw_text", sa.Text(), nullable=False),
        sa.Column("detected_route", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # Derived / reserved (ADR-004 dual-timestamp; persona stub; vector shell).
        sa.Column("valid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("persona_id", sa.Text(), nullable=True),
        # Reserved <=1536 CEILING shell — unwritten and unindexed in M3; the exact
        # dimension is finalized at M4 with the provider/model. Not a freeze.
        sa.Column("embedding", Vector(EMBEDDING_DIM_CEILING), nullable=True),
        sa.PrimaryKeyConstraint("source_message_id", name="pk_source_messages"),
        sa.UniqueConstraint(
            "community_id",
            "external_chat_id",
            "external_message_id",
            "edit_seq",
            name="uq_source_messages_assertion_key",
        ),
        sa.CheckConstraint(_ROUTE_CHECK, name="ck_source_messages_detected_route"),
    )


def downgrade() -> None:
    # Drop the table only; the vector extension is left in place (it may be
    # shared and is cheap to keep).
    op.drop_table("source_messages")
