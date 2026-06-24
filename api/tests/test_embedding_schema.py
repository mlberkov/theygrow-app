"""M4-P2 schema deltas, enforced against a real Postgres.

Covers the embeddings-activation schema (M4-DL-003 / ADR-011): the per-chunk
``event_chunks.embedding`` ``vector(1536)`` column exists and is nullable, and the HNSW
index is NOT created by the migration — it is built by the backfill AFTER population
(the dimension drift guard itself lives in ``test_parameters``).
"""

from __future__ import annotations

from sqlalchemy import Connection, text


def test_event_chunks_has_nullable_embedding_column(connection: Connection) -> None:
    row = connection.execute(
        text(
            "SELECT data_type, udt_name, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'event_chunks' AND column_name = 'embedding'"
        )
    ).one()
    # pgvector surfaces as USER-DEFINED / udt 'vector'; the column is nullable until
    # the backfill populates it.
    assert row.udt_name == "vector"
    assert row.is_nullable == "YES"


def test_migration_alone_builds_no_hnsw_index(connection: Connection) -> None:
    # Index-after-backfill (M4-DL-003): migration 0003 adds the column WITHOUT the HNSW
    # index. The migrated (un-backfilled) DB therefore carries no vector index.
    rows = connection.execute(
        text("SELECT indexdef FROM pg_indexes WHERE tablename = 'event_chunks'")
    ).fetchall()
    assert not any("hnsw" in str(r[0]).lower() for r in rows), (
        "HNSW index must be built by the backfill after population, not by the migration"
    )
