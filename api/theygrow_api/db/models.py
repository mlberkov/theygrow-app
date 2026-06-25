"""Episodic source-layer ORM (ADR-008 store; M3-DL-001 wire contract).

``SourceMessage`` mirrors the line-verified v1 ``/export`` record (M3-DL-001):
the 10 flat wire fields, with engine-faithful types (all identifiers are TEXT,
matching the engine's own ``source_messages`` baseline DDL), plus the derived
columns M3 owns. This is the raw, pre-enrichment layer — notes/chunks/embeddings
are re-derived app-side at M4, never imported (M3-DL-001 §2).

Scope guardrails:
  * No embedding lives on this table. The M3 per-message reserved shell was
    DROPPED at M4-P2 (migration ``0003``): ADR-011 §3 fixed per-CHUNK
    granularity, so the dense vector lives on ``event_chunks`` (the donor
    ``embedding_records.chunk_id`` analogue), and an unwritten per-message column
    would only misread as "messages are embeddable" (M4-DL-003).
  * Persona resolution is a stub seam (``persona_id`` nullable, no FK, no person
    table). The real person model is gated (PDR-002 OQ#3, post-M5).
"""

from __future__ import annotations

from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import TSVECTOR
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

# pgvector dimension CEILING placeholder used by the M3 ``0001`` migration (kept
# so that immutable migration still imports). ADR-008 caps embeddings at <=1536
# (HNSW-indexable). M4-P2 finalized the exact dimension at ``EMBEDDING_DIMENSION``
# below (== this ceiling); the M3 reserved shell that used this constant is
# dropped in ``0003``.
EMBEDDING_DIM_CEILING = 1536

# FINAL per-chunk embedding dimension (ADR-011 §2 / M4-DL-003): the embedder is
# ``text-embedding-3-large`` MRL-truncated to 1536. SCHEMA-BOUND: frozen as the
# literal ``vector(1536)`` in the ``0003`` DDL on ``event_chunks.embedding``. The
# MUTABLE surface value lives in ``parameters.EMBEDDING_DIMENSION``; the
# surface<->schema link is the drift guard in ``test_parameters`` (not a shared
# import). Changing the dimension is a NEW-migration event (M4-DL-002 discipline).
EMBEDDING_DIMENSION = 1536

# Per-chunk embedding-progress states (M4-P1 lifts the engine's reserved
# ``embedding_status`` discriminator). M4-P1 writes only ``pending`` — the
# embedding step (provider call + status flip to ``ready`` / ``failed``) is
# M4-P2 (gated: fork a). This is the chunk-layer analogue of M3's reserved
# embedding shell.
EMBEDDING_STATUSES: tuple[str, ...] = ("pending", "ready", "failed")

# NOTE on FTS config: the sparse-leg text-search config ('simple', a faithful donor lift;
# ADR-005 §7) is SCHEMA-BOUND — it is frozen into the generated tsvector DDL below (and in
# migration 0002) as a literal, because a generated column is a schema artifact. The
# MUTABLE surface value lives in `theygrow_api.parameters.FTS_CONFIG`; the surface<->schema
# link is the drift guard in test_parameters (not a shared import). Changing the FTS config
# is a NEW-migration event, never an edit to this literal alone (M4-DL-002).


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
    # NOTE: the M3 reserved per-message ``embedding`` shell was DROPPED at M4-P2
    # (migration ``0003``); the dense vector is per-chunk on ``event_chunks``
    # (ADR-011 §3; M4-DL-003).

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


class Note(Base):
    """One logical note re-derived from a single ``source_messages`` row (M4-P1).

    Lifted from the engine domain model (``memory_rag.core.domain.models.Note``;
    ADR-005 §7). ``note_id`` is deterministic (``= source_message_id``) so the
    offline re-derivation pass is idempotent — the engine mints fresh UUIDs
    inline at ingest, but theygrow re-derives a batch over already-imported rows
    (M4-DL-001). ``note_date`` is the recovered event date (first ISO line of
    ``raw_text``) or, in the fallback case, ``created_at`` (M4-DL-001).
    """

    __tablename__ = "notes"

    note_id: Mapped[str] = mapped_column(Text, primary_key=True)
    source_message_id: Mapped[str] = mapped_column(
        Text, ForeignKey("source_messages.source_message_id"), nullable=False
    )
    community_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    note_date: Mapped[date] = mapped_column(Date, nullable=False)
    note_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class EventChunk(Base):
    """One event line; ``chunk -> note -> source`` lineage preserved (M4-P1).

    Lifted from the engine domain model + baseline DDL
    (``memory_rag.core.domain.models.EventChunk``; ADR-005 §7). ``chunk_id`` is
    deterministic (``f"{source_message_id}#{event_index}"``) for idempotent
    re-derivation (M4-DL-001). ``chunk_text_tsv`` is a GENERATED STORED tsvector
    over ``chunk_text`` (config ``FTS_CONFIG``) backing the sparse FTS leg's GIN
    index; it is DB-maintained and excluded from INSERTs. ``embedding`` is the
    per-chunk dense vector (M4-P2 / ADR-011 §3, the donor
    ``embedding_records.chunk_id`` analogue); ``embedding_status`` discriminates
    its population (``pending`` -> ``ready`` / ``failed``). The HNSW index is
    built by the offline backfill AFTER bulk population (M4-DL-003), so it is not
    declared on the model.
    """

    __tablename__ = "event_chunks"

    chunk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    note_id: Mapped[str] = mapped_column(Text, ForeignKey("notes.note_id"), nullable=False)
    source_message_id: Mapped[str] = mapped_column(
        Text, ForeignKey("source_messages.source_message_id"), nullable=False
    )
    community_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    note_date: Mapped[date] = mapped_column(Date, nullable=False)
    event_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    embedding_status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    # Per-chunk dense embedding — vector(1536), nullable until the offline backfill
    # populates it and flips ``embedding_status`` to ``ready`` (``failed`` on a
    # provider error). The dimension is the frozen-schema literal EMBEDDING_DIMENSION
    # (the surface value lives in parameters.EMBEDDING_DIMENSION; drift guard links
    # them). No HNSW index here — the backfill builds it after bulk population (M4-DL-003).
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(EMBEDDING_DIMENSION), nullable=True
    )
    # Generated, DB-maintained sparse-FTS vector (donor lift). Read-only; SQLAlchemy
    # excludes Computed columns from INSERTs. The 'simple' config is a FROZEN-schema
    # literal (NOT parameters.FTS_CONFIG): the drift guard in test_parameters links it to
    # the surface, and a config change is a new migration (M4-DL-002).
    chunk_text_tsv: Mapped[str] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('simple', chunk_text)", persisted=True),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("event_index >= 0", name="ck_event_chunks_event_index_nonneg"),
        CheckConstraint(
            "embedding_status IN ("
            + ", ".join(f"'{status}'" for status in EMBEDDING_STATUSES)
            + ")",
            name="ck_event_chunks_embedding_status",
        ),
    )
