"""M3-P2 — offline ``/export`` v1 importer.

Reads a v1 ``/export`` JSON file (M3-DL-001 wire contract) and idempotently lands
its records into ``source_messages`` (M3-P1 schema). This is an **offline batch**
entrypoint: it reads a FILE, never the live engine — the engine is out of
perimeter (ADR-005), a corpus source, not a runtime dependency. There is no
``/api`` HTTP import endpoint in M3 (M3-DL-003).

Contract enforced here (settled by M3-DL-001 / M3-DL-002, recorded operationally
in M3-DL-003):

* **Fail closed.** ``schema_version`` must be ``1``; the envelope and every
  record's shape/types are validated *before* any write. The integrity check
  ``record_count == len(records)`` is required. Any malformed input aborts the
  whole run — nothing is written (no partial-silent drops).
* **Idempotent upsert.** Live rows upsert on the composite assertion key
  ``(community_id, external_chat_id, external_message_id, edit_seq)``;
  ``recorded_at`` AND the ``source_message_id`` PK are excluded from the update,
  so re-running the same file yields zero duplicates and no drift, and the
  first-recorded instant is preserved. ``edit_seq`` is significant — distinct
  edit-states are distinct rows.
* **valid_at := created_at**, per-row (M3-DL-001 §4). ``persona_id`` and
  ``embedding`` are left NULL (M3 writes no embeddings; persona is a stub).
* **Quarantine (reject-with-report).** Records whose ``detected_route`` is a
  valid RouteKind but not in ``{note, draft}`` are NOT inserted into the live
  source set (only ``note``/``draft`` ever reach an exported record today; others
  are a forward-compat / corruption signal). They are written to a **minimized**
  sidecar report — ``{source_message_id, detected_route, reason}`` ONLY — and
  tallied as ``quarantined``. The family-identifying ``external_*`` / community /
  ``edit_seq`` keys and ``raw_text`` are deliberately omitted (AGENTS.md §4):
  ``source_message_id`` is the engine-minted UUID, unique per record and
  sufficient to locate the row back in the source file.

Privacy (AGENTS.md §4): logs, errors, and the run summary carry **counts and
record indexes only** — never ``raw_text``, names, or identifiers.
"""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, select, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert

from theygrow_api.db.engine import get_engine
from theygrow_api.db.models import ROUTE_KINDS, SourceMessage
from theygrow_api.logging import install_pii_redaction

logger = logging.getLogger(__name__)

#: The only ``/export`` schema this importer accepts (M3-DL-001, D-029).
EXPECTED_SCHEMA_VERSION = 1

#: RouteKind values that reach an exported record today and are landed live
#: (M3-DL-001 §5). Other valid routes are quarantined.
LIVE_ROUTES = frozenset({"note", "draft"})

#: Machine token recorded as the quarantine ``reason``.
QUARANTINE_REASON = "non_live_route"

#: Default sidecar suffix; the ``*.quarantine.json`` pattern is gitignored so the
#: artifact cannot be committed accidentally (M3-DL-003 / C3).
QUARANTINE_SUFFIX = ".quarantine.json"

#: Exact v1 record field set (M3-DL-001 §1). Strict: missing or extra keys fail.
_RECORD_FIELDS: frozenset[str] = frozenset(
    {
        "source_message_id",
        "community_id",
        "author_user_id",
        "external_chat_id",
        "external_user_id",
        "external_message_id",
        "edit_seq",
        "raw_text",
        "detected_route",
        "created_at",
    }
)

#: Non-empty string fields (everything except ``edit_seq`` and ``created_at``).
_STRING_FIELDS: frozenset[str] = _RECORD_FIELDS - {"edit_seq", "created_at"}

#: Columns updated on conflict: the wire fields minus the ``source_message_id``
#: PK, plus the importer-set ``valid_at``. ``recorded_at`` (first-recorded
#: instant), ``persona_id`` and ``embedding`` are deliberately NOT touched.
_UPDATE_COLS: tuple[str, ...] = (
    "community_id",
    "author_user_id",
    "external_chat_id",
    "external_user_id",
    "external_message_id",
    "edit_seq",
    "raw_text",
    "detected_route",
    "created_at",
    "valid_at",
)

