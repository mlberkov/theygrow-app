"""M4-P1 — offline notes/event_chunks re-derivation pass.

Re-derives the ``notes`` / ``event_chunks`` layer from already-imported
``source_messages`` rows, using the engine note parser lifted into
``theygrow_api.domain.parser`` (ADR-005 §7: transfer, not rewrite). This is an
**offline batch** entrypoint — no ``/api`` HTTP endpoint, no network, no live
engine call (mirrors the M3 importer posture; ADR-005). It populates the derived
layer only; it writes NO embeddings (M4-P2, gated: fork a).

Per live ``{note, draft}`` source message (M4-DL-001):

* ``parse_note(raw_text)`` succeeds — the first non-empty line is an ISO
  ``YYYY-MM-DD`` date: ``note_date`` := that date; events := the lines after it;
  and the recovered date reconciles ``source_messages.valid_at := note_date``
  (the recovery the M3 placeholder ``valid_at := created_at`` was waiting on,
  M3-DL-001 §4; the ``DATE`` is pinned to UTC midnight as a ``timestamptz``).
* ``parse_note`` returns ``None`` — no date-led line: **fallback** —
  ``note_date`` := ``created_at`` and EVERY non-empty line becomes an event
  chunk; ``valid_at`` keeps the M3 placeholder. This keeps every live message
  lexically searchable instead of dropping non-date-led notes (the engine
  surfaced this as ``INVALID_INPUT``). Q2 fork resolved to "fallback".

Both ``note`` and ``draft`` are derived so episodic-eligibility stays a P3
retrieval-layer concern (fork b open); P3 filters via
``event_chunks -> source_messages.detected_route``.

Idempotent (M4-DL-001): deterministic ids (``note_id = source_message_id``;
``chunk_id = f"{source_message_id}#{event_index}"``) plus a delete-then-insert
over the processed source ids make a re-run converge to the same rows. The
engine mints fresh UUIDs inline at ingest; deterministic ids are the theygrow
adaptation for an offline re-derivation pass over existing rows.

Privacy (AGENTS.md §4): logs and the run summary carry counts only — never
``raw_text`` / ``chunk_text``.
"""

from __future__ import annotations

import argparse
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any

from sqlalchemy import Connection, Row, delete, insert, select, update

from theygrow_api.db.engine import get_engine
from theygrow_api.db.models import EventChunk, Note, SourceMessage
from theygrow_api.domain.parser import _split_non_empty_lines, parse_note
from theygrow_api.logging import install_pii_redaction
from theygrow_api.signals import DerivationCounters, SignalSink, default_sink

logger = logging.getLogger(__name__)

#: Routes whose ``raw_text`` is re-derived. BOTH ``note`` and ``draft`` are
#: derived so the episodic-eligibility filter stays a P3 retrieval-layer decision
#: (fork b open). Only these routes ever reach the live source set (M3-DL-001 §5;
#: the importer quarantines the rest).
DERIVE_ROUTES = frozenset({"note", "draft"})


@dataclass(frozen=True)
class DeriveSummary:
    """Counts-only outcome of a re-derivation run (safe to log)."""

    sources_processed: int
    derived_dated: int
    derived_fallback: int
    chunks: int
    skipped_empty: int


def _live_sources(connection: Connection) -> Sequence[Row[Any]]:
    """The ``{note, draft}`` source rows to re-derive (raw fields only)."""
    return connection.execute(
        select(
            SourceMessage.source_message_id,
            SourceMessage.community_id,
            SourceMessage.author_user_id,
            SourceMessage.raw_text,
            SourceMessage.created_at,
        ).where(SourceMessage.detected_route.in_(DERIVE_ROUTES))
    ).all()


