# Decision log — theygrow-app

This file records architectural and scope-shaping decisions for `theygrow-app`. The decision log is the authoritative record of *why* the project is the way it is, when the code itself doesn't explain it.

## Entry format

- **Id.** `M{N}-DL-{NNN}` — `N` is the milestone number, `NNN` is the zero-padded sequence within the milestone (`001`, `002`, …).
- **Required fields.** Date, Decision, Rationale, Alternatives considered, Supersedes, Effects.

---

## M1-DL-001 — Masterplan supersession + contract redirect

- **Date.** 2026-06-19
- **Decision.** `data/mvp_masterplan.md` (dated 11 February 2026, "TheyGrow MVP — Мастер-план разработки", a full-stack value-loop blueprint covering Blocks 0–8 — Auth/Profiles/Skills, Graph API + Cascade Predictions, Recommendation Pipeline, Diary + Signal Extraction, Reflection + Parent Graph, Safety Pipeline (Constitutional AI), Q&A + Risk Routing, Production Readiness — running on FastAPI + Postgres + Neo4j + an LLM extraction stack, plus a Next.js 14 App Router rewrite of the existing static PWA) is **superseded as plan of record**. The new plan of record is **ADR-005** + **roadmap v2**.
- **Rationale.** The February plan designs the closed-loop product as a single full-stack monolith. Building it as written would duplicate the `diary-memory-service` engine inside `theygrow-app`, violating ADR-005's app-unification + engine spin-off boundary and the closed-corpus delivery contract (which keeps the engine out of the live perimeter and the episodic store on Postgres + pgvector). The roadmap-v2 decomposition — M1 enablement harness → M2 `/api` skeleton → M3 episodic store + `/export` importer → M4 retrieval lift → M5 closed-corpus chat — reaches the same product end-state via a perimeter-respecting path.
- **Alternatives considered.**
  1. **Extend the February plan in place.** Rejected — would violate the ADR-005 perimeter from packet 1 and require unwinding later.
  2. **Delete `data/mvp_masterplan.md`.** Rejected — loses historical context, breaks the existing `.gitignore` negation rule, and forecloses cross-references from future decisions.
  3. **Reframe in place with a supersession header.** **Selected** — preserves the artifact and the audit trail at minimal diff cost.
- **Supersedes.** None — this is the first entry in this log.
- **Effects.**
  - `AGENTS.md` rewritten from scratch as an English, ADR-005-aligned operating contract (this packet, M1-P1).
  - `CLAUDE.md` added as the Claude-Code operational overlay (this packet, M1-P1).
  - `.cursor/rules/masterplan.mdc` neutralized to a redirect stub pointing at `AGENTS.md` (this packet, M1-P1).
  - Supersession header prepended to `data/mvp_masterplan.md` (this packet, M1-P1).
  - This decision log created (this packet, M1-P1).
  - Downstream in M1: docs spine authored in M1-P2 (`INVARIANTS.md`, `RUNTIME-INVARIANTS.md`, `execution-map.md`, `RUNBOOK.md`, `product/BuildPlan.md`, `product/TechSpec.md`); quality harness in M1-P3; naming / gitignore / README cleanup in M1-P4. The live-infra divergence (GCP resource names `child-tracker-service` / `child-tracker-repo` predate the project rename) is documented in `docs/RUNBOOK.md` in M1-P2, not in `AGENTS.md`.
