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
- **Decision.** Adopt **ADR-007** as the shaping decision for **M2 — `/api` skeleton**, structured as a **3-packet ladder**: **P1** monorepo split (PWA → `/app`; **Done** @ a77dfef); **P2** FastAPI `/api` skeleton — `GET /api/health`, env-driven read-only config, provider-port interface stub, the privacy precondition as a concrete forward guard, and the quality harness gaining teeth on `api/` (this packet); **P3** docker-compose + Postgres 16 / pgvector + the `/api` deploy path. *(This wording originally read "(incl. the nginx same-origin `/api` proxy)"; that misrecorded ADR-007 — the origin-unification proxy is **M5**, not P3. Amended by **M2-DL-002**.)* Two P2 implementation choices are recorded here: (a) `/api` is a **self-contained PEP 621 package** (`api/pyproject.toml`, with a `dev` optional-dependencies extra) while the **root `pyproject.toml` stays the single source of Ruff + mypy config**; (b) configuration uses **pydantic-settings `BaseSettings`** with required, default-less infra fields. The FastAPI health route is **`/api/health`** (not `/health`) — it avoids the existing nginx `/health` (the PWA container's Cloud Run check) and keeps the path stable for the P3 same-origin proxy.
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

---

## M2-DL-002 — M2-P3 runtime + deploy path; ADR-007 P3-shape reconciliation; ADR-008 prod store

- **Date.** 2026-06-21
- **Decision.** Land the M2-P3 runtime + deploy path and reconcile three recordings.
  **(1) `/api` deploys as its own Cloud Run service** — its own URL, its own build-config — **not** behind an nginx same-origin `/api` proxy. Per **ADR-007**, the origin-unification router (the nginx `/api` proxy) is an **M5** concern, not P3. The M2-DL-001 P3 wording and the `BuildPlan.md` / `execution-map.md` P3 lines that placed the proxy in P3 misrecorded ADR-007 and are corrected here (proxy → M5). No CORS is exposed — the frontend↔API relationship stays same-origin by contract, unified at M5.
  **(2) Build topology.** Build-config relocates from the repository root into the owning subtree — `app/{Dockerfile,nginx.conf,cloudbuild.yaml}` (PWA) and `api/{Dockerfile,cloudbuild.yaml}` (API) — driven by **two self-contained per-app Cloud Build triggers** with `includedFiles` path filters (`app/**` → the PWA service; `api/**` → the `/api` service). Each subtree builds and deploys independently; a change in one does not rebuild the other. Each build uses its subtree as the Docker build context.
  **(3) Prod store (ADR-008).** The production episodic store is **managed Cloud SQL Postgres + pgvector** (→ AlloyDB by load). The repo's root `docker-compose.yml` (Postgres 16 + pgvector) is **strictly dev-only**; dev(compose) vs prod(managed) is a config difference — the P2 env guard already reads all connection/infra endpoints from the environment — not a code difference. M2-P3 opens **no** real DB connection from product code and creates **no** episodic schema/tables/migrations (those land in M3). The dev `db` service only enables the pgvector extension for parity.
- **Rationale.** Own-service deploy keeps the API an independently deployable unit (own image, build, rollout risk) and defers origin-unification to the milestone that needs same-origin chat (M5). Two path-filtered triggers mean a PWA change never rebuilds the API and vice-versa. Relocating each build-config into its owning subtree makes each app self-contained (mirroring the P2 packaging stance) and is the deliberate ADR-007 P3 step. Recording ADR-008 now fixes the dev/prod store boundary before any connection code exists, so M3 schema work targets the right surface.
- **Alternatives considered.**
  1. **nginx same-origin `/api` proxy in P3** (as originally recorded). Rejected — misreads ADR-007; the proxy is the M5 origin-unification router. Building it now pulls M5 surface into M2 and couples the API deploy to the PWA container.
  2. **One build-config building both images on every push.** Rejected — couples the two deploy units; every PWA change would rebuild/redeploy the API and vice-versa. Two path-filtered triggers keep them independent.
  3. **Keep build-config at the repository root.** Rejected — leaves the API build-config homeless and the PWA build-config detached from its subtree; the per-subtree relocation is the ADR-007 P3 step and makes each app self-contained.
  4. **Stand up managed Cloud SQL now.** Rejected — out of M2-P3 scope; no product code opens a connection yet. The env guard already makes dev/prod a config switch; provisioning is a later, owner-approved change.
- **Supersedes.** Amends the P3 description in **M2-DL-001** (nginx `/api` proxy: P3 → M5); does not supersede the entry.
- **Effects.**
  - Relocates `Dockerfile` / `nginx.conf` / `cloudbuild.yaml` from the repository root into `app/` (served `/` byte-identical); adds `api/Dockerfile`, `api/cloudbuild.yaml`, `api/.dockerignore`, a dev-only root `docker-compose.yml`, and `scripts/dev/init-pgvector.sql`.
  - `.pre-commit-config.yaml` hygiene-exclude patterns repoint to the relocated `app/` build-config paths and add the new `api/` build-configs, preserving the AGENTS.md §7 "never churn live-deploy paths" guardrail.
  - `scripts/check-contract-integrity.sh` check 3 extends `INFRA_RE` to also confine `theygrow-api-repo` to `docs/RUNBOOK.md`. The bare service name `theygrow-api` is intentionally **not** matched — it collides with the PEP 621 distribution name (`api/pyproject.toml`), the FastAPI app title, and the `/api/health` `service` value.
  - `docs/RUNBOOK.md` gains the `/api` live identifiers (the `/api` Cloud Run service, the `theygrow-api-repo` registry, image path, region) beside the existing `child-tracker-*` divergence, and records the relocated, two-trigger build + deploy path (including the PWA trigger filename change).
  - `docs/product/BuildPlan.md` (P3 line; proxy → M5 under M5) and `docs/execution-map.md` (P2 Done @ 4be3860; P3 Current; proxy → M5) corrected; `docs/product/TechSpec.md` monorepo + episodic-store notes reconciled (build-config relocated; dev compose vs managed prod store).
  - Owner-run GCP actions (create `theygrow-api-repo`; update the PWA trigger filename → `app/cloudbuild.yaml` with `includedFiles app/**`; create the `api/**` trigger; first deploy) are recorded as an owner checklist — Claude Code does not run `gcloud`.

---

## M3-DL-001 — M3 pre-execution gate: /export schema confirmed (SCHEMA_VERSION=1, D-029) + memory_rag lift map

- **Date.** 2026-06-22
- **Type.** Verification gate (reconnaissance only — no importer/schema/migration code, no git, no PR). Records the read-only confirmation that precedes any M3 implementation packet.
- **Subject.** The `diary-memory-service` engine (`src/memory_rag`) as the M3 `/export` migration source. Per **ADR-005** the engine is **out of perimeter**: code donor + `/export` corpus source **only**, never a live/runtime dependency of `theygrow-app`. This gate is a read of donor source; it introduces **no** runtime dependency on the engine.
- **Decision.** Confirm the v1 `/export` contract as the fixed import target for M3 and record the engine package map for the M4 lift. Specifically:
  1. **Export schema confirmed at SCHEMA_VERSION = 1 (D-029).** Document shape `{ "export": <envelope>, "records": [...] }`. Envelope = `format`, `schema_version`, `scope.{community_id, requester_user_id}`, `generated_at`, `record_count`. Each record is a flat `SourceMessage`: `source_message_id`, `community_id`, `author_user_id`, `external_chat_id`, `external_user_id`, `external_message_id`, `edit_seq`, `raw_text`, `detected_route`, `created_at`. Verified line-level against `core/export/serializers.py` (`_record_dict` / `_envelope_dict` / `serialize_json`), `core/export/models.py`, and the `SourceMessage` dataclass in `core/domain/models.py`.
  2. **v1 absences are structural, not incidental.** No `lifecycle_state`, no `event_date`/`valid_at`, no `note_date`, no chunks, no embeddings — confirmed absent from both the serializer output and the `SourceMessage` type. The export is the **raw pre-enrichment source layer** (engine invariants I-3 / R-1). M3 imports source rows; notes/chunks/embeddings are **re-derived** app-side at M4, never imported.
  3. **Idempotency key for the importer.** Primary natural key = engine `source_message_id` (already-minted stable UUID); composite assertion key = `(community_id, external_chat_id, external_message_id, edit_seq)` — the engine's own R-2 / D-023 key. `edit_seq` is significant: distinct edit-states of one message are distinct rows and must not be collapsed.
  4. **`valid_at` provenance limitation recorded.** Export `created_at` is the engine's **ingestion wall-clock (UTC)**, not the diary event date; the semantic event date (`Note.note_date`) is not in v1. M3 may set `valid_at := created_at` as a provenance-faithful default, recorded as a known limitation; true event-date recovery needs `raw_text` re-parse or a `schema_version ≥ 2` export.
  5. **`detected_route` enumerated.** Full `RouteKind` set (wire values, lowercase): `start, help, note, ask, draft, drafts, export, sources, clarify, unknown`. **Only `note` and `draft`** ever appear on an exported record (ingest — the sole `SourceMessage` constructor — is reached only by `NOTE`/`DRAFT`; `ask` persists a `Query`, others persist nothing). The "which routes become episodic" fork is therefore scoped to {note, draft}; unexpected route values get a defensive reject/quarantine default.
  6. **Engine package rename noted:** `diary_rag → memory_rag`. Lift seams for M4 recorded: ports at `core/answers/client.py`, `core/embeddings/client.py`, `storage/repository.py`, `storage/search_repository.py`; provider concretes isolated under `adapters/{answers,embeddings}/openai_client.py`; RRF in `services/retrieval.py`; grounded-ask assembly in `services/context_assembler.py` + `services/query_service.py`.
- **Rationale.** Pinning the import target to a line-verified v1 contract before writing any importer keeps M3 schema/migration work aimed at the actual wire shape and prevents importing fields the corpus does not carry. Confirming the {note, draft}-only reality of `detected_route` bounds the episodic fork to a real two-way decision instead of a ten-way one. Reading the donor source under ADR-005's out-of-perimeter rule (no import, no runtime edge) keeps the engine a corpus source, not a dependency.
- **Alternatives considered.**
  1. **Trust the orchestrator's snapped schema without line-level confirmation.** Rejected — a one-field/one-nesting drift (e.g. `scope` flattening, or `detected_route` member-vs-value casing) would propagate into the importer and the migration. The gate exists to catch exactly that.
  2. **Import notes/chunks/embeddings if a future export carried them.** Rejected for M3 — v1 carries none; M4 re-derivation is the perimeter-respecting path and avoids binding the app to engine-internal enrichment shapes.
  3. **Set `valid_at` from a re-parsed event date now.** Deferred — re-parsing `raw_text` is enrichment, out of the M3 source-import scope; recorded as a limitation instead.
- **Supersedes.** None — first entry in the M3 series. Builds on **ADR-005** (engine out of perimeter) and **ADR-008** (managed Postgres + pgvector store, the M3 import target).
- **Effects.** None on code or live infra — verification only. No files written by this gate beyond this decision-log entry. Authorizes the first M3 implementation packet (episodic source schema + `/export` importer) to be planned against the contract recorded here.

---

## M3-DL-002 — M3-P1 episodic source schema + migration: shape, type, and timestamp decisions

- **Date.** 2026-06-22
- **Decision.** Land the M3-P1 episodic **source layer** — the `source_messages` table and its Alembic migration — in the one managed PostgreSQL (ADR-008), opening the first real DB connection from product code. Schema only; the `/export` importer is M3-P2. The shape is fixed by the v1 wire contract (`M3-DL-001`) plus the following packet decisions:
  1. **Source-only (fork a = defer).** M3 writes **no** embeddings and makes **no** external provider calls anywhere. The `embedding` column is a **reserved, nullable `vector(1536)` shell** that is left unwritten and **unindexed** in M3 (no HNSW / IVFFlat on empty data). `1536` is a **ceiling placeholder, not a frozen dimension** — ADR-008 caps embeddings at ≤1536 (HNSW-indexable); the exact dimension is finalized at M4 with the provider/model choice (a provider-port parameter). Because M3 writes nothing, the ≤1536 ceiling already satisfies the invariant; narrowing the all-NULL shell at M4 is a cheap `ALTER`.
  2. **One table with a route discriminator (fork b = both-into-one-table).** A single `source_messages` table admits `detected_route` as a discriminator column carrying the lowercase wire value. No partitioning, no dropping; episodic-vs-staging eligibility is deferred to M4 retrieval-time filtering. A defensive `CHECK` admits the **full current 10-value `RouteKind` set** (`start, help, note, ask, draft, drafts, export, sources, clarify, unknown`) so a forward-compatible export cannot be rejected at the storage boundary — only `note`/`draft` reach an exported record today (`M3-DL-001` §5). Importer-side quarantine of non-`{note, draft}` rows is M3-P2.
  3. **`valid_at := created_at` (fork c = created_at).** `valid_at` is set by the M3-P2 importer to the engine ingestion wall-clock (`created_at`), a provenance-faithful **default-with-limitation**: no `raw_text` re-parse in M3; `raw_text` is retained so true event-date recovery stays possible later. Per **ADR-004** the table carries the dual-timestamp pair: `recorded_at` = **DB transaction time** (`server_default now()`), the moment theygrow-app wrote the row — distinct from `valid_at`.
  4. **Engine-faithful identifier types.** All wire identifiers are **`TEXT`**, matching the engine's own `source_messages` baseline DDL (read as donor source under ADR-005; no runtime dependency introduced). No identifier is guessed as `UUID`.
  5. **`edit_seq` is `BIGINT`** — a deliberate divergence from the engine's `INTEGER`. `edit_seq` is `0` for an original or the message `edit_date` epoch otherwise, which overflows `int32`; `BIGINT` future-proofs the composite assertion key and M3-P2 idempotency.
  6. **Composite assertion key includes `community_id`.** The `UNIQUE (community_id, external_chat_id, external_message_id, edit_seq)` follows the `M3-DL-001` key, scoping the engine's own 3-column key by community; `source_message_id` is the primary natural key.
  7. **Persona resolution is a stub.** `persona_id` is a nullable column with no FK and no person table; the importer leaves it NULL in M3. The real person model is gated (PDR-002 OQ#3, post-M5).
- **Rationale.** Pinning the schema to the line-verified wire shape, with engine-faithful types and the recorded idempotency key, keeps the source layer a truthful mirror of the corpus and makes M3-P2's idempotent upsert a direct consequence of the key. Reserving the embedding shell at the ≤1536 ceiling honors ADR-008 without committing to a provider dimension before M4, and refusing to index empty data avoids a meaningless index. The defensive route CHECK over the full enum trades nothing today for forward-compatibility. The `BIGINT` divergence is the one place engine fidelity yields to a correctness concern the engine's own `INTEGER` does not cover. Recording `recorded_at` as transaction time and `valid_at` as best-available event time lands the ADR-004 dual-timestamp columns without pulling in the gated bitemporal-state machinery.
- **Alternatives considered.**
  1. **Embed at import (fork a = embed-now).** Rejected for M3 — pulls a provider/key/cost and a child-PII egress decision (§4) into the source-import packet; M4 re-derivation is the perimeter-respecting path.
  2. **Partition drafts into a separate staging table now (fork b).** Rejected — premature; eligibility is a retrieval-time concern (M4), and one discriminated table keeps the importer and lineage simple.
  3. **Re-parse `raw_text` for the event date now (fork c).** Rejected — enrichment, out of the source-import scope; recorded as a limitation with `raw_text` retained for later backfill.
  4. **Mirror the engine's `INTEGER edit_seq` for exactness.** Rejected — an epoch `edit_seq` overflows `int32`; `BIGINT` is the safe key type.
  5. **Type identifiers as `UUID`.** Rejected — the engine stores them as `TEXT`; not all are UUIDs (external chat/message ids are channel-native strings). Faithful `TEXT` avoids a lossy/guessed cast on the uniqueness key.
- **Supersedes.** None. Builds on `M3-DL-001` (wire contract), **ADR-008** (managed Postgres + pgvector store), **ADR-004** (dual-timestamp), and **ADR-005** (engine out of perimeter).
- **Effects.**
  - Adds the `api/theygrow_api/db/` package (`engine.py` — lazy psycopg3 engine factory, the first real DB connection from product code; `models.py` — `Base` + `SourceMessage`), the Alembic scaffold (`api/alembic.ini`, `api/alembic/env.py`, `api/alembic/script.py.mako`, `api/alembic/versions/0001_source_messages.py`), and DB-backed constraint tests (`api/tests/conftest.py`, `api/tests/test_source_message_schema.py`).
  - `api/pyproject.toml` gains the store runtime deps (SQLAlchemy 2.0, psycopg3, pgvector, Alembic); the root `pyproject.toml` excludes `api/alembic/` from the strict mypy gate (migration plumbing, validated by the runtime constraint tests); the pre-commit mypy hook gains `sqlalchemy` + `pgvector`.
  - `.github/workflows/ci.yml` adds a `pgvector/pgvector:pg16` service + `DATABASE_URL` to the quality job so the DB-backed tests run in CI. No GCP, no deploy coupling.
  - `docs/execution-map.md` reconciled (M2 **Done**; M3 gate **Done**, P1 **Current**).
  - Out of this packet: the `/export` importer (M3-P2); embedding population / vector index (M4); notes/chunks/retrieval/chat (M4/M5); the full persona model and all `AGENTS.md` §5 gated items.

---

## M3-DL-003 — M3-P2 `/export` v1 importer: invocation surface, quarantine shape, fail-closed posture

- **Date.** 2026-06-23
- **Decision.** Land the M3-P2 importer — an **offline batch** entrypoint that reads a v1 `/export` JSON file and idempotently lands its records into `source_messages` (M3-P1 schema). The wire contract is fixed by `M3-DL-001`; this entry records the P2-level operational choices:
  1. **Invocation surface = offline module/CLI under `api/`.** A `theygrow_api.importer` module exposes `import_export(path, ...) -> RunSummary` and a `main()` CLI (`theygrow-import-export` console script; also `python -m theygrow_api.importer <path>`). Input is a **path to an `/export` file**. There is **no `/api` HTTP import endpoint** in M3. The engine stays out of perimeter (ADR-005): the importer reads a file — no network, no live engine calls.
  2. **Fail-closed validation, atomic.** `schema_version` must be `1`; the envelope and every record's shape/types are validated **before any write**. The envelope integrity check `record_count == len(records)` is **required** — a mismatch aborts the whole run. The 10 v1 wire fields must be present exactly (missing/extra keys, wrong types, an unknown `detected_route`, or a non-tz-aware `created_at` all fail closed). The upsert runs in a single transaction, so malformed input writes **nothing** (no partial-silent drops).
  3. **Idempotent upsert.** Live rows upsert on the composite assertion key `(community_id, external_chat_id, external_message_id, edit_seq)`; the `SET` clause excludes **`recorded_at`** (preserves the first-recorded instant) **and the `source_message_id` PK** (stable identity), and does not touch `persona_id` / `embedding`. Re-running the same file → zero duplicates, no drift. `valid_at := created_at` per-row; `persona_id` / `embedding` left NULL.
  4. **Quarantine = reject-with-report, MINIMIZED sidecar.** Records whose `detected_route` is a valid RouteKind but not in `{note, draft}` are **not** inserted into the live source set (only `note`/`draft` reach an exported record today — `M3-DL-001` §5; others are a forward-compat / corruption signal even though the P1 CHECK admits all 10). They are written to a sidecar JSON report whose entries carry **exactly `{source_message_id, detected_route, reason}`** (`reason` = the machine token `non_live_route`) and tallied as `quarantined` in a counts-only run summary (inserted / updated / quarantined / skipped).
  5. **§4 minimization of the sidecar.** The report deliberately **omits** `community_id`, `external_chat_id`, `external_message_id`, `external_user_id`, `author_user_id`, `edit_seq`, and `raw_text`. `source_message_id` is the engine-minted UUID — unique per record and sufficient to locate the row back in the `/export` file — whereas the `external_*` / community keys are family-identifying and unnecessary for diagnosis (AGENTS.md §4). The default sidecar path (`<export>.quarantine.json`) is gitignored (`*.quarantine.json`) so it cannot be committed accidentally; the path is configurable via `--quarantine-report`.
- **Rationale.** An offline file importer keeps M3 within the ADR-005 perimeter and avoids standing up an import API surface before M5 chat needs one. Validating fail-closed and upserting atomically makes a corrupt or wrong-version export a loud no-op rather than a half-written table. Anchoring idempotency on the engine's own assertion key, with `recorded_at`/PK excluded from the update, makes "re-run is a no-op" a direct property of the key. Quarantining non-`{note, draft}` rows keeps forward-compat/corruption out of the live source set without rejecting the whole file; recording them by the engine UUID alone gives an audit trail at the **minimum** identifier footprint §4 allows.
- **Alternatives considered.**
  1. **`/api` HTTP import endpoint.** Rejected for M3 — pulls an API surface (auth, request limits, streaming large bodies) into a source-import packet; offline batch is the perimeter-respecting shape. Revisit if M5 needs operator-triggered import.
  2. **Quarantine to a counts-only summary (no artifact).** Rejected — leaves no per-row audit trail for forward-compat/corruption triage.
  3. **Quarantine to a new DB table.** Rejected — expands the P1 schema surface (a new migration + constraint tests) for a diagnostic that a sidecar serves; out of M3's minimal scope.
  4. **Wider sidecar key set (full assertion key + route).** Rejected on §4 grounds — the `external_*` / community keys are family-identifying and not needed to locate a record given the unique engine UUID; the minimized three-field shape is the chosen form.
  5. **Optional `record_count` check.** Rejected — making the envelope integrity check required catches truncated/mis-serialized exports at the boundary rather than silently importing a short file.
- **Supersedes.** None. Builds on `M3-DL-001` (wire contract + idempotency key), `M3-DL-002` (P1 schema, including the importer-side quarantine note), **ADR-004** (dual-timestamp; `recorded_at` preserved), and **ADR-005** (engine out of perimeter).
- **Effects.**
  - Adds `api/theygrow_api/importer.py` (validation, route partition, idempotent upsert, minimized quarantine report, counts-only summary; `import_export()` + `main()`), `api/tests/test_import_export.py` (DB-backed: happy path, idempotent re-import, `recorded_at` preserved, `edit_seq` distinct rows, quarantine, sidecar minimization, and fail-closed cases), and a synthetic `api/tests/fixtures/export_v1_sample.json` (no real child data).
  - `api/pyproject.toml` gains a `[project.scripts]` `theygrow-import-export` console entry; `.gitignore` ignores `*.quarantine.json`.
  - `docs/execution-map.md` reconciled (M3-P1 **Done** @ 415a5a2; M3-P2 **Current**).
  - Out of this packet: embedding population / vector index (M4); notes/chunks/retrieval/chat (M4/M5); the persona model and all `AGENTS.md` §5 gated items; `raw_text` re-parse for true event dates (`valid_at := created_at` stands, `M3-DL-001` §4).
