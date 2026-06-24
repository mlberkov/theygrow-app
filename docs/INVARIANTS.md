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

### M4-P1-INV-001 — Sparse FTS leg is index-backed

- **Statement.** The sparse (lexical) retrieval leg matches against a generated, DB-maintained `tsvector` (`event_chunks.chunk_text_tsv`, `to_tsvector('simple', chunk_text)`) backed by a GIN index, and is community-scoped — a query never crosses community boundaries.
- **Enforced by.** `api/alembic/versions/0002_notes_event_chunks.py` (the GENERATED STORED column + `idx_event_chunks_chunk_text_tsv` GIN index) + `api/tests/test_search_repository.py` (match, `ts_rank_cd` ordering, community scoping, inclusive `note_date` range, empty-query / non-positive-limit short-circuits), run by `mypy api` + `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P1.
- **Scope.** Covers the sparse leg's **mechanics** only. It does **not** establish Russian lexical recall adequacy: the `'simple'` config does no morphological stemming (the documented limitation and named port-out trigger, `M4-DL-001`); recall is measured at the M4-close mini-eval, not here. The dense leg, RRF fusion, and the episodic-eligibility filter are out of scope (M4-P2/P3).

### M4-P1-INV-002 — Re-derivation is idempotent

- **Statement.** Re-running the offline `notes` / `event_chunks` re-derivation over the same `source_messages` converges to the same derived rows — no duplication and no drift (deterministic ids + delete-then-insert over the processed source ids).
- **Enforced by.** `api/theygrow_api/derivation.py` (deterministic `note_id` / `chunk_id`; delete-then-insert) + `api/tests/test_rederive.py` (`test_rederive_is_idempotent`, plus the derived-layer / fallback / `valid_at`-recovery / route-scoping cases), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P1.
- **Scope.** Covers the offline re-derivation pass over already-imported live `{note, draft}` rows. Embeddings are out of scope (M4-P2); the pass writes none.

### M4-P1-INV-003 — Operational signals are §4-safe

- **Statement.** Every emitted operational signal carries only counts / ids / timings — never child diary text (`raw_text` / `chunk_text`) nor family-identifying ids (`community_id`). Signals emit through the single `SignalSink` seam, whose default implementation routes through the PII-guarded logging boundary.
- **Enforced by.** `api/theygrow_api/signals.py` (typed `Signal.fields()` payloads + `LoggingSignalSink` over the `logging.py` boundary) + `api/tests/test_signals.py` (asserts payloads exclude the §4 field set and are numeric) + the emission assertions in `api/tests/test_rederive.py` / `api/tests/test_search_repository.py`, run by `mypy api` + `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P1.
- **Scope.** Covers the P1-emitted signals (derivation counters; sparse candidate count + latency). Downstream kinds (`grounding.coverage`, `degradation.event`) are defined in the taxonomy but not emitted until their producing code lands (P3/P4); the §4 payload constraint binds them when they do.

### M4-P2-INV-001 — Per-chunk embedding is dimension-pinned and drift-guarded

- **Statement.** The dense leg's vector is per-chunk on `event_chunks.embedding`, typed `vector(1536)` as a frozen literal in the migration DDL; the schema-bound `embedding_dimension` surface value is linked to the live column type by a drift guard (a surface bump without a matching migration fails). The M3 dormant per-`source_message` `embedding` shell is dropped (per-chunk granularity is final).
- **Enforced by.** `api/alembic/versions/0003_event_chunk_embeddings.py` (the `vector(1536)` column + the dropped shell) + `api/tests/test_parameters.py` (`test_embedding_dimension_surface_matches_frozen_schema_ddl`, reading `format_type` over the live column) + `api/tests/test_embedding_schema.py` and `api/tests/test_source_message_schema.py` (`test_source_messages_has_no_embedding_column`), run by `mypy api` + `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P2.
- **Scope.** Covers the per-chunk vector's storage shape, the surface↔schema dimension link, and the dropped shell. It does not cover retrieval quality or the dense leg's ranking (RRF is M4-P3).

### M4-P2-INV-002 — Embeddings backfill is fail-closed without the ZDR clearance gate

- **Statement.** The offline embeddings backfill sends no `chunk_text` to the embedder and writes nothing unless the operator-set `embedder_privacy_cleared` flag (the ZDR + DPA + EU-residency clearance) is set — and, on the real path, the embedder endpoint/key are present. With the gate unmet the run refuses before any provider call or DB write (zero provider calls, zero writes).
- **Enforced by.** `api/theygrow_api/embeddings_backfill.py` (`_ensure_embedder_cleared` / `_build_provider`, raising `EmbedderNotReady` before any text egress) + `api/theygrow_api/config.py` (the default-false `embedder_privacy_cleared` flag) + `api/tests/test_embeddings_backfill.py` (`test_fail_closed_when_uncleared`, `test_fail_closed_when_unconfigured`), run by `mypy api` + `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P2.
- **Scope.** A structural §4 gate over the one permitted child-text egress (ADR-011 §1). It governs the offline backfill path; there is no live request path that embeds (chat is M5). It binds the gate mechanism, not the external provider's actual ZDR posture (an operational precondition the owner clears).

### M4-P2-INV-003 — Embeddings backfill is idempotent and index-after-population

- **Statement.** The backfill embeds only `pending` (and, unless `--no-retry-failed`, `failed`) chunks and skips `ready` ones, so a re-run over a fully-embedded corpus is a no-op (no duplicate writes, no extra provider calls); a provider error marks the batch `failed` for retry, never a partial vector. The HNSW index is built by the backfill AFTER bulk population, not by the migration.
- **Enforced by.** `api/theygrow_api/embeddings_backfill.py` (status-driven selection; `CREATE INDEX IF NOT EXISTS` after population) + `api/tests/test_embeddings_backfill.py` (`test_backfill_is_idempotent`, `test_backfill_marks_failed_then_retries`, `test_backfill_builds_hnsw_index_after_population`) + `api/tests/test_embedding_schema.py` (`test_migration_alone_builds_no_hnsw_index`), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P2.
- **Scope.** Covers the offline backfill pass over already-derived chunks. Embedding quality / vector correctness beyond dimension is out of scope; the injected fake provider exercises mechanics, not a live embedder.

## Entry format (for future entries)

- **Id.** `M{N}-P{k}-INV-{NNN}` — `N` is the milestone number, `k` is the packet number within the milestone, `NNN` is zero-padded sequence within the packet (`001`, `002`, …).
- **Required fields.**
  - **Statement.** The invariant in one sentence.
  - **Enforced by.** File path(s) of the enforcing artifact — test, lint rule, schema constraint, runtime guard, or CI workflow.
  - **Landed in.** Packet id + commit SHA where enforcement was introduced.
  - **Scope.** What the invariant covers, and explicitly what it does not.
