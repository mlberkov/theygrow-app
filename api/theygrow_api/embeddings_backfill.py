"""M4-P2 — offline embeddings backfill pass.

Populates the per-chunk dense ``event_chunks.embedding`` vector over already-derived
rows and drives ``embedding_status`` (``pending`` -> ``ready`` / ``failed``), then
builds the HNSW index once the column is populated. This is an **offline batch**
entrypoint — no ``/api`` HTTP endpoint, no live engine call (mirrors the M3 importer /
M4-P1 derivation posture; ADR-005). The embedder is reached through the provider-port
(``ports/provider.py``); the concrete adapter is the donor lift
(``adapters/embeddings/openai_client.py``).

§4 fail-closed gate (ADR-011 §1, STRUCTURAL, not prose): before any ``chunk_text`` is
read out to the embedder, the run asserts the operator-set ``embedder_privacy_cleared``
flag (the ZDR + DPA + EU-residency clearance) AND, on the real path, embedder
endpoint/key presence. With the flag unset, NO text is sent and NOTHING is written — the
run refuses (``EmbedderNotReady``) before touching the provider or the DB.

Idempotency (status-driven, NOT delete-then-insert): only ``pending`` (and, unless
``--no-retry-failed``, ``failed``) rows are selected; ``ready`` rows are skipped, so a
re-run over a fully-embedded corpus is a no-op. A provider error marks that batch
``failed`` (retried next run), never a partial vector write.

HNSW-after-backfill (M4-DL-003): the index is built AFTER bulk population, not in the
``0003`` migration — building HNSW on an all-NULL column then filling row-by-row yields a
worse graph. ``CREATE INDEX IF NOT EXISTS`` keeps the step idempotent.

Privacy (AGENTS.md §4): logs and the run summary carry counts/timings only — never
``chunk_text``; ``chunk_text`` leaves the perimeter to the embedder alone, under the
cleared residency surface.
"""

from __future__ import annotations

import argparse
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Connection, func, select, text, update

from theygrow_api.config import Settings, get_settings
from theygrow_api.db.engine import get_engine
from theygrow_api.db.models import EMBEDDING_DIMENSION, EventChunk
from theygrow_api.logging import install_pii_redaction
from theygrow_api.parameters import RuntimeParameters
from theygrow_api.ports.provider import EmbeddingProvider
from theygrow_api.signals import EmbeddingCounters, SignalSink, default_sink

logger = logging.getLogger(__name__)

#: Default rows per embedder request. A closed family corpus is small; this keeps each
#: provider round-trip bounded without overspending tokens per call.
DEFAULT_BATCH_SIZE = 128

#: HNSW index over the per-chunk vector, built after population (M4-DL-003). Cosine
#: distance: ``text-embedding-3-*`` vectors are normalized, so cosine is the donor metric.
_HNSW_INDEX_NAME = "idx_event_chunks_embedding"
_CREATE_HNSW_INDEX = (
    f"CREATE INDEX IF NOT EXISTS {_HNSW_INDEX_NAME} "
    "ON event_chunks USING hnsw (embedding vector_cosine_ops)"
)


class EmbedderNotReady(RuntimeError):
    """Fail-closed: the §4 privacy gate / embedder config precondition is unmet.

    Raised BEFORE any ``chunk_text`` is sent or any row written, so the run is a loud
    no-op rather than a silent leak (ADR-011 §1).
    """


@dataclass(frozen=True)
class EmbedSummary:
    """Counts-only outcome of a backfill run (safe to log).

    ``attempted`` = pending/failed rows selected this run; ``embedded`` / ``failed``
    partition them by provider outcome; ``skipped_ready`` = rows already ``ready`` and
    left untouched (the idempotent no-op tally); ``total_tokens`` = embedder usage.
    """

    attempted: int
    embedded: int
    failed: int
    skipped_ready: int
    total_tokens: int


def _ensure_embedder_cleared(settings: Settings) -> None:
    """§4 gate: refuse unless the operator affirmed the ZDR+DPA+EU clearance flag."""
    if not settings.embedder_privacy_cleared:
        raise EmbedderNotReady(
            "embedder_privacy_cleared is not set; refusing to send chunk_text "
            "(ADR-011 §1 ZDR+DPA+EU-residency gate). Nothing embedded, nothing written."
        )


def _build_provider(settings: Settings) -> EmbeddingProvider:
    """Construct the donor OpenAI adapter; enforce endpoint/key presence (real path)."""
    base_url = settings.embedder_base_url
    api_key = settings.embedder_api_key
    if not base_url or not api_key:
        raise EmbedderNotReady(
            "embedder endpoint/key missing; cannot reach the residency-bound embedder."
        )
    # Imported lazily so the OpenAI SDK is pulled in only on the live backfill path
    # (and never by the importer / derivation / sparse-leg imports).
    from theygrow_api.adapters.embeddings.openai_client import OpenAIEmbeddingProvider

    return OpenAIEmbeddingProvider(
        api_key=api_key,
        base_url=base_url,
        model=RuntimeParameters().embedding_model,
        dimension=EMBEDDING_DIMENSION,
    )


