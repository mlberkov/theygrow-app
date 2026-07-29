# Build plan — M1 through M5

This is the milestone-level build plan that follows from `AGENTS.md` §6 + ADR-005 + roadmap v3 (tracks А/Б/В). `TechSpec.md` documents the decided architectural shape; this file documents the **delivery order** that gets us there.

## M1 — enablement harness

Docs / refactor / config only. No product behavior, no backend code, no schema. The Cloud Run deploy is unaffected by every M1 packet.

- **P1** — Contract redirect. Rewrite `AGENTS.md`, add `CLAUDE.md`, neutralize `.cursor/rules/masterplan.mdc`, reframe `data/mvp_masterplan.md` with a supersession header, open `docs/decision-log.md` with `M1-DL-001`. **Done** @ f04d2ee.
- **P2** — Docs spine. Author `INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`; extend the cursor stub with the execution-map pointer. **Current packet.**
- **P3** — Quality harness. `pyproject.toml`, Ruff, mypy, `.editorconfig`, `.pre-commit-config.yaml`, `.github/workflows/ci.yml`, secret-scan; first enforced `INVARIANTS.md` entry lands here.
- **P4** — Naming / `.gitignore` / `README.md` cleanup; residual repository-directory naming sweep so the live spine reads consistently as `theygrow-app`.

M1 close: a single PR opens after P4 lands.

## M2 — `/api` skeleton

Introduce the monorepo split (`/app` + `/api`) and stand up the FastAPI skeleton. The current static PWA at repo root migrates into `/app`. The `/api` skeleton ships with the **privacy precondition active from byte one** (`AGENTS.md` §4 / `RUNTIME-INVARIANTS.md` "No child PII in telemetry or logs") — every logging / telemetry / error-tracking surface either has no path to PII fields or redacts them at the boundary. No business endpoints yet.

### Packets (ADR-007 3-packet ladder)

- **P1** — Monorepo split: migrate the static PWA from repo root into `/app`; repoint the `Dockerfile` COPY sources; reconcile RUNBOOK/TechSpec. Served `/` stays byte-identical. **Done** @ a77dfef.
- **P2** — FastAPI `/api` skeleton: `GET /api/health` (structured, non-PII, in-process), env-driven **read-only** config (DB connection + infra endpoints from env, no secret defaults; opens no connections), a provider-port **interface stub** (engine stays out of perimeter), the **PII forward guard** active byte-one, and the quality harness gaining teeth on `api/` (mypy strict + pytest in CI). No business endpoints; no DB connection. Decision `M2-DL-001`. **Current.**
- **P3** — Runtime + deploy path: a dev-only docker-compose (Postgres 16 / pgvector), build-config relocated from repo root into `/app` + `/api`, and the `/api` deploy path — `/api` deploys as **its own Cloud Run service** (own build-config + trigger) so `/api/health` is green not just in CI but deployed. No real DB connection or schema yet (M3). The nginx same-origin `/api` proxy is not P3; `M2-DL-002` reassigned it to M5, and it ultimately landed in **A3-P1** (`A3-DL-001`). Decision `M2-DL-002`.

## M3 — episodic store + `/export` importer

Introduce the core store — one managed PostgreSQL as single source of truth (pgvector-derived vector port; ADR-008) — and import family-memory records from the `diary-memory-service` engine via its `/export` surface. The engine remains **out of perimeter** — it is a code/data donor, not a live dependency.

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

**Origin unification is no longer part of M5.** The nginx same-origin `/api` proxy — the PWA and `/api` served same-origin, no CORS anywhere (ADR-007) — landed in **A3-P1** (`A3-DL-001`, amending `M2-DL-002`), well ahead of the chat surface: production `/api` is private and reached only through the PWA's nginx. M5 inherits that topology rather than establishing it.
