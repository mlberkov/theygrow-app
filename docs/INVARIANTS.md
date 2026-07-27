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

### M4-P3-INV-001 — Episodic eligibility is note-only, enforced in both retrieval legs

- **Statement.** Only chunks whose `source_messages.detected_route='note'` are retrievable; `draft` chunks — though embedded and indexed — are dropped at retrieval by a hard FK-join WHERE in BOTH the sparse and dense legs, so the fused result inherits note-only by construction (ADR-012, fork b). The filter is binary and always-on (not a tier/weight knob); `detected_route` stays on `source_messages` (not denormalized).
- **Enforced by.** `api/theygrow_api/retrieval/search_repository.py` (the `detected_route='note'` join on both `sparse_candidates` and `dense_candidates`) + `api/theygrow_api/services/retrieval.py` (`retrieve` fuses only the filtered legs) + `api/tests/test_search_repository.py` (`test_both_legs_exclude_draft_route`) + `api/tests/test_retrieval.py` (`test_retrieve_excludes_draft_end_to_end`), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P3.
- **Scope.** Covers the retrieval-layer eligibility filter (which chunks may surface). It does not cover grounded-ask assembly or the "no verified info" honest-degradation message (P4), nor retrieval ranking quality.

### M4-P3-INV-002 — Every config-surface parameter carries value provenance

