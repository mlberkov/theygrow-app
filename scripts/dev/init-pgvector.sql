-- Dev-only init for the docker-compose Postgres (ADR-008: prod is managed Cloud
-- SQL Postgres + pgvector). This enables the pgvector EXTENSION for local parity
-- with the production store. It creates NO episodic schema/tables — the episodic
-- schema lands in M3 once the /export verification gate clears.
CREATE EXTENSION IF NOT EXISTS vector;
