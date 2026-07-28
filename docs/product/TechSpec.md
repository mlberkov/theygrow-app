# Tech spec — decided shape

This document records the **decided architectural shape** of `theygrow-app` per ADR-005 + roadmap v3 (tracks А/Б/В). Items that are intentionally open at owner level are listed under **Unresolved (gated)** — they are **not** pre-resolved here.

For the delivery order, see `BuildPlan.md`. For runtime behavioral contract, see `../RUNTIME-INVARIANTS.md`.

## Monorepo

- `/app` — the PWA. The static PWA served assets live here, migrated from repo root in M2-P1; its build-config (`app/Dockerfile`/`app/nginx.conf`/`app/cloudbuild.yaml`) relocated into the subtree in M2-P3. The shell is `app/index.html`; since the A1 `spa-split` milestone its stylesheet and its native ES-module graph live under the versioned mount `app/m/v{N}/`, served at `/m/v{N}/` (version-in-path, copy-forward bumps — `A1-DL-004`). Delivery stays **buildless**: no bundler, no transpiler; the files execute as they lie. Playwright and Node are dev/CI only and ship in neither the image nor the build context.
- `/api` — Python / FastAPI backend. Lands in M2; from M2-P3 it deploys as **its own Cloud Run service** with its own build-config (`api/Dockerfile`/`api/cloudbuild.yaml`). Since the A2 `l2-staging` milestone `/api` deploys as **two** services from **two** self-contained build-configs on separate triggers: production (`api/cloudbuild.yaml`, now behind the L1 `--no-traffic`/sha-tag promotion gate) and a private, database-attached **staging** contour (`api/cloudbuild.staging.yaml`) — same `api/Dockerfile` and build context, distinct image name, live identifiers supplied as trigger substitutions rather than committed (`L2-DL-001`; service, registry and instance names live in `../RUNBOOK.md`). Origin unification (the same-origin `/api` proxy, no CORS) is M5.
- `/docs` — operating contract, decision log, invariants, runbook, execution map, product specs (this file).
- `/scripts` — ops + dev scripts (lands as needed).
- `/infra` — IaC (post-M5).

No other top-level product directories.

## Core store

**One managed PostgreSQL — single source of truth (ADR-008).** This is the live perimeter store for family-memory records. Vector, lexical, and graph-state are **derived ports within that one database**, not separate stores; there is no separate graph database in the live perimeter.

- Records land via the M3 `/export` importer from `diary-memory-service`.
- Vector index lives in the same Postgres instance via pgvector (a derived port) — not a separate vector DB. Embeddings are **≤1536-dim from M3**.
- Schema lands in M3 once the `/export` verification gate clears.
- **Prod vs dev (ADR-008).** Production is **managed Cloud SQL Postgres + pgvector** (→ AlloyDB by load). Dev uses a local Postgres 16 + pgvector via the dev-only `docker-compose.yml`. dev vs prod is a config difference (the env-driven config reads connection/infra endpoints from the environment), not a code difference. No connection is opened and no schema exists before M3.
- **Staging (ADR-020 as amended, A2).** A third contour: a **separate staging database on the same Cloud SQL instance** as production — the accepted cost default, with isolation enforced by SQL grants and a least-privilege runtime identity rather than by a second instance (`L2-DL-001`). It is **not** a second source of truth: staging holds **no real family data**, only a committed synthetic `/export` v1 corpus (`L2-DL-002`), and no third-party provider is cleared for it — both per-egress clearance gates stay unset and fail-closed. Every step of standing the contour up is owner-run; see `../RUNBOOK.md` "Staging contour".

## Retrieval / RAG

**Lifted from `diary-memory-service` in M4.** The engine is a **code donor**, not a live dependency — it stays out of the running perimeter. The lift ports only the retrieval primitives that respect the closed-corpus contract; the engine's web / parametric routes are dropped, not ported.

## Closed-corpus chat

**Two grounded sources only.**

- **Family memory** — the episodic records in the one managed PostgreSQL core store (pgvector-derived vector port), seeded at M3 from `/export` and grown over time.
- **Canon** — skill descriptions today, additional canon content as it lands. Canon is not the episodic store; it is reference content.

The chat surface, grounding gate, honest degradation, per-segment provenance, and medical boundary all land in M5. See `RUNTIME-INVARIANTS.md` for the runtime contract; see `BuildPlan.md` M5 for the delivery shape.

## Unresolved (gated)

These items are **explicitly open at owner level** and are **not** pre-resolved by this spec. They surface as questions when the relevant packet is planned; they are listed here so downstream packets do not silently decide them. They overlap with `AGENTS.md` §5 (gated-out) where the gate is "do not plan toward this yet"; the items below are scoped narrower to the architectural forks.

- **Graph-store choice.** Whether any graph store enters the perimeter, and if so which one and at what milestone. The live perimeter today excludes a graph database; revisiting this is owner-level.
- **Multi-subject persona / identity model.** Persona resolution at import is a stub today (`AGENTS.md` §3). A real persona / identity model is gated out — its eventual shape is owner-level.
- **Unified propose → confirm write contract.** The write path for family-memory mutations — whether it is a single unified propose → confirm flow across surfaces — is gated out today.
- **`/export` JSON schema.** Deliberately **not** specified here. Resolved by the M3 pre-execution verification gate in `BuildPlan.md` — schema is read off `diary-memory-service`, not assumed.
