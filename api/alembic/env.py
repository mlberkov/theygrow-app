"""Alembic migration environment.

Reads ``DATABASE_URL`` from the process environment (M2-P2 config posture) and
reuses the product engine factory so the migration runner and the application
dial the same normalized psycopg3 URL. Targets ``Base.metadata`` so future
autogenerate sees the ORM models.
"""

from __future__ import annotations

from alembic import context
from theygrow_api.config import get_settings
from theygrow_api.db.engine import create_db_engine, engine_url
from theygrow_api.db.models import Base

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL against a URL without opening a connection."""
    url = engine_url(get_settings().database_url).render_as_string(hide_password=False)
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Open a connection from the product engine and run migrations."""
    engine = create_db_engine(get_settings().database_url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
