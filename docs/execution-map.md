# Execution map — theygrow-app

This file is the living "where are we / what's next" state map. It is the index, not the spec. `AGENTS.md` §6 is the milestone source of truth; this file tracks progress against it.

## Milestone ladder

- **M1** — Repository preparation for agentic development (enablement harness).
- **M2** — `/api` skeleton (Python / FastAPI lands; monorepo split `/app` + `/api` lands).
- **M3** — Episodic store (Postgres + pgvector) + `/export` importer from `diary-memory-service`.
- **M4** — Retrieval lift from the engine (`diary-memory-service` → `theygrow-app`).
- **M5** — Closed-corpus family-memory chat.

## Current state

- **M1 — Done.**
  - **P1** — Contract redirect. **Done** @ f04d2ee (`AGENTS.md` rewritten, `CLAUDE.md` added, `.cursor/rules/masterplan.mdc` neutralized, `data/mvp_masterplan.md` reframed, `docs/decision-log.md` opened with `M1-DL-001`).
  - **P2** — Docs spine. **Done** @ 2886d0f (`INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`; cursor stub extended with the execution-map pointer).
  - **P3** — Quality harness. **Done** @ d67c70d (`pyproject.toml` / Ruff / mypy / `.editorconfig` / `.pre-commit-config.yaml` / GitHub Actions CI / gitleaks secret-scan / `scripts/check-contract-integrity.sh`; first enforced `INVARIANTS.md` entries `M1-P3-INV-001` + `M1-P3-INV-002`; decision `M1-DL-002`).
  - **P4** — Naming / `.gitignore` / `README.md` cleanup. **Done** @ 9088762 (`README.md` overview, full `.gitignore` pass, residual naming sweep, contract-integrity gate tightened to a strict ban with `INV-002` updated to match). Branch-convention reconcile @ ca98842; milestone merged via PR #1 @ 56facb5.
- **M2 in progress.**
  - **P1** — Monorepo `/app` split (PWA migrated from repo root into `/app`; `Dockerfile` COPY sources repointed; RUNBOOK/TechSpec reconciled; served `/` byte-identical). **Done** @ a77dfef.
  - **P2** — FastAPI `/api` skeleton: `GET /api/health`, env-driven read-only config (pydantic-settings), provider-port interface stub, PII-redaction forward guard, quality harness teeth on `api/`. Decision `M2-DL-001`; invariants `M2-P2-INV-001` + `M2-P2-INV-002`. **Current** (this packet).
  - **P3** — docker-compose + Postgres 16 / pgvector + `/api` deploy path (incl. the nginx same-origin `/api` proxy). **Not started.**
- **M3-M5** — Not started.

## How to update this file

Bump on every packet close: move the closed packet from **Current** to **Done @ <sha>**; advance the next packet to **Current**. At milestone close, mark the milestone **Done** and move the next milestone's first packet to **Current**.