def _rederive(connection: Connection) -> DeriveSummary:
    sources = _live_sources(connection)
    source_ids = [s.source_message_id for s in sources]

    # Idempotency: clear any prior derived rows for these sources (children
    # first — event_chunks references notes), then re-insert from scratch.
    if source_ids:
        connection.execute(delete(EventChunk).where(EventChunk.source_message_id.in_(source_ids)))
        connection.execute(delete(Note).where(Note.source_message_id.in_(source_ids)))

    note_rows: list[dict[str, Any]] = []
    chunk_rows: list[dict[str, Any]] = []
    valid_at_updates: list[tuple[str, datetime]] = []
    derived_dated = 0
    derived_fallback = 0
    skipped_empty = 0

    for s in sources:
        parsed = parse_note(s.raw_text)
        if parsed is not None:
            note_date = parsed.note_date
            events = parsed.events
            recovered = True
        else:
            # Fallback (M4-DL-001): no date-led line. note_date := created_at;
            # every non-empty line is content. Same chunk-boundary semantics as
            # the parser (shared splitter), so the lift stays faithful.
            note_date = s.created_at.astimezone(UTC).date()
            events = _split_non_empty_lines(s.raw_text)
            recovered = False
            if not events:
                # raw_text carried no content at all — nothing to derive.
                skipped_empty += 1
                continue

        note_id = s.source_message_id
        note_rows.append(
            {
                "note_id": note_id,
                "source_message_id": s.source_message_id,
                "community_id": s.community_id,
                "author_user_id": s.author_user_id,
                "note_date": note_date,
                "note_text": "\n".join(events),
                "created_at": s.created_at,
            }
        )
        for index, line in enumerate(events):
            chunk_rows.append(
                {
                    "chunk_id": f"{s.source_message_id}#{index}",
                    "note_id": note_id,
                    "source_message_id": s.source_message_id,
                    "community_id": s.community_id,
                    "author_user_id": s.author_user_id,
                    "note_date": note_date,
                    "event_index": index,
                    "chunk_text": line,
                    "created_at": s.created_at,
                    # embedding_status defaults to 'pending'; chunk_text_tsv is generated.
                }
            )

        if recovered:
            derived_dated += 1
            valid_at_updates.append(
                (s.source_message_id, datetime.combine(note_date, time.min, tzinfo=UTC))
            )
        else:
            derived_fallback += 1

    if note_rows:
        connection.execute(insert(Note), note_rows)
    if chunk_rows:
        connection.execute(insert(EventChunk), chunk_rows)
    for source_message_id, recovered_valid_at in valid_at_updates:
        connection.execute(
            update(SourceMessage)
            .where(SourceMessage.source_message_id == source_message_id)
            .values(valid_at=recovered_valid_at)
        )

    return DeriveSummary(
        sources_processed=len(sources),
        derived_dated=derived_dated,
        derived_fallback=derived_fallback,
        chunks=len(chunk_rows),
        skipped_empty=skipped_empty,
    )


def rederive(
    *, connection: Connection | None = None, sink: SignalSink | None = None
) -> DeriveSummary:
    """Re-derive ``notes`` / ``event_chunks`` from imported ``source_messages``.

    When ``connection`` is supplied the caller owns the transaction (used by
    tests); otherwise a transaction is opened and committed here. Idempotent:
    re-running converges to the same derived rows. A single ``DERIVATION_COUNTERS``
    signal (the counts-only summary) is emitted through ``sink`` (default: the
    PII-guarded logging sink); §4: counts only, never ``raw_text``.
    """
    sink = sink if sink is not None else default_sink()
    if connection is not None:
        summary = _rederive(connection)
    else:
        engine = get_engine()
        with engine.begin() as conn:
            summary = _rederive(conn)
    sink.emit(
        DerivationCounters(
            sources_processed=summary.sources_processed,
            derived_dated=summary.derived_dated,
            derived_fallback=summary.derived_fallback,
            chunks=summary.chunks,
            skipped_empty=summary.skipped_empty,
        )
    )
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theygrow-rederive",
        description=("Offline pass: re-derive notes/event_chunks from imported source_messages."),
    )
    parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()

    summary = rederive()
    logger.info(
        "rederive complete: sources=%d dated=%d fallback=%d chunks=%d skipped_empty=%d",
        summary.sources_processed,
        summary.derived_dated,
        summary.derived_fallback,
        summary.chunks,
        summary.skipped_empty,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - module CLI shim
    raise SystemExit(main())
