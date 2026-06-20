# Tech spec — decided shape

This document records the **decided architectural shape** of `theygrow-app` per ADR-005 + roadmap v2. Items that are intentionally open at owner level are listed under **Unresolved (gated)** — they are **not** pre-resolved here.

For the delivery order, see `BuildPlan.md`. For runtime behavioral contract, see `../RUNTIME-INVARIANTS.md`.

## Monorepo

- `/app` — the PWA. Today the static PWA still lives at repo root (single `index.html` + nginx + Docker + Cloud Run); the migration into `/app` lands in M2.
- `/api` — Python / FastAPI backend. Lands in M2.
- `/docs` — operating contract, decision log, invariants, runbook, execution map, product specs (this file).
- `/scripts` — ops + dev scripts (lands as needed).
- `/infra` — IaC (post-M5).

No other top-level product directories.

## Episodic store

**Postgres + pgvector.** This is the live perimeter store for family-memory records. There is no graph database in the live perimeter.

- Records land via the M3 `/export` importer from `diary-memory-service`.
- Vector index lives in the same Postgres instance via pgvector — not a separate vector DB.
- Schema lands in M3 once the `/export` verification gate clears.

## Retrieval / RAG

**Lifted from `diary-memory-service` in M4.** The engine is a **code donor**, not a live dependency — it stays out of the running perimeter. The lift ports only the retrieval primitives that respect the closed-corpus contract; the engine's web / parametric routes are dropped, not ported.

## Closed-corpus chat

**Two grounded sources only.**

- **Family memory** — the episodic store (Postgres + pgvector), seeded at M3 from `/export` and grown over time.
- **Canon** — skill descriptions today, additional canon content as it lands. Canon is not the episodic store; it is reference content.

The chat surface, grounding gate, honest degradation, per-segment provenance, and medical boundary all land in M5. See `RUNTIME-INVARIANTS.md` for the runtime contract; see `BuildPlan.md` M5 for the delivery shape.

## Unresolved (gated)

These items are **explicitly open at owner level** and are **not** pre-resolved by this spec. They surface as questions when the relevant packet is planned; they are listed here so downstream packets do not silently decide them. They overlap with `AGENTS.md` §5 (gated-out) where the gate is "do not plan toward this yet"; the items below are scoped narrower to the architectural forks.

- **Graph-store choice.** Whether any graph store enters the perimeter, and if so which one and at what milestone. The live perimeter today excludes a graph database; revisiting this is owner-level.
- **Multi-subject persona / identity model.** Persona resolution at import is a stub today (`AGENTS.md` §3). A real persona / identity model is gated out — its eventual shape is owner-level.
- **Unified propose → confirm write contract.** The write path for family-memory mutations — whether it is a single unified propose → confirm flow across surfaces — is gated out today.
- **`/export` JSON schema.** Deliberately **not** specified here. Resolved by the M3 pre-execution verification gate in `BuildPlan.md` — schema is read off `diary-memory-service`, not assumed.
