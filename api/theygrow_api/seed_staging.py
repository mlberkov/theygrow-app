"""A2-P2 — staging seed: synthetic corpus -> staging database, contour-guarded.

Chains the three existing offline passes in one transaction — ``import_export`` ->
``rederive`` -> ``embed_backfill`` — so a staging database goes from empty to queryable
in a single command. It adds no ingestion logic of its own: every write goes through the
same code production uses, which is the point (a seeded contour that took a private path
would prove nothing about the real one).

**The guard is the reason this module exists.** ADR-020's hard rule is that staging never
holds real family data; the failure mode that rule actually dies of is an operator pasting
the wrong ``DATABASE_URL`` and seeding synthetic rows into production. So the seed refuses
unless the target database carries the staging marker, and it checks that in two
independent places:

1. **Before dialing** — the database name parsed out of ``DATABASE_URL``. Catches the
   wrong-URL paste with no connection opened at all.
2. **After connecting, before any write** — ``SELECT current_database()``. Catches the
   case where the URL's path says one thing and the connection lands somewhere else: a
   libpq ``host=``/socket override, a connection pooler, a ``search_path`` surprise. The
   first layer trusts a string; only this one asks the server.

Both layers compare against an allowlist of exactly one name, so an unrecognized or
absent database name refuses too — the guard fails closed in both directions rather than
merely blocking a known-bad list.

Zero third-party egress (ADR-020): the embeddings pass runs through the in-perimeter
``LocalDeterministicEmbeddingProvider``, so the contour makes no provider call and both
clearance flags stay unset. See ``adapters/embeddings/local_deterministic.py`` for what
that stand-in does and does not prove.

Privacy (AGENTS.md §4): the summary and every log line carry counts only — never
``raw_text`` / ``chunk_text``, never a connection string. The corpus is authored fiction,
but the code path is written as if it were not.
"""

from __future__ import annotations

import argparse
import json
import logging
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, inspect, text

from theygrow_api.adapters.embeddings.local_deterministic import (
    LocalDeterministicEmbeddingProvider,
)
from theygrow_api.config import Settings, get_settings
from theygrow_api.db.engine import engine_url, get_engine
from theygrow_api.derivation import rederive
from theygrow_api.embeddings_backfill import DEFAULT_BATCH_SIZE, embed_backfill
from theygrow_api.importer import import_export
from theygrow_api.logging import install_pii_redaction
from theygrow_api.ports.provider import EmbeddingProvider
from theygrow_api.signals import SignalSink

logger = logging.getLogger(__name__)

#: The ONLY database this seed will write to. An allowlist of one, deliberately: a
#: denylist of production names would pass every database nobody thought to name.
#:
#: Not a ``parameters.py`` knob on purpose. ``RuntimeParameters`` is env-overridable
#: under ``THEYGROW_PARAM_``, and an env-overridable safety marker is not fail-closed —
#: it would re-open, via one stray environment variable, precisely the hole this constant
#: exists to close. This is a safety constant, not a qualitative knob (ADR-013).
STAGING_DATABASE_NAME = "theygrow_staging"

#: Corpus layout under the ``--corpus`` root.
_EXPORTS_DIRNAME = "export-v1"
_LEXICON_FILENAME = "concepts.json"

#: Tables the chained passes write. Checked up front so a missing migration is a named
#: error pointing at the RUNBOOK step, not an opaque ProgrammingError mid-transaction.
_REQUIRED_TABLES = ("source_messages", "notes", "event_chunks")


class NotStagingTarget(RuntimeError):
    """Fail-closed: the target database does not carry the staging marker.

    Raised before any write — and, for the URL layer, before any connection is opened —
    so a wrong-``DATABASE_URL`` seed is a loud refusal rather than a silent write into
    somebody's real data (ADR-020).
    """


class CorpusNotUsable(RuntimeError):
    """The corpus root is missing, empty, or lacks its lexicon."""


class SchemaNotReady(RuntimeError):
    """The target database is missing the tables the seed writes."""


@dataclass(frozen=True)
class SeedSummary:
    """Counts-only outcome of a seed run (safe to log)."""

    exports: int
    inserted: int
    updated: int
    quarantined: int
    sources_processed: int
    chunks: int
    embedded: int


