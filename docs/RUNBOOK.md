# Runbook — theygrow-app

Operational reality of `theygrow-app` today, plus the live-infra divergence note. This file is the single source for live-infra identifiers — the contract files (`AGENTS.md`, `CLAUDE.md`) keep their guardrails as unnamed file paths and link here instead.

## What runs today

The product in production is a **static PWA** served by nginx and deployed on GCP Cloud Run. The served PWA assets live under `/app` (the M2-P1 monorepo split moved them there from the repository root); in M2-P3 the build-config relocated from the repository root into the owning subtrees — PWA build-config under `/app`, API build-config under `/api`. The `/api` backend now deploys as **its own Cloud Run service** on its own URL (see below).

- Entry point: `app/index.html` (single-file PWA).
- PWA assets: `app/manifest.json`, `app/sw.js`, `app/offline.html`, `app/icons/`.
- KB artifact: `app/kb-v1.json` — the vendored, versioned domain-KB artifact (vault ADR-026; curation home is the separate `theygrow-domain-kb` repo). The app is a pure READER: it boots by fetching `/kb-v1.json` (no inline data copy since VDK-P3). Served immutable by nginx (versioning-by-filename, vault ADR-024) and precached by the SW. Consumed byte-as-published (`VDK-P3-INV-001`); re-vendoring and version bumps are owner-run — see **KB artifact** below. See `VDK-DL-001`.
- App icons (install surface): the brand logo/favicon set under `app/icons/` — manifest `purpose: "any"` 192/512 (`icon-logo-192/512.png`) + `purpose: "maskable"` 192/512 (`maskable-192/512.png`), the `<head>` `rel="icon"` PNGs `favicon-16/32.png` + `rel="apple-touch-icon"` `apple-touch-icon.png` (180×180) — all precached by `app/sw.js` (`CACHE_VERSION v7`, which also delivers them to installed clients via the network-first SW + `#updateBanner` path). A discrete `favicon.ico` is intentionally **absent** (PNG-only): the PNG `rel="icon"` links cover the browser tab and the bare `/favicon.ico` probe 404s harmlessly. The assets use a new-filename scheme (`icon-logo-`, `maskable-`, `apple-touch-icon`, `favicon-*`) replacing the old placeholders, so a `CACHE_VERSION` bump re-fetches them fresh (versioning-by-filename, vault ADR-024). See `ICON-DL-001`.
- Update delivery: the service worker (`app/sw.js`) serves the app shell **network-first**, so an installed client picks up the freshly deployed `app/index.html` on its next navigation (no hard-refresh); a newly installed worker parks in `waiting` and the page surfaces an in-app "Обновить" banner (`app/index.html`) — the user drives activation rather than the worker auto-applying. See `PWA-DL-001`.
- Web server: nginx (configured by `app/nginx.conf`) inside the container.
- Cache surface: the per-path `Cache-Control` headers — including `/sw.js` `no-cache, must-revalidate` (so a redeployed worker is always re-fetched) — live in `app/nginx.conf`. `app/cloudbuild.yaml` carries **no** cache directives; cache behaviour is entirely an nginx concern.
- Container: `app/Dockerfile` (nginx-based).
- CI / CD: GCP Cloud Build — `app/cloudbuild.yaml` builds/deploys the PWA; `api/cloudbuild.yaml` builds/deploys the `/api` service.
- Hosting: GCP Cloud Run (two services: the PWA, and `/api`).

The Python / FastAPI backend (`/api`) skeleton landed in M2-P2; in M2-P3 it gained its deploy path and now runs **deployed** as its own Cloud Run service (own image + build-config + trigger), with `/api/health` green on its own URL. It is **not** behind the PWA's nginx — the same-origin `/api` proxy (origin unification) is M5, not P3.

## Build + deploy path

The deploy is fully driven by Cloud Build. There are **two self-contained per-app build-configs**, each driven by its **own** Cloud Build trigger with an `includedFiles` path filter, so a change in one subtree never rebuilds the other. See the build-config files for the canonical build steps; do not duplicate them here.

- **PWA:** `app/cloudbuild.yaml` builds the container from `app/Dockerfile` (build context `app/`), pushes to Artifact Registry, deploys to the PWA Cloud Run service. Trigger: push to `main`, `filename = app/cloudbuild.yaml`, `includedFiles = app/**`.
- **`/api`:** `api/cloudbuild.yaml` builds from `api/Dockerfile` (build context `api/`), pushes to Artifact Registry, deploys to the `/api` Cloud Run service. Trigger: push to `main`, `filename = api/cloudbuild.yaml`, `includedFiles = api/**`. No `--set-env-vars` — `/api/health` needs no environment; real DB config lands with M3.
- **Promotion gate (L1, ADR-020).** No standalone staging *service* exists. Instead `app/cloudbuild.yaml` Step 3 deploys the PWA with `--no-traffic --tag sha-$SHORT_SHA`, so each push lands a 0%-traffic, sha-tagged revision and the live revision keeps serving until the owner smoke-tests and promotes. See **Promotion + rollback** below.

