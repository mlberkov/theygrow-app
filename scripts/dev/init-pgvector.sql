-- Dev-only init for the docker-compose Postgres (ADR-008: prod is managed Cloud
-- SQL Postgres + pgvector). This enables the pgvector EXTENSION for local parity
-- with the production store. It creates NO episodic schema/tables — the episodic
-- schema landed in M3 and is applied by the Alembic migrations under /api, never
-- by this file.
CREATE EXTENSION IF NOT EXISTS vector;
