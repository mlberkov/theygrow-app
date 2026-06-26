# Runbook — theygrow-app

Operational reality of `theygrow-app` today, plus the live-infra divergence note. This file is the single source for live-infra identifiers — the contract files (`AGENTS.md`, `CLAUDE.md`) keep their guardrails as unnamed file paths and link here instead.

## What runs today

The product in production is a **static PWA** served by nginx and deployed on GCP Cloud Run. The served PWA assets live under `/app` (the M2-P1 monorepo split moved them there from the repository root); in M2-P3 the build-config relocated from the repository root into the owning subtrees — PWA build-config under `/app`, API build-config under `/api`. The `/api` backend now deploys as **its own Cloud Run service** on its own URL (see below).

- Entry point: `app/index.html` (single-file PWA).
- PWA assets: `app/manifest.json`, `app/sw.js`, `app/offline.html`, `app/icons/`.
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
- No environment-specific staging step exists today.

> **Build-config relocation (M2-P3) — trigger continuity.** The build-config moved out of the repository root into `/app` + `/api`. The pre-existing PWA trigger had `filename = cloudbuild.yaml` (repo root); it MUST be repointed to `filename = app/cloudbuild.yaml` (and gain `includedFiles = app/**`) **before or atomically with** the merge that removes the root `cloudbuild.yaml`. The live Cloud Run revision keeps serving throughout — a transitional failed build does not take the site down (worst case is a build re-run after the trigger is fixed). See the M2-P3 owner checklist / `M2-DL-002`.

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
