# Enforced invariants — theygrow-app

## Bar

`INVARIANTS.md` is **enforced-only**. An invariant goes here only when a packet enforces it in code — a test, a lint rule, a schema constraint, a runtime guard, or a CI gate. Intent and runtime contract do **not** live here:

- **Intent-level invariants** (what the contract says we will do) live in `AGENTS.md` §2 and §3.
- **Documented runtime behavioral contract** (what the running system must do, before code lands) lives in [`RUNTIME-INVARIANTS.md`](RUNTIME-INVARIANTS.md).

Keeping this file enforced-only prevents it from drifting into a wish list.

## Invariants

### M1-P3-INV-001 — No secrets committed

- **Statement.** No secret or credential material is committed to the repository.
- **Enforced by.** `.pre-commit-config.yaml` (gitleaks hook) and `.github/workflows/ci.yml` (runs the gitleaks hook via `pre-commit run --all-files`, with full history fetched).
- **Landed in.** M1-P3.
- **Scope.** Covers tracked content and commit history reachable in CI. Public, non-secret identifiers (e.g. the GA4 Measurement ID, the GCP project id / region) are not secrets; if the scanner flags one, it is allowlisted in `.gitleaks.toml` as an exact non-secret. Genuine secrets are never allowlisted.

### M1-P3-INV-002 — Contract integrity

- **Statement.** Within the contract + spine documents, three conditions hold: (a) superseded stack names do not reappear as active targets; (b) the legacy pre-rename repository directory name does not appear; (c) live-infra identifiers stay confined to `docs/RUNBOOK.md`.
- **Enforced by.** `scripts/check-contract-integrity.sh`, wired into `.pre-commit-config.yaml` (local hook) and `.github/workflows/ci.yml`. The script holds the authoritative match patterns for all three checks; they are intentionally not restated inline here, since this file is itself within the scanned corpus.
- **Landed in.** M1-P3.
- **Scope.** Governs the contract + spine corpus: `AGENTS.md`, `CLAUDE.md`, `docs/INVARIANTS.md`, `docs/RUNTIME-INVARIANTS.md`, `docs/execution-map.md`, `docs/RUNBOOK.md`, `docs/product/BuildPlan.md`, `docs/product/TechSpec.md`, `.cursor/rules/masterplan.mdc`. Live-deploy paths are out of scope — they carry live-infra identifiers as operational reality. Historical artifacts (`docs/decision-log.md`, `data/mvp_masterplan.md`) are exempt — they record the superseded plan by design. This promotes the previously-manual P1/P2 negative-checks into an enforced gate. P4 tightened check (b) to a strict ban by removing its interim pairing exception once the residual naming sweep was complete.

### M2-P2-INV-001 — No child PII in logs / telemetry (forward guard)

- **Statement.** No known child-PII field (child name, diary text, birthdate / dob) is emitted through the logging boundary: known PII field names carried on a log record are redacted to `[REDACTED]` before any handler formats the record.
- **Enforced by.** `api/theygrow_api/logging.py` (`PiiRedactionFilter`) + `api/tests/test_logging_redaction.py`, run by `mypy api` + `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M2-P2.
- **Scope.** A **forward guard**: it establishes telemetry/redaction discipline from the first byte of backend code (AGENTS.md §4). At P2 there is **no live child-PII data path** — those arrive at M3 — so this covers the logging-boundary redaction *mechanism* and its test, not end-to-end coverage over live child data; coverage extends as data paths land (M3 → M5). It governs known structured PII field names only, not free-text message bodies.

### M2-P2-INV-002 — `/api` is type- and test-gated

- **Statement.** All Python under `api/` is type-checked (mypy strict) and unit-tested (pytest) on every CI run; a failure blocks the gate.
- **Enforced by.** `.github/workflows/ci.yml` (installs `./api[dev]`, runs `mypy api` + `pytest api`) and `.pre-commit-config.yaml` (mypy hook with `additional_dependencies`, checking `api/`).
- **Landed in.** M2-P2.
- **Scope.** Covers the `api/` subtree. Replaces the M1 zero-Python mypy guard with unconditional teeth now that `/api` exists. Does not cover `/app` (static PWA, no Python).

## Entry format (for future entries)

- **Id.** `M{N}-P{k}-INV-{NNN}` — `N` is the milestone number, `k` is the packet number within the milestone, `NNN` is zero-padded sequence within the packet (`001`, `002`, …).
- **Required fields.**
  - **Statement.** The invariant in one sentence.
  - **Enforced by.** File path(s) of the enforcing artifact — test, lint rule, schema constraint, runtime guard, or CI workflow.
  - **Landed in.** Packet id + commit SHA where enforcement was introduced.
  - **Scope.** What the invariant covers, and explicitly what it does not.
