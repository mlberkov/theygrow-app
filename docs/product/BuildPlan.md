# Build plan — M1 through M5

This is the milestone-level build plan that follows from `AGENTS.md` §6 + ADR-005 + roadmap v2. `TechSpec.md` documents the decided architectural shape; this file documents the **delivery order** that gets us there.

## M1 — enablement harness

Docs / refactor / config only. No product behavior, no backend code, no schema. The Cloud Run deploy is unaffected by every M1 packet.

- **P1** — Contract redirect. Rewrite `AGENTS.md`, add `CLAUDE.md`, neutralize `.cursor/rules/masterplan.mdc`, reframe `data/mvp_masterplan.md` with a supersession header, open `docs/decision-log.md` with `M1-DL-001`. **Done** @ f04d2ee.
- **P2** — Docs spine. Author `INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`; extend the cursor stub with the execution-map pointer. **Current packet.**
- **P3** — Quality harness. `pyproject.toml`, Ruff, mypy, `.editorconfig`, `.pre-commit-config.yaml`, `.github/workflows/ci.yml`, secret-scan; first enforced `INVARIANTS.md` entry lands here.
- **P4** — Naming / `.gitignore` / `README.md` cleanup; residual repository-directory naming sweep so the live spine reads consistently as `theygrow-app`.

M1 close: a single PR opens after P4 lands.

## M2 — `/api` skeleton

Introduce the monorepo split (`/app` + `/api`) and stand up the FastAPI skeleton. The current static PWA at repo root migrates into `/app`. The `/api` skeleton ships with the **privacy precondition active from byte one** (`AGENTS.md` §4 / `RUNTIME-INVARIANTS.md` "No child PII in telemetry or logs") — every logging / telemetry / error-tracking surface either has no path to PII fields or redacts them at the boundary. No business endpoints yet.

## M3 — episodic store + `/export` importer

Introduce the episodic store (Postgres + pgvector) and import family-memory records from the `diary-memory-service` engine via its `/export` surface. The engine remains **out of perimeter** — it is a code/data donor, not a live dependency.

### Pre-execution verification gate

**Before M3 implementation begins**, two verifications are mandatory:

1. **`/export` JSON schema.** Verify the actual schema emitted by `diary-memory-service`'s `/export` surface. Do **not** presume it from upstream specs or this document. The gate's purpose is to prevent any importer code from being written against a guessed schema.
2. **Engine `src/memory_rag/` layout.** Verify the engine's `src/memory_rag/` directory layout that the M4 retrieval lift will draw from, so that M3's lineage / provenance capture aligns with what M4 will port.

Both verifications must be recorded (decision-log entry or M3 plan file) before importer / store code is authored.

## M4 — retrieval lift

Port retrieval / RAG from `diary-memory-service` into `theygrow-app`'s `/api`. The lift structurally enforces the closed-corpus contract by dropping the donor engine's web / parametric routes — retrieval will only consult the family memory (episodic store) and canon. Per-segment lineage captured at M3 is carried through retrieval here.

## M5 — closed-corpus chat

Stand up the chat surface against the two grounded sources (family memory + canon). The runtime contract from `RUNTIME-INVARIANTS.md` becomes fully enforced at this milestone:

- **Grounding gate** — block generation when grounded coverage is absent.
- **Honest degradation** — explicit "no grounded answer" surface; never a synthesized fallback.
- **Per-segment provenance** — source attribution per answer segment, not per answer.
- **Medical boundary** — health-adjacent / red-flag prompts route to specialist referral, not generated diagnosis.
- **Closed corpus** — sealed end-to-end on the answer surface.