### Promotion + rollback (L1 deploy-safety gate)

> **Owner GCP action.** Every `gcloud` command below is run by the owner against the live project — Claude Code does not run them. The PWA Cloud Run service `child-tracker-service` and region `europe-west1` are the live-infra identifiers carried in this RUNBOOK (see "Live-infra divergence"); the contract files do not name them.

1. **What the deploy does.** `app/cloudbuild.yaml` Step 3 deploys `child-tracker-service` with `--no-traffic --tag sha-$SHORT_SHA`. Each push lands a fresh revision at **0% traffic**, reachable only via its **per-revision** `sha-<SHORT_SHA>` tagged URL. The live revision is untouched until promotion.
2. **Get the tagged URL.** The tag is per-revision (sha-specific), so smoke the *just-deployed* revision — not a persistent URL. Read the tagged URL from the Cloud Build deploy log, or:
   `gcloud run services describe child-tracker-service --region europe-west1 --format 'value(status.traffic)'`
   (the tagged URL has the form `https://sha-<SHORT_SHA>---child-tracker-service-<hash>.europe-west1.run.app`).
3. **Smoke the tagged revision** (owner/manual, no JS toolchain) — against the tagged URL `$TAG_URL`:
   - Health: `curl -fsS "$TAG_URL/" -o /dev/null -w '%{http_code}\n'` → `200`.
   - Live-DOM (app shell served): `curl -fsS "$TAG_URL/" | grep -q '<title>Child Dev Tracker</title>'` → exit 0.
   - Live-DOM (update banner present): `curl -fsS "$TAG_URL/" | grep -q 'id="updateBanner"'` → exit 0.
   - Worker re-fetched fresh: `curl -fsSI "$TAG_URL/sw.js"` → `200` with `Cache-Control: no-cache, must-revalidate` (the `/sw.js` header from the cache-surface note above).
   - KB artifact immutable: `curl -fsSI "$TAG_URL/kb-v1.json"` → `200` with `Cache-Control: public, immutable, max-age=31536000` (the narrow `^/kb-v[0-9]+\.json$` nginx location).
   - KB artifact integrity (ADR-020 gate): `curl -fsS "$TAG_URL/kb-v1.json" | sha256sum` → must equal `sha256sum app/kb-v1.json` at the deployed commit (served == vendored, byte-as-published; for the current artifact: `03a71f2e6336095d0e7fa8ffd575e32bceae8d557e5c8e721e28c40537dcc9ab`).
4. **Promote.** Shift 100% traffic to the just-smoked revision:
   `gcloud run services update-traffic child-tracker-service --to-latest --region europe-west1`.
5. **Rollback / abort.**
   - **Abort (no promotion):** do nothing — withholding promotion leaves prod on the prior revision (the no-traffic revision serves no users).
   - **Roll back after promotion:** pin traffic to the previous good revision:
     `gcloud run services update-traffic child-tracker-service --to-revisions <prev-revision>=100 --region europe-west1`.
6. **Tag accumulation.** Promotion does **not** remove the `sha-` tag, so tags accumulate across deploys. They are harmless (each just routes 0% traffic to an old revision) and are pruned **out-of-band** by the owner when desired — e.g. `gcloud run services update-traffic child-tracker-service --remove-tags sha-<old> --region europe-west1`, or delete the stale revision outright (`gcloud run revisions delete <rev> --region europe-west1`). No automated pruning this packet.

## KB artifact (owner-run sync + version bump)

> **Owner action.** The sync is owner-run, RUNBOOK-style — deliberately **not** wired into pre-commit/CI (`scripts/sync-kb-artifact.sh` header records the design). The app consumes the artifact **byte-as-published** (`VDK-P3-INV-001`): never hand-edit `app/kb-v{N}.json`; data fixes happen producer-side in `theygrow-domain-kb` and arrive as a new artifact version.

1. **Sync / re-vendor a version.** `scripts/sync-kb-artifact.sh <N> [kb-repo-url-or-path]` vendors `compiled/kb-v{N}.json` from the `theygrow-domain-kb` **release tag** `kb-v{N}` (vault ADR-026 §2 tag-anchor annotation) into `app/kb-v{N}.json`, byte-identical — never floating `main` (`compiled/` holds only the current version, so the tag is the only reproducible anchor for a frozen version). Idempotent: a re-run overwrites with identical bytes. The script verifies the artifact exists in the tag and `"kb_version"` equals the filename `N`; deeper schema validation stays producer-side.
2. **Bump to a new artifact version (new `kb-v{N}.json`)** — the full consumer-side checklist (each step is required; the nginx location `^/kb-v[0-9]+\.json$` and the sync script are N-generic and need no change):
   1. Run the sync for the new `N` (step 1) — lands `app/kb-v{N}.json`.
   2. `app/index.html` — update the fetch-URL literal (`kbReady = fetch('/kb-v{N}.json')`); filename-versioning, not a runtime knob.
   3. `app/sw.js` — replace the `OFFLINE_URLS` entry with `'/kb-v{N}.json'`.
   4. `app/Dockerfile` — update the `COPY kb-v{N}.json` line.
   5. `app/sw.js` — bump `CACHE_VERSION` (delivers the new shell + artifact to installed users via the network-first SW + `#updateBanner` path, `PWA-DL-001`; `activate()` purges the old cache with the old artifact).
   6. `.pre-commit-config.yaml` — update the excluded filename (`kb-v{N}\.json`) in **both** rewriting-hook excludes (`trailing-whitespace`, `end-of-file-fixer`) so the new artifact stays byte-as-published.
   7. Decide the old `app/kb-v{M}.json`'s fate in the same packet (owner call at bump time — the app references exactly one version, and the old bytes stay reproducible via the domain-kb tag `kb-v{M}`, so retiring it is the natural default; no policy is pre-fixed here).