def ensure_staging_target(database_url: str, *, action: str = "seed") -> None:
    """Layer 1: refuse unless ``DATABASE_URL``'s database name is the staging marker.

    A pure function over the parsed URL — opens no connection, so the refusal costs
    nothing and happens before the wrong server is ever dialed. The connection string is
    never echoed (it carries a password); only the database name reaches the message.

    ``action`` names what is being refused. The A2-P3 eval reuses this guard for a
    read-only pass (``L2-DL-003``), where a message hardcoding "seed" would be false; one
    guard with an accurate verb beats a second drifting copy.
    """
    name = engine_url(database_url).database
    if name != STAGING_DATABASE_NAME:
        raise NotStagingTarget(
            f"refusing to {action}: DATABASE_URL targets database {name!r}, not "
            f"{STAGING_DATABASE_NAME!r}. The staging contour carries synthetic data only and "
            "must never be confused with a real database (ADR-020). Nothing was connected."
        )


def ensure_staging_server(connection: Connection, *, action: str = "seed") -> None:
    """Layer 2: refuse unless the CONNECTED server agrees it is the staging database.

    Asks the server rather than the string, so a socket/pooler override that lands the
    connection somewhere the URL did not name is caught before the first write.
    """
    actual = connection.execute(text("SELECT current_database()")).scalar_one()
    if actual != STAGING_DATABASE_NAME:
        raise NotStagingTarget(
            f"refusing to {action}: connected database is {actual!r}, not "
            f"{STAGING_DATABASE_NAME!r} — the URL and the server disagree. No work was done."
        )


def _ensure_schema_ready(connection: Connection) -> None:
    inspector = inspect(connection)
    missing = [table for table in _REQUIRED_TABLES if not inspector.has_table(table)]
    if missing:
        raise SchemaNotReady(
            f"target database is missing table(s): {', '.join(missing)}. Run "
            "`alembic upgrade head` against staging first (docs/RUNBOOK.md, staging "
            "contour). Nothing written."
        )


def _export_files(corpus_root: Path) -> list[Path]:
    exports_dir = corpus_root / _EXPORTS_DIRNAME
    if not exports_dir.is_dir():
        raise CorpusNotUsable(f"corpus is missing its {_EXPORTS_DIRNAME}/ directory")
    # Sorted so a seed run is reproducible: import order decides nothing semantically
    # (upsert is keyed), but a stable order keeps run-to-run logs comparable.
    files = sorted(exports_dir.glob("*.json"))
    if not files:
        raise CorpusNotUsable(f"corpus {_EXPORTS_DIRNAME}/ contains no .json export files")
    return files


def load_lexicon(corpus_root: Path) -> dict[str, list[str]]:
    """Read the corpus concept lexicon that gives the local embedder its structure."""
    path = corpus_root / _LEXICON_FILENAME
    if not path.is_file():
        raise CorpusNotUsable(f"corpus is missing {_LEXICON_FILENAME}")
    document: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("concepts"), dict):
        raise CorpusNotUsable(f"{_LEXICON_FILENAME} must be an object carrying a 'concepts' map")
    concepts: dict[str, list[str]] = {}
    for concept, forms in document["concepts"].items():
        if not isinstance(forms, list) or not all(isinstance(form, str) for form in forms):
            raise CorpusNotUsable(f"{_LEXICON_FILENAME}: concept {concept!r} must map to a list")
        concepts[concept] = list(forms)
    return concepts


def _seed(
    connection: Connection,
    *,
    corpus_root: Path,
    provider: EmbeddingProvider,
    settings: Settings,
    sink: SignalSink | None,
    quarantine_dir: Path,
    batch_size: int,
) -> SeedSummary:
    ensure_staging_server(connection)
    _ensure_schema_ready(connection)

    exports = _export_files(corpus_root)
    inserted = updated = quarantined = 0
    for export_path in exports:
        run = import_export(
            export_path,
            connection=connection,
            # Directed away from the repository tree: the committed corpus carries live
            # routes only and produces no sidecar, but a future non-live record must not
            # be able to drop a file next to the corpus.
            quarantine_report_path=quarantine_dir / (export_path.name + ".quarantine.json"),
        )
        inserted += run.inserted
        updated += run.updated
        quarantined += run.quarantined

    derived = rederive(connection=connection, sink=sink)
    embedded = embed_backfill(
        connection=connection,
        sink=sink,
        provider=provider,
        settings=settings,
        batch_size=batch_size,
    )

    return SeedSummary(
        exports=len(exports),
        inserted=inserted,
        updated=updated,
        quarantined=quarantined,
        sources_processed=derived.sources_processed,
        chunks=derived.chunks,
        embedded=embedded.embedded,
    )


