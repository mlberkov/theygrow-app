"""Episodic source-layer ORM (ADR-008 store; M3-DL-001 wire contract).

``SourceMessage`` mirrors the line-verified v1 ``/export`` record (M3-DL-001):
the 10 flat wire fields, with engine-faithful types (all identifiers are TEXT,
matching the engine's own ``source_messages`` baseline DDL), plus the derived
columns M3 owns. This is the raw, pre-enrichment layer — notes/chunks/embeddings
are re-derived app-side at M4, never imported (M3-DL-001 §2).

Scope guardrails (this model lands schema only; the importer is M3-P2):
  * No embedding is written in M3. ``embedding`` is a reserved, nullable shell;
    it is NOT indexed here (M4 populates it and builds the HNSW index).
  * Persona resolution is a stub seam (``persona_id`` nullable, no FK, no person
    table). The real person model is gated (PDR-002 OQ#3, post-M5).
"""

from __future__ import annotations

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Full RouteKind wire-value set (lowercase), verified against the engine enum
# (memory_rag.core.routing.RouteKind). Only `note` and `draft` ever reach an
# exported record today (M3-DL-001 §5); the other 8 are admitted defensively so
# a forward-compatible export cannot be rejected at the storage boundary. The
# engine's own source_messages CHECK is a stale 7-value list — theygrow tracks
# the current 10-value enum on purpose.
ROUTE_KINDS: tuple[str, ...] = (
    "start",
    "help",
    "note",
    "ask",
    "draft",
    "drafts",
    "export",
    "sources",
    "clarify",
    "unknown",
)

# pgvector dimension is a CEILING placeholder, not a frozen dimension. ADR-008
# caps embeddings at <=1536 (HNSW-indexable); the exact dimension is finalized
# at M4 with the provider/model choice (a provider-port parameter). M3 writes no
# embeddings, so the ceiling satisfies the invariant; narrowing this shell at M4
# is a cheap ALTER on an all-NULL column.
EMBEDDING_DIM_CEILING = 1536


class Base(DeclarativeBase):
    """Declarative base; ``Base.metadata`` is the migration autogen target."""


class SourceMessage(Base):
    """One raw inbound message-state from the engine ``/export`` corpus.

    Idempotency (M3-DL-001 §3): the engine-minted ``source_message_id`` is the
    primary natural key; ``(community_id, external_chat_id, external_message_id,
    edit_seq)`` is the composite assertion key. ``edit_seq`` is significant —
    distinct edit-states are distinct rows and must never be collapsed.
    """

    __tablename__ = "source_messages"

    # --- v1 wire fields (M3-DL-001 §1; engine-faithful types) ---
    source_message_id: Mapped[str] = mapped_column(Text, primary_key=True)
    community_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_chat_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_message_id: Mapped[str] = mapped_column(Text, nullable=False)
    # BIGINT, not the engine's INTEGER: edit_seq is 0 for an original or the
    # edit_date epoch otherwise, which overflows int32 (epoch-ms now; epoch-s by
    # 2038). Deliberate divergence from the engine baseline DDL.
    edit_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    detected_route: Mapped[str] = mapped_column(Text, nullable=False)
    # Engine ingestion wall-clock (UTC-aware), NOT the diary event date.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # --- derived / reserved columns M3 owns (ADR-004 dual-timestamp) ---
    # valid_at := created_at, set by the M3-P2 importer (provenance-faithful
    # default-with-limitation; true event-date recovery is deferred — raw_text is
    # retained so backfill stays possible). No server default: it is per-row.
    valid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # recorded_at = DB transaction time (when theygrow-app wrote the row).
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Persona-resolution stub seam: importer leaves NULL in M3 (no FK, no person
    # table). The real person model is gated (PDR-002 OQ#3, post-M5).
    persona_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Reserved <=1536 ceiling shell — unwritten and unindexed in M3 (see
    # EMBEDDING_DIM_CEILING). M4 finalizes the dimension and builds the HNSW index.
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(EMBEDDING_DIM_CEILING), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "community_id",
            "external_chat_id",
            "external_message_id",
            "edit_seq",
            name="uq_source_messages_assertion_key",
        ),
        CheckConstraint(
            "detected_route IN (" + ", ".join(f"'{route}'" for route in ROUTE_KINDS) + ")",
            name="ck_source_messages_detected_route",
        ),
    )