def _mark_failed(connection: Connection, chunk_ids: list[str]) -> None:
    connection.execute(
        update(EventChunk)
        .where(EventChunk.chunk_id.in_(chunk_ids))
        .values(embedding=None, embedding_status="failed")
    )


def _backfill(
    connection: Connection,
    provider: EmbeddingProvider,
    *,
    retry_failed: bool,
    batch_size: int,
) -> EmbedSummary:
    skipped_ready = connection.execute(
        select(func.count()).select_from(EventChunk).where(EventChunk.embedding_status == "ready")
    ).scalar_one()

    statuses = ("pending", "failed") if retry_failed else ("pending",)
    rows = connection.execute(
        select(EventChunk.chunk_id, EventChunk.chunk_text)
        .where(EventChunk.embedding_status.in_(statuses))
        .order_by(EventChunk.chunk_id)
    ).all()

    attempted = len(rows)
    embedded = 0
    failed = 0
    total_tokens = 0

    for start in range(0, attempted, batch_size):
        batch = rows[start : start + batch_size]
        chunk_ids = [r.chunk_id for r in batch]
        texts = [r.chunk_text for r in batch]
        try:
            result = provider.embed_texts(texts)
        except Exception as exc:  # provider/network failure: fail the batch, keep going.
            _mark_failed(connection, chunk_ids)
            failed += len(batch)
            logger.warning(
                "embed batch failed (%s); %d chunk(s) marked failed",
                type(exc).__name__,
                len(batch),
            )
            continue

        if len(result.vectors) != len(batch):
            # Defensive: a misaligned response could mis-assign vectors — fail the
            # whole batch rather than write a single wrong embedding.
            _mark_failed(connection, chunk_ids)
            failed += len(batch)
            logger.warning(
                "embed batch misaligned (%d texts -> %d vectors); %d chunk(s) marked failed",
                len(batch),
                len(result.vectors),
                len(batch),
            )
            continue

        total_tokens += result.total_tokens
        for chunk_id, vector in zip(chunk_ids, result.vectors, strict=True):
            connection.execute(
                update(EventChunk)
                .where(EventChunk.chunk_id == chunk_id)
                .values(embedding=vector, embedding_status="ready")
            )
        embedded += len(batch)

    # Build the HNSW index AFTER population (M4-DL-003). Idempotent; on a re-run the
    # index already exists and this is a no-op.
    connection.execute(text(_CREATE_HNSW_INDEX))

    return EmbedSummary(
        attempted=attempted,
        embedded=embedded,
        failed=failed,
        skipped_ready=skipped_ready,
        total_tokens=total_tokens,
    )


def embed_backfill(
    *,
    connection: Connection | None = None,
    sink: SignalSink | None = None,
    provider: EmbeddingProvider | None = None,
    settings: Settings | None = None,
    retry_failed: bool = True,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> EmbedSummary:
    """Embed ``pending`` (and ``failed``, unless ``retry_failed`` is False) chunks.

    Fail-closed: the ZDR+DPA+EU clearance gate runs FIRST — if unset, this raises
    ``EmbedderNotReady`` before any provider call or DB write. When ``connection`` is
    supplied the caller owns the transaction (tests); otherwise one is opened here.
    Idempotent: ``ready`` rows are skipped. One ``EMBEDDING_COUNTERS`` signal (counts +
    token cost + wall-clock) is emitted through ``sink``; §4: counts/timings only.
    """
    sink = sink if sink is not None else default_sink()
    settings = settings if settings is not None else get_settings()

    # §4 gate, BEFORE any text is read or sent.
    _ensure_embedder_cleared(settings)
    provider = provider if provider is not None else _build_provider(settings)

    started = time.perf_counter()
    if connection is not None:
        summary = _backfill(connection, provider, retry_failed=retry_failed, batch_size=batch_size)
    else:
        engine = get_engine()
        with engine.begin() as conn:
            summary = _backfill(conn, provider, retry_failed=retry_failed, batch_size=batch_size)
    duration_ms = (time.perf_counter() - started) * 1000.0

    sink.emit(
        EmbeddingCounters(
            attempted=summary.attempted,
            embedded=summary.embedded,
            failed=summary.failed,
            skipped_ready=summary.skipped_ready,
            total_tokens=summary.total_tokens,
            duration_ms=duration_ms,
        )
    )
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theygrow-embed",
        description=(
            "Offline pass: embed event_chunks behind the provider-port and build the "
            "HNSW index. Fail-closed unless EMBEDDER_PRIVACY_CLEARED is set (ADR-011 §1)."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Rows per embedder request (default: {DEFAULT_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--no-retry-failed",
        action="store_true",
        help="Embed only 'pending' rows; leave prior 'failed' rows untouched.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()

    try:
        summary = embed_backfill(retry_failed=not args.no_retry_failed, batch_size=args.batch_size)
    except EmbedderNotReady as exc:
        logger.error("embeddings backfill refused (fail-closed): %s", exc)
        return 1

    logger.info(
        "embed backfill complete: attempted=%d embedded=%d failed=%d skipped_ready=%d tokens=%d",
        summary.attempted,
        summary.embedded,
        summary.failed,
        summary.skipped_ready,
        summary.total_tokens,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - module CLI shim
    raise SystemExit(main())
