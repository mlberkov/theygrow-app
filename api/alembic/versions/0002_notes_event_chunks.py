"""M4-P1 — derived layer: notes + event_chunks (sparse FTS leg).

Re-derivation target tables, lifted from the engine (``memory_rag``) baseline
DDL (ADR-005 §7: transfer, not rewrite): one ``notes`` row + one ``event_chunks``
row per event line, with a GENERATED STORED ``chunk_text_tsv``
(``to_tsvector('simple', chunk_text)``) and a GIN index for the sparse (FTS)
retrieval leg. Both tables FK back to ``source_messages`` (and ``event_chunks``
to ``notes``) so the chunk -> note -> source lineage is enforced.

Scope guardrails (M4-P1): NO embeddings, NO vector column on ``event_chunks``,
NO HNSW / IVFFlat index. ``embedding_status`` is a reserved discriminator only.
The engine's ``embedding_records`` table (the dense leg's per-chunk vectors) is
deferred to M4-P2 (gated: provider/model + final dimension, fork a), as are the
``queries`` / ``retrieval_hits`` / ``answer_traces`` trace tables (P3/P4).

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import TSVECTOR

from alembic import op
from theygrow_api.db.models import EMBEDDING_STATUSES

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATUS_CHECK = (
    "embedding_status IN (" + ", ".join(f"'{status}'" for status in EMBEDDING_STATUSES) + ")"
)


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("note_id", sa.Text(), nullable=False),
        sa.Column("source_message_id", sa.Text(), nullable=False),
        sa.Column("community_id", sa.Text(), nullable=False),
        sa.Column("author_user_id", sa.Text(), nullable=False),
        sa.Column("note_date", sa.Date(), nullable=False),
        sa.Column("note_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("note_id", name="pk_notes"),
        sa.ForeignKeyConstraint(
            ["source_message_id"],
            ["source_messages.source_message_id"],
            name="fk_notes_source_message_id",
        ),
    )
    op.create_index("idx_notes_source_message_id", "notes", ["source_message_id"])

    op.create_table(
        "event_chunks",
        sa.Column("chunk_id", sa.Text(), nullable=False),
        sa.Column("note_id", sa.Text(), nullable=False),
        sa.Column("source_message_id", sa.Text(), nullable=False),
        sa.Column("community_id", sa.Text(), nullable=False),
        sa.Column("author_user_id", sa.Text(), nullable=False),
        sa.Column("note_date", sa.Date(), nullable=False),
        sa.Column("event_index", sa.Integer(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("embedding_status", sa.Text(), nullable=False, server_default="pending"),
        # GENERATED ALWAYS AS (...) STORED — DB-maintained, never written directly. The
        # 'simple' config is a FROZEN literal: a migration is an immutable historical
        # artifact, so a later FTS port-out (e.g. 'russian') is a NEW migration, never an
        # edit here, and a change to parameters.FTS_CONFIG must never retroactively alter
        # this DDL. The surface<->schema link is the drift guard in test_parameters (M4-DL-002).
        sa.Column(
            "chunk_text_tsv",
            TSVECTOR(),
            sa.Computed("to_tsvector('simple', chunk_text)", persisted=True),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("chunk_id", name="pk_event_chunks"),
        sa.ForeignKeyConstraint(["note_id"], ["notes.note_id"], name="fk_event_chunks_note_id"),
        sa.ForeignKeyConstraint(
            ["source_message_id"],
            ["source_messages.source_message_id"],
            name="fk_event_chunks_source_message_id",
        ),
        sa.CheckConstraint("event_index >= 0", name="ck_event_chunks_event_index_nonneg"),
        sa.CheckConstraint(_STATUS_CHECK, name="ck_event_chunks_embedding_status"),
    )
    op.create_index("idx_event_chunks_community_id", "event_chunks", ["community_id"])
    op.create_index("idx_event_chunks_source_message_id", "event_chunks", ["source_message_id"])
    # GIN over the generated tsvector — the sparse (FTS) leg's index (M4-DL-001).
    op.create_index(
        "idx_event_chunks_chunk_text_tsv",
        "event_chunks",
        ["chunk_text_tsv"],
        postgresql_using="gin",
    )


def downgrade() -> None:
    # Children first: event_chunks references notes.
    op.drop_table("event_chunks")
    op.drop_table("notes")
