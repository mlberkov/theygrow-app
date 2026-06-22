# Execution map — theygrow-app

This file is the living "where are we / what's next" state map. It is the index, not the spec. `AGENTS.md` §6 is the milestone source of truth; this file tracks progress against it.

## Milestone ladder

- **M1** — Repository preparation for agentic development (enablement harness).
- **M2** — `/api` skeleton (Python / FastAPI lands; monorepo split `/app` + `/api` lands).
- **M3** — Core store (one managed PostgreSQL as SoT; pgvector-derived vector port, ADR-008) + `/export` importer from `diary-memory-service`.
- **M4** — Retrieval lift from the engine (`diary-memory-service` → `theygrow-app`).
- **M5** — Closed-corpus family-memory chat.

## Current state

- **M1 — Done.**
  - **P1** — Contract redirect. **Done** @ f04d2ee (`AGENTS.md` rewritten, `CLAUDE.md` added, `.cursor/rules/masterplan.mdc` neutralized, `data/mvp_masterplan.md` reframed, `docs/decision-log.md` opened with `M1-DL-001`).
  - **P2** — Docs spine. **Done** @ 2886d0f (`INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`; cursor stub extended with the execution-map pointer).
  - **P3** — Quality harness. **Done** @ d67c70d (`pyproject.toml` / Ruff / mypy / `.editorconfig` / `.pre-commit-config.yaml` / GitHub Actions CI / gitleaks secret-scan / `scripts/check-contract-integrity.sh`; first enforced `INVARIANTS.md` entries `M1-P3-INV-001` + `M1-P3-INV-002`; decision `M1-DL-002`).
  - **P4** — Naming / `.gitignore` / `README.md` cleanup. **Done** @ 9088762 (`README.md` overview, full `.gitignore` pass, residual naming sweep, contract-integrity gate tightened to a strict ban with `INV-002` updated to match). Branch-convention reconcile @ ca98842; milestone merged via PR #1 @ 56facb5.
- **M2 — Done.**
  - **P1** — Monorepo `/app` split (PWA migrated from repo root into `/app`; `Dockerfile` COPY sources repointed; RUNBOOK/TechSpec reconciled; served `/` byte-identical). **Done** @ a77dfef.
  - **P2** — FastAPI `/api` skeleton: `GET /api/health`, env-driven read-only config (pydantic-settings), provider-port interface stub, PII-redaction forward guard, quality harness teeth on `api/`. Decision `M2-DL-001`; invariants `M2-P2-INV-001` + `M2-P2-INV-002`. **Done** @ 4be3860.
  - **P3** — Runtime + deploy path: dev-only docker-compose (Postgres 16 / pgvector), build-config relocated into `/app` + `/api`, and the `/api` deploy path — `/api` deploys as its own Cloud Run service so `/api/health` is green deployed. No real DB connection or schema yet (M3). The nginx same-origin `/api` proxy is **M5** (corrected from the original P3 recording). Decision `M2-DL-002`. **Done** @ 6249590; milestone merged via PR #2 @ db4c1f3.
- **M3 in progress.**
  - **Pre-execution gate** — `/export` v1 schema confirmed (`SCHEMA_VERSION=1`, D-029) + `memory_rag` lift map. Decision `M3-DL-001`. **Done** @ ac441de.
  - **P1** — Episodic source schema + migration: the `source_messages` table (v1 wire mirror; engine-faithful TEXT ids; BIGINT `edit_seq`; PK + composite assertion-key UNIQUE; defensive `detected_route` CHECK; ADR-004 dual-timestamp; persona stub; reserved unindexed `vector(≤1536)` shell), Alembic migration tooling, the first real DB connection from product code, and DB-backed constraint tests run against a pgvector Postgres in CI. Decision `M3-DL-002`. **Current** (this packet).
  - **P2** — `/export` importer (idempotent upsert on the assertion key). Not started.
- **M4-M5** — Not started.

## How to update this file

Bump on every packet close: move the closed packet from **Current** to **Done @ <sha>**; advance the next packet to **Current**. At milestone close, mark the milestone **Done** and move the next milestone's first packet to **Current**.