3. **Promotion.** The no-traffic revision smoke (step 3 of **Promotion + rollback** above) includes the two kb checks — immutable `Cache-Control` and served-sha256 == vendored.

## Local dev

The current PWA is single-file. Two minimal options:

- **Static server.** Serve the `app/` directory with any static file server (e.g. `python -m http.server 8080 --directory app`) and open `http://localhost:8080`.
- **Container parity.** Build and run the production container locally via `docker build -t theygrow-app app && docker run --rm -p 8080:8080 theygrow-app` (build context `app/`). This matches the production nginx config.

### `/api` (FastAPI)

The `/api` service runs as a standalone ASGI app on its own Cloud Run service — **not** behind the PWA's nginx (the same-origin `/api` proxy / origin unification lands in **M5**).

- **Install** (the api-scoped PEP 621 package, with dev extras): `python -m pip install "./api[dev]"`.
- **Run**: `uvicorn theygrow_api.main:app --reload`. No environment is required — the health skeleton constructs no config and opens no connections.
- **Check**: `curl http://localhost:8000/api/health` → `{"status":"ok","service":"theygrow-api"}`.
- **Types / tests**: `mypy api` and `pytest api`.

The config module (`theygrow_api.config.Settings`) requires `DATABASE_URL` (no default) **when constructed**, but no route constructs it yet and it opens no connection; real DB use lands in M3.

### Dev stack (docker-compose — dev only)

A dev-only `docker-compose.yml` (repo root) brings up `/api` alongside a local Postgres 16 + pgvector for parity with the production store. It is **not** a deploy artifact — production uses managed Cloud SQL (ADR-008, see "Live-infra divergence").

- **Up**: `docker compose up --build`. Brings up `db` (`pgvector/pgvector:pg16`, pgvector extension enabled via `scripts/dev/init-pgvector.sql`) and `api` (built from `api/Dockerfile`).
- **Check**: `curl http://localhost:8080/api/health` → `{"status":"ok","service":"theygrow-api"}`.
- The `db` service only enables the pgvector extension; M2-P3 creates **no** episodic schema/tables (those land in M3), and product code opens **no** DB connection — `DATABASE_URL` is bound + validated but never dialed.

## Live-infra divergence

The PWA's live GCP infrastructure was created before the project was renamed to `theygrow-app`, so its identifiers do **not** match the new name. They are operational reality and the deployment continues to target them. The `/api` infrastructure (M2-P3) is greenfield and named in line with `theygrow-app`. All live identifiers — diverging or aligned — are carried here and only here.

- **GCP project id:** `ordinal-avatar-479419-t7` (shared by both services).
- **Region:** `europe-west1` (both services); Artifact Registry host: `europe-west1-docker.pkg.dev`.

**PWA (legacy names — diverge from `theygrow-app`):**

- **Cloud Run service:** `child-tracker-service`.
- **Artifact Registry repository:** `child-tracker-repo`.
- **Image path:** `europe-west1-docker.pkg.dev/ordinal-avatar-479419-t7/child-tracker-repo/web-app`.

**`/api` (greenfield, M2-P3 — aligned with `theygrow-app`):**

- **Cloud Run service:** `theygrow-api`.
- **Artifact Registry repository:** `theygrow-api-repo`.
- **Image path:** `europe-west1-docker.pkg.dev/ordinal-avatar-479419-t7/theygrow-api-repo/api`.

Renaming the **legacy** PWA infra is a **separate owner-approved change**, **out of scope here**. Until that change is approved and executed, the contract files keep guardrails as unnamed file paths (`app/cloudbuild.yaml`, `app/Dockerfile`, `app/nginx.conf`, `app/index.html`, `app/sw.js`, `app/manifest.json`, `app/offline.html`, `app/icons/`, `api/cloudbuild.yaml`, `api/Dockerfile`) and the divergence narrative stays in this RUNBOOK. The contract-integrity gate confines `child-tracker-service` / `child-tracker-repo` / `theygrow-api-repo` to this file.

When the PWA rename does happen, it will land as its own packet with its own decision-log entry; this section is the only doc that needs to be updated in lockstep.