#: int64 / BIGINT bounds — an out-of-range ``edit_seq`` fails closed here with a
#: clear error rather than as an opaque DB overflow.
_BIGINT_MIN = -(2**63)
_BIGINT_MAX = 2**63 - 1


class ExportValidationError(Exception):
    """Raised when the ``/export`` file is malformed or the wrong schema.

    Messages are PII-free by construction: they name field names and record
    indexes only, never field values (AGENTS.md §4).
    """


@dataclass(frozen=True)
class RunSummary:
    """Counts-only outcome of an import run (safe to log)."""

    inserted: int
    updated: int
    quarantined: int
    skipped: int


# --- validation -----------------------------------------------------------


def _load_document(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ExportValidationError(f"cannot read export file: {exc.strerror}") from exc
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ExportValidationError(f"export file is not valid JSON (line {exc.lineno})") from exc
    if not isinstance(doc, dict):
        raise ExportValidationError("export root must be a JSON object")
    return doc


def _validate_envelope(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate the envelope, assert schema_version, return the records list."""
    if set(doc.keys()) != {"export", "records"}:
        raise ExportValidationError("export root must have exactly 'export' and 'records'")

    envelope = doc["export"]
    if not isinstance(envelope, dict):
        raise ExportValidationError("'export' envelope must be an object")
    required = {"format", "schema_version", "scope", "generated_at", "record_count"}
    if not required.issubset(envelope):
        missing = ", ".join(sorted(required - set(envelope)))
        raise ExportValidationError(f"envelope missing field(s): {missing}")

    version = envelope["schema_version"]
    if version != EXPECTED_SCHEMA_VERSION:
        raise ExportValidationError(
            f"unsupported schema_version (expected {EXPECTED_SCHEMA_VERSION})"
        )

    scope = envelope["scope"]
    if not isinstance(scope, dict) or not {"community_id", "requester_user_id"}.issubset(scope):
        raise ExportValidationError("envelope 'scope' must carry community_id + requester_user_id")

    records = doc["records"]
    if not isinstance(records, list):
        raise ExportValidationError("'records' must be a list")

    declared = envelope["record_count"]
    if not isinstance(declared, int) or isinstance(declared, bool) or declared != len(records):
        raise ExportValidationError("record_count does not match the number of records")

    return records


def _validate_record(record: Any, index: int) -> dict[str, Any]:
    """Validate one record's shape/types; return a normalized dict.

    ``created_at`` is parsed to a tz-aware ``datetime``; ``detected_route`` is
    confirmed to be a known RouteKind (live-vs-quarantine is decided later).
    """
    if not isinstance(record, dict):
        raise ExportValidationError(f"record[{index}] must be an object")
    if set(record.keys()) != _RECORD_FIELDS:
        raise ExportValidationError(f"record[{index}] must have exactly the 10 v1 wire fields")

    for field in _STRING_FIELDS:
        value = record[field]
        if not isinstance(value, str) or not value:
            raise ExportValidationError(
                f"record[{index}] field '{field}' must be a non-empty string"
            )

    edit_seq = record["edit_seq"]
    if not isinstance(edit_seq, int) or isinstance(edit_seq, bool):
        raise ExportValidationError(f"record[{index}] field 'edit_seq' must be an integer")
    if not _BIGINT_MIN <= edit_seq <= _BIGINT_MAX:
        raise ExportValidationError(f"record[{index}] field 'edit_seq' is out of BIGINT range")

    if record["detected_route"] not in ROUTE_KINDS:
        raise ExportValidationError(f"record[{index}] field 'detected_route' is not a known route")

    created_at = _parse_timestamp(record["created_at"], index)

    normalized = dict(record)
    normalized["created_at"] = created_at
    return normalized


def _parse_timestamp(value: str, index: int) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ExportValidationError(
            f"record[{index}] field 'created_at' is not an ISO-8601 timestamp"
        ) from exc
    if parsed.tzinfo is None:
        raise ExportValidationError(f"record[{index}] field 'created_at' must be timezone-aware")
    return parsed


# --- partition / upsert ---------------------------------------------------


def _row_for_insert(record: dict[str, Any]) -> dict[str, Any]:
    """A live ``source_messages`` row: 10 wire fields + valid_at := created_at.

    ``recorded_at`` (DB default now()), ``persona_id`` and ``embedding`` are
    omitted so the DB / NULL defaults apply.
    """
    row = dict(record)
    row["valid_at"] = record["created_at"]
    return row


def _quarantine_entry(record: dict[str, Any]) -> dict[str, Any]:
    """Minimized, §4-safe quarantine record (M3-DL-003): no family identifiers."""
    return {
        "source_message_id": record["source_message_id"],
        "detected_route": record["detected_route"],
        "reason": QUARANTINE_REASON,
    }


def _existing_keys(connection: Connection, rows: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    """Assertion keys among ``rows`` that already exist (to count insert vs update)."""
    if not rows:
        return set()
    cols = (
        SourceMessage.community_id,
        SourceMessage.external_chat_id,
        SourceMessage.external_message_id,
        SourceMessage.edit_seq,
    )
    keys = [tuple(row[c.key] for c in cols) for row in rows]
    result = connection.execute(select(*cols).where(tuple_(*cols).in_(keys)))
    return {tuple(r) for r in result}


def _upsert(connection: Connection, rows: list[dict[str, Any]]) -> tuple[int, int]:
    """Idempotent upsert on the composite assertion key. Returns (inserted, updated)."""
    if not rows:
        return (0, 0)
    existing = _existing_keys(connection, rows)
    stmt = pg_insert(SourceMessage).values(rows)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_source_messages_assertion_key",
        set_={col: stmt.excluded[col] for col in _UPDATE_COLS},
    )
    connection.execute(stmt)
    updated = sum(
        1
        for row in rows
        if (
            row["community_id"],
            row["external_chat_id"],
            row["external_message_id"],
            row["edit_seq"],
        )
        in existing
    )
    return (len(rows) - updated, updated)


def _write_quarantine_report(path: Path, entries: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# --- entrypoint -----------------------------------------------------------


def import_export(
    export_path: Path,
    *,
    connection: Connection | None = None,
    quarantine_report_path: Path | None = None,
) -> RunSummary:
    """Import one v1 ``/export`` file. Validates fail-closed, then upserts atomically.

    All validation runs before any write, so malformed input leaves the DB
    untouched. When ``connection`` is supplied the caller owns the transaction
    (used by tests); otherwise a transaction is opened and committed here.
    """
    doc = _load_document(export_path)
    records = _validate_envelope(doc)
    validated = [_validate_record(rec, i) for i, rec in enumerate(records)]

    live_rows = [_row_for_insert(r) for r in validated if r["detected_route"] in LIVE_ROUTES]
    quarantined = [
        _quarantine_entry(r) for r in validated if r["detected_route"] not in LIVE_ROUTES
    ]

    if connection is not None:
        inserted, updated = _upsert(connection, live_rows)
    else:
        engine = get_engine()
        with engine.begin() as conn:
            inserted, updated = _upsert(conn, live_rows)

    if quarantined:
        report_path = quarantine_report_path or export_path.with_name(
            export_path.name + QUARANTINE_SUFFIX
        )
        _write_quarantine_report(report_path, quarantined)

    return RunSummary(inserted=inserted, updated=updated, quarantined=len(quarantined), skipped=0)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theygrow-import-export",
        description="Offline importer: land a v1 /export JSON file into source_messages.",
    )
    parser.add_argument("export_path", type=Path, help="path to a v1 /export JSON file")
    parser.add_argument(
        "--quarantine-report",
        type=Path,
        default=None,
        help="path for the quarantine sidecar (default: <export_path>.quarantine.json)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()

    try:
        summary = import_export(args.export_path, quarantine_report_path=args.quarantine_report)
    except ExportValidationError as exc:
        logger.error("import failed: %s", exc)
        return 1

    logger.info(
        "import complete: inserted=%d updated=%d quarantined=%d skipped=%d",
        summary.inserted,
        summary.updated,
        summary.quarantined,
        summary.skipped,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - module CLI shim
    raise SystemExit(main())
