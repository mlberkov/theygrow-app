# Execution map — theygrow-app

This file is the living "where are we / what's next" state map. It is the index, not the spec. `AGENTS.md` §6 is the milestone source of truth; this file tracks progress against it.

## Milestone ladder

- **M1** — Repository preparation for agentic development (enablement harness).
- **M2** — `/api` skeleton (Python / FastAPI lands; monorepo split `/app` + `/api` lands).
- **M3** — Episodic store (Postgres + pgvector) + `/export` importer from `diary-memory-service`.
- **M4** — Retrieval lift from the engine (`diary-memory-service` → `theygrow-app`).
- **M5** — Closed-corpus family-memory chat.

## Current state

- **M1 in progress.**
  - **P1** — Contract redirect. **Done** @ f04d2ee (`AGENTS.md` rewritten, `CLAUDE.md` added, `.cursor/rules/masterplan.mdc` neutralized, `data/mvp_masterplan.md` reframed, `docs/decision-log.md` opened with `M1-DL-001`).
  - **P2** — Docs spine. **Current** (this packet — authors `INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`; extends the cursor stub with the execution-map pointer).
  - **P3** — Quality harness. **Pending** (pyproject / Ruff / mypy / `.editorconfig` / pre-commit / GitHub Actions CI / secret-scan + first enforced `INVARIANTS.md` entry).
  - **P4** — Naming / `.gitignore` / `README.md` cleanup. **Pending**.
- **M2-M5** — Not started.

## How to update this file

Bump on every packet close: move the closed packet from **Current** to **Done @ <sha>**; advance the next packet to **Current**. At milestone close, mark the milestone **Done** and move the next milestone's first packet to **Current**.