def seed_staging(
    *,
    corpus_root: Path,
    connection: Connection | None = None,
    settings: Settings | None = None,
    sink: SignalSink | None = None,
    provider: EmbeddingProvider | None = None,
    quarantine_dir: Path | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> SeedSummary:
    """Seed the staging database from ``corpus_root``. Guarded, transactional, idempotent.

    Both contour guards run before any write: the URL marker before connecting, the
    server marker immediately after. The whole seed runs in ONE transaction, so a failure
    anywhere — a malformed export, a missing table — leaves the target exactly as it was.
    Idempotency is inherited from the passes it chains (keyed upsert, deterministic
    re-derivation, status-driven backfill), so re-seeding converges rather than doubling.

    ``provider`` defaults to the in-perimeter deterministic embedder built from the
    corpus lexicon: the staging contour makes ZERO third-party calls and needs no
    clearance flag set.
    """
    settings = settings if settings is not None else get_settings()

    # Layer 1 — before an engine exists, let alone a connection.
    ensure_staging_target(settings.database_url)

    if provider is None:
        provider = LocalDeterministicEmbeddingProvider(load_lexicon(corpus_root))

    with tempfile.TemporaryDirectory(prefix="theygrow-seed-") as tmp:
        resolved_quarantine = quarantine_dir if quarantine_dir is not None else Path(tmp)
        if connection is not None:
            return _seed(
                connection,
                corpus_root=corpus_root,
                provider=provider,
                settings=settings,
                sink=sink,
                quarantine_dir=resolved_quarantine,
                batch_size=batch_size,
            )
        engine = get_engine()
        with engine.begin() as conn:
            return _seed(
                conn,
                corpus_root=corpus_root,
                provider=provider,
                settings=settings,
                sink=sink,
                quarantine_dir=resolved_quarantine,
                batch_size=batch_size,
            )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theygrow-seed-staging",
        description=(
            "Seed the STAGING database from a synthetic corpus: import -> re-derive -> "
            "embed, in one transaction. Refuses unless the target database is "
            f"'{STAGING_DATABASE_NAME}' (checked at the URL and at the server). Makes "
            "zero third-party provider calls."
        ),
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help=(
            "Corpus root: a directory holding "
            f"{_EXPORTS_DIRNAME}/*.json and {_LEXICON_FILENAME}. Required and "
            "default-less — the corpus is not package data and is absent from the "
            "runtime image, so a default path would work from a checkout and fail "
            "mysteriously anywhere else."
        ),
    )
    parser.add_argument(
        "--quarantine-dir",
        type=Path,
        default=None,
        help="Where import quarantine sidecars land (default: a temporary directory).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Rows per embedding batch (default: {DEFAULT_BATCH_SIZE}).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()

    try:
        summary = seed_staging(
            corpus_root=args.corpus,
            quarantine_dir=args.quarantine_dir,
            batch_size=args.batch_size,
        )
    except NotStagingTarget as exc:
        logger.error("staging seed refused (fail-closed): %s", exc)
        return 1
    except (CorpusNotUsable, SchemaNotReady) as exc:
        logger.error("staging seed cannot run: %s", exc)
        return 1

    logger.info(
        "staging seed complete: exports=%d inserted=%d updated=%d quarantined=%d "
        "sources=%d chunks=%d embedded=%d",
        summary.exports,
        summary.inserted,
        summary.updated,
        summary.quarantined,
        summary.sources_processed,
        summary.chunks,
        summary.embedded,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - module CLI shim
    raise SystemExit(main())