- **Statement.** Every `Parameter` rendered by `current_parameters()` carries a non-empty `changed_in` decision-log id, so the parameters-as-data surface is fully traceable — a knob added without provenance fails the gate (ADR-013 operability; closes OQ#1, structural half).
- **Enforced by.** `api/theygrow_api/parameters.py` (each `Parameter` sets `changed_in`) + `api/tests/test_parameters.py` (`test_every_parameter_carries_nonempty_changed_in`), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P3.
- **Scope.** Covers the presence + non-emptiness of `changed_in` on every surface parameter. It does not assert the id resolves to a real decision-log entry, nor validate the `scope` classification.

### M4-P3-INV-003 — Emitted signal kinds are wired to real producers

- **Statement.** The set of `SignalKind` declared `emitted_now=True` in the taxonomy equals the set actually emitted when the known producers run — so flipping a defined-not-emitted kind (`GROUNDING_COVERAGE` / `DEGRADATION_EVENT`) to `emitted_now=True` without a producer fails the gate, and a new emitted producer must register here (ADR-013 operability; closes OQ#1, structural half).
- **Enforced by.** `api/theygrow_api/signals.py` (the `SIGNAL_TAXONOMY` `emitted_now` flags) + `api/tests/test_signal_emitters.py` (`test_every_emitted_now_kind_has_a_wired_producer`, driving `rederive` / the sparse leg / `embed_backfill` / `query_service.answer_query` through a recording sink and comparing kind-sets; `test_no_defined_not_emitted_kinds_remain_as_of_p4`), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P3 (extended M4-P4: the two P4 kinds `GROUNDING_COVERAGE` + `DEGRADATION_EVENT` were flipped to `emitted_now=True`, so the test now REQUIRES their real emission via the `answer_query` driver).
- **Scope.** The explicit-coupling form: the test enumerates the known producers and asserts the emitted-kind set matches the `emitted_now=True` set. It guarantees no `emitted_now` kind is unproduced and no enumerated producer emits an undeclared kind; it does not reflectively discover producers not listed in the test (adding one requires extending the driver).

### M4-P4-INV-001 — Answer synthesis is fail-closed without the answers ZDR clearance gate

- **Statement.** The grounded-ask service sends family context to the answers LLM and synthesizes an answer ONLY when `answers_privacy_cleared` is set; uncleared (or endpoint/key missing) it raises `AnswersNotReady` before any provider call or text egress — even with a provider injected — making ZERO answers-provider calls (ADR-014, per-egress clearance; the answers LLM is a distinct residency surface from the embedder, so the embedder's clearance does not clear it).
- **Enforced by.** `api/theygrow_api/services/query_service.py` (`_ensure_answers_cleared` runs first, before `retrieve`/build/call) + `api/tests/test_query_service.py` (`test_answers_fail_closed_when_uncleared_zero_calls`, asserting `AnswersNotReady` and zero recorded provider calls), run by `pytest api` in `.github/workflows/ci.yml`.
- **Landed in.** M4-P4.
- **Scope.** Covers the answers/chat egress only (the second §4 surface); the query-embedding egress stays gated by `embedder_privacy_cleared` inside `retrieve()` (M4-P3-INV / ADR-011). It is a structural refusal (loud no-op), not a content degradation.

### M4-P4-INV-002 — Grounded answers are closed-corpus or honestly degraded

- **Statement.** A non-`None` `answer_text` is produced ONLY from retrieved + cited family episodic memory — never a parametric/model or web fallback. Three independent edges enforce this: the prompt carries only retrieved `chunk_text`; the parser rejects any `cited_chunk_id` absent from the assembled context (a fabricated citation → suppressed `parse_failure`); and a pre-provider grounding gate (`grounding_min_segments`) returns an honest `no_evidence` result with ZERO provider calls below the bar. A model-declared `no_evidence` (present-but-irrelevant context) also suppresses the answer.
- **Enforced by.** `api/theygrow_api/services/context_assembler.py` (`parse_structured_answer` citation grounding) + `api/theygrow_api/services/query_service.py` (the grounding gate + degradation contours) + `api/tests/test_query_service.py` (`test_fabricated_citation_is_parse_failure`, `test_no_context_degrades_with_zero_answers_calls`, `test_present_but_irrelevant_context_llm_declares_no_evidence`), run by `pytest api`.
- **Landed in.** M4-P4.
- **Scope.** Family episodic memory is the only grounded source at M4 (canon/KB is M5, out of perimeter), so provenance is family-observation lineage only. Grounded-but-uncertain answers are RETURNED with an honesty flag (ADR-015), not suppressed — they remain closed-corpus (cited retrieved context). These are deterministic seam-mechanics guarantees with injected fakes; real retrieval recall / grounding QUALITY is the M4-CLOSE eval, not enforced here.

### VDK-P3-INV-001 — App consumes the KB only via the vendored versioned artifact

- **Statement.** The app consumes the domain KB exclusively via the vendored, versioned artifact `app/kb-v{N}.json` under the KB-artifact contract: the in-memory shape is produced by the app-side adapter (`adaptNewDataFormat`) with additive-evolution tolerance, there is no code import from `theygrow-domain-kb`, and the artifact is **byte-as-published** — the app never edits KB data (fixes are producer-side and arrive as a new artifact version). *(Namespace note: id mirrors the `VDK-P{k}` packet namespace of the M(В)-1 vendor-domain-kb-artifact track, owner-decided 2026-07-04 — first non-`M{N}` INV namespace; the "Entry format" footer below is intentionally left unedited, matching how the decision-log treats its non-spine namespaces.)*
- **Enforced by.** `scripts/sync-kb-artifact.sh` (tag-anchored vendoring from the domain-kb release tag `kb-v{N}`, byte-identical; verifies the artifact exists in the tag and `"kb_version"` equals the filename `N`) + `.pre-commit-config.yaml` (`trailing-whitespace` / `end-of-file-fixer` excludes for `app/kb-v1\.json` — the rewriting hooks never touch the artifact, while `check-json` validates it read-only on every commit).
- **Landed in.** VDK-P2 (vendoring mechanism + byte-as-published excludes); VDK-P3 (exclusivity — the inline data source was deleted from `app/index.html`).
- **Scope.** Covers the vendoring-seam **mechanics**: byte-identity to the published artifact, the version-tag anchor, `kb_version`-matches-filename, and hooks-never-rewrite. The *exclusivity* half is structural since VDK-P3 (no inline data source remains to silently regress to) but not machine-gated — no CI check greps `index.html` for re-inlined data. KB data **quality** (including the two frozen-174 curation defects riding along byte-as-published) is producer-side (`theygrow-domain-kb`), explicitly not covered.

### A1-P1-INV-001 — The spa-split refactor is gated by a three-level parity suite

- **Statement.** Every A1 `spa-split` packet must pass an automated three-level parity threshold against committed baselines of the pre-split app: **(a)** DOM-snapshot equality for `header`, `#mainTable` (head, body digest, and full-body hash), `footer.control-footer`, `#zpdEmptyState` and the four modals across four boot states at two viewports, plus a SHA-256 per skill-modal body for all 174 skills; **(b)** pixel-equal screenshots of those surfaces at 1280×800 and 412×760, captured on a platform fixed by a pinned browser container rather than by the CI runner image; **(c)** behavioural smoke over the main tick → ZPD-recompute → persist → reload loop, the no-profile honest-degradation refusal, the activity→skill deep link and modal stack, service-worker registration / offline boot from precache / the PWA update flow, and the kb-load error path. Baselines are never written implicitly: `updateSnapshots: 'none'` makes a missing or changed baseline fail, and only an explicit `--update-snapshots` run may rewrite one. *(Namespace note: id follows the `A1-P{k}` packet namespace of the spa-split milestone, mirroring the `VDK-P3-INV-001` precedent for a non-`M{N}` namespace; the "Entry format" footer below is intentionally left unedited, matching how the decision-log treats its non-spine namespaces.)*
- **Enforced by.** `app/tests/dom-parity.spec.js`, `app/tests/visual.spec.js`, `app/tests/behavior.spec.js` and `app/tests/delivery-contract.spec.js` against the committed baselines in `app/tests/__baselines__/`, configured by `app/playwright.config.js` (`updateSnapshots: 'none'`, `retries: 0`) and run by `scripts/parity-suite.sh` — invoked as the `parity` job in `.github/workflows/ci.yml`. Determinism is held by a pinned clock (`app/tests/support/seed.js`, `page.clock.setFixedTime`) and a pinned browser container; `app/tests/delivery-contract.spec.js` additionally parses `app/nginx.conf` and fails when the delivery rules mirrored by `app/tests/server.js` diverge from it.
- **Landed in.** A1-P1.
- **Scope.** Covers refactor-equivalence of the shipped `/app` surfaces listed above, in one pinned headless Chromium, served by a mirror of `app/nginx.conf`. It does **not** cover real-device rendering, other browser engines, on-device PWA install/splash behaviour, accessibility or performance — those remain owner on-device smoke steps under the ADR-020 gate. It asserts that behaviour did not change; it does not assert that the behaviour it froze is *correct* (the fixed state it baselines is `A0-DL-001` + `A1-DL-001`). The suite is dev/CI-only and is excluded from both the production image and the Docker build context, so it constrains no runtime behaviour.

## Entry format (for future entries)

- **Id.** `M{N}-P{k}-INV-{NNN}` — `N` is the milestone number, `k` is the packet number within the milestone, `NNN` is zero-padded sequence within the packet (`001`, `002`, …).
- **Required fields.**
  - **Statement.** The invariant in one sentence.
  - **Enforced by.** File path(s) of the enforcing artifact — test, lint rule, schema constraint, runtime guard, or CI workflow.
  - **Landed in.** Packet id + commit SHA where enforcement was introduced.
  - **Scope.** What the invariant covers, and explicitly what it does not.
