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

---

## M1-DL-002 — Quality harness: tooling + dual posture + first enforced invariants

- **Date.** 2026-06-20
- **Decision.** Adopt **Ruff** (format + lint) and **mypy** as the Python quality harness, run by **both** pre-commit (local) and a GitHub Actions CI workflow (gate of record). Ruff replaces the Black + isort + flake8 trio (format via `ruff format`, import-sorting via the `I` rule set, linting via `ruff check`). Configs land at repo root (`pyproject.toml`, `.editorconfig`, `.pre-commit-config.yaml`, `.github/workflows/ci.yml`), pre-sized for the `/api` subtree that lands in M2. The same packet lands the **first two enforced invariants**: `M1-P3-INV-001` (no secrets committed — gitleaks) and `M1-P3-INV-002` (contract integrity — a grep gate promoting the previously-manual P1/P2 negative-checks).
- **Rationale.** Ruff collapses three tools into one fast binary with a single config surface, reducing harness maintenance and CI time. The dual pre-commit + CI posture gives contributors a fast local signal while keeping CI as the authoritative gate that cannot be bypassed. Wiring the first invariants now — rather than waiting for product code — promotes the contract guarantees that were enforced by hand in P1/P2 into machine-checked gates, so contract drift and committed secrets fail loudly from this point on. The harness is built to pass cleanly with zero Python present (Ruff no-ops; mypy is guarded), so it provides value immediately and gains teeth when `/api` arrives.
- **Alternatives considered.**
  1. **Black + isort + flake8 (the conventional trio).** Rejected — three tools, three configs, slower; Ruff subsumes all three with parity for this project's needs.
  2. **Single posture (pre-commit only, or CI only).** Rejected — pre-commit alone is bypassable (`--no-verify`); CI alone gives no local signal. Both together is the standard belt-and-suspenders.
  3. **Defer all enforced invariants until product code lands (M2).** Rejected — the secret-scan and contract-integrity guarantees are enforceable now and protect the contract during the harness-building phase itself.
  4. **A third-party CI action for the contract gate.** Rejected — a small in-repo shell script (`scripts/check-contract-integrity.sh`) is dependency-free, runs identically in pre-commit and CI, and keeps the enforced rule reviewable in the repo.
- **Supersedes.** None.
- **Effects.**
  - Added `pyproject.toml` (Ruff + mypy config), `.editorconfig`, `.pre-commit-config.yaml`, `.github/workflows/ci.yml`, and `scripts/check-contract-integrity.sh`.
  - `docs/INVARIANTS.md` gains its first two entries (`M1-P3-INV-001`, `M1-P3-INV-002`).
  - Auto-fixing hygiene hooks are scoped to exclude the live-deploy paths (`AGENTS.md` §7) and `data/`, so the harness never churns those files.
  - The new CI workflow is quality-only and independent of the Cloud Build deploy pipeline (`cloudbuild.yaml`); the live Cloud Run deploy is unaffected.
  - Minimal tool-cache entries added to `.gitignore`; the full ignore pass remains M1-P4.

---

## M2-DL-001 — Adopt ADR-007 + its 3-packet M2 ladder

- **Date.** 2026-06-21
- **Decision.** Adopt **ADR-007** as the shaping decision for **M2 — `/api` skeleton**, structured as a **3-packet ladder**: **P1** monorepo split (PWA → `/app`; **Done** @ a77dfef); **P2** FastAPI `/api` skeleton — `GET /api/health`, env-driven read-only config, provider-port interface stub, the privacy precondition as a concrete forward guard, and the quality harness gaining teeth on `api/` (this packet); **P3** docker-compose + Postgres 16 / pgvector + the `/api` deploy path (incl. the nginx same-origin `/api` proxy). Two P2 implementation choices are recorded here: (a) `/api` is a **self-contained PEP 621 package** (`api/pyproject.toml`, with a `dev` optional-dependencies extra) while the **root `pyproject.toml` stays the single source of Ruff + mypy config**; (b) configuration uses **pydantic-settings `BaseSettings`** with required, default-less infra fields. The FastAPI health route is **`/api/health`** (not `/health`) — it avoids the existing nginx `/health` (the PWA container's Cloud Run check) and keeps the path stable for the P3 same-origin proxy.
- **Rationale.** The ladder reaches the M2 goal (`/api/health` green in CI and, at P3, deployed) without pulling P3's runtime into P2: at P2 the health endpoint is pure in-process, so nothing has to be stood up, the engine stays out of perimeter (a stub seam, not a live import), and the config guard establishes "all infra endpoints from env, no secret defaults" before any connection exists. Landing the harness teeth and the PII forward guard in P2 means contract drift, type errors, and PII-in-logs fail loudly from the first byte of backend code (AGENTS.md §4). The packaging choice keeps the M1-deliberate "root pyproject = tooling/contract-only" stance intact while letting each monorepo subtree own its dependencies.
- **Alternatives considered.**
  1. **PR M2 after P1 (split only).** Rejected — a milestone named "/api skeleton" with no `api/` is incoherent; the harness would still no-op.
  2. **Collapse P2+P3 into one packet.** Rejected — violates packet discipline and couples the in-process skeleton to runtime/deploy concerns (Postgres, compose, proxy) that have independent risk.
  3. **Root pyproject becomes a buildable package for the deps.** Rejected — reverses the M1-deliberate tooling-only stance and couples root to `/api` runtime deps.
  4. **stdlib `os.environ` config instead of pydantic-settings.** Rejected — pydantic-settings gives mypy-strict-clean, default-less required fields that fail loudly, with a thin marginal dependency (pydantic already ships with FastAPI).
- **Supersedes.** None — first entry in the M2 series.
- **Effects.**
  - Adds the `api/` package: `api/pyproject.toml`, `theygrow_api/{__init__,main,config,logging}.py`, `theygrow_api/ports/{__init__,provider}.py`, `api/tests/*`, `api/.env.example`.
  - Harness teeth: `.github/workflows/ci.yml` installs `./api[dev]` and runs `mypy api` + `pytest api` (replacing the zero-Python mypy guard); `.pre-commit-config.yaml` mypy hook gains `additional_dependencies` and checks `api/`.
  - `docs/INVARIANTS.md` gains `M2-P2-INV-001` (no child PII in logs — redaction forward guard) and `M2-P2-INV-002` (`/api` type- + test-gated in CI).
  - `docs/RUNTIME-INVARIANTS.md` "No child PII" entry moves `documented` → `enforced (forward guard)`, packet `M2-P2`.
  - `docs/execution-map.md` reconciled (M1 closed; M2 P1 Done, P2 Current); `docs/product/BuildPlan.md` M2 section gains the 3-packet ladder; `docs/RUNBOOK.md` gains `/api` local-dev instructions.
