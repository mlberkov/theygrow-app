"""Read-only, env-driven configuration (ADR-007 Packet-2 guard).

The settings object only *binds and validates* environment strings. It opens NO
connections, instantiates NO clients, and reaches NO network — those land in
M2-P3 (Postgres 16 / pgvector). Required infra fields carry NO defaults, so a
missing value fails loudly at construction rather than silently falling back.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Infra configuration read from the process environment.

    `database_url` is the DB connection string; it is required and default-less.
    No connection is opened here — the value is only held for P3+ consumers.
    Genuinely-optional, non-secret knobs (e.g. `log_level`) may carry a default.
    """

    # env_file is deliberately unset: settings come from os.environ only. A
    # documented .env.example exists for var names but is never auto-loaded.
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    log_level: str = "INFO"

    # --- M4-P2 embedder seam (ADR-011 §1). These bind strings only; no client is
    # built here. They are OPTIONAL on Settings (so the importer / derivation /
    # sparse-leg paths, which need only database_url, still construct cleanly) —
    # the offline embeddings backfill enforces presence + clearance itself,
    # fail-closed, before any chunk_text is sent (the §4 gate lives there, not here).
    embedder_base_url: str | None = None
    embedder_api_key: str | None = None
    # ZDR + DPA + EU-residency clearance affirmation. Defaults to FALSE (uncleared):
    # there is no implicit "cleared" state — an operator must explicitly set it via
    # the environment once the privacy surface is confirmed. Unset -> the backfill
    # sends NO child text and writes nothing (structural §4 enforcement, ADR-011 §1).
    embedder_privacy_cleared: bool = False


def get_settings() -> Settings:
    """Construct settings from the environment.

    Provided as a FastAPI dependency seam for future routes. No P2 route depends
    on it, so the health skeleton needs zero environment to run.
    """
    return Settings()
