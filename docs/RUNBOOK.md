# Runbook — theygrow-app

Operational reality of `theygrow-app` today, plus the live-infra divergence note. This file is the single source for live-infra identifiers — the contract files (`AGENTS.md`, `CLAUDE.md`) keep their guardrails as unnamed file paths and link here instead.

## What runs today

The product in production is a **static PWA** served by nginx and deployed on GCP Cloud Run. The served PWA assets now live under `/app` (the M2 monorepo split moved them there from the repository root); `/api` lands later in M2. Build-config (`Dockerfile`, `nginx.conf`, `cloudbuild.yaml`) stays at the repository root.

- Entry point: `app/index.html` (single-file PWA).
- PWA assets: `app/manifest.json`, `app/sw.js`, `app/offline.html`, `app/icons/`.
- Web server: nginx (configured by root `nginx.conf`) inside the container.
- Container: `Dockerfile` (nginx-based).
- CI / CD: GCP Cloud Build, driven by `cloudbuild.yaml`.
- Hosting: GCP Cloud Run.

`/api` does **not** run today. The Python / FastAPI backend lands in M2.

## Build + deploy path

The deploy is fully driven by Cloud Build. See `cloudbuild.yaml` for the canonical build steps; do not duplicate them here.

- `cloudbuild.yaml` builds the container from `Dockerfile`, pushes the image to Artifact Registry, and deploys to Cloud Run.
- Triggered on push to `main` (verify against the Cloud Build trigger configuration).
- No environment-specific staging step exists today.

## Local dev

The current PWA is single-file. Two minimal options:

- **Static server.** Serve the repository root with any static file server (e.g. `python -m http.server 8080`) and open `http://localhost:8080`.
- **Container parity.** Build and run the production container locally via `docker build -t theygrow-app . && docker run --rm -p 8080:8080 theygrow-app`. This matches the production nginx config.

`/api` local dev lands when M2 introduces FastAPI.

## Live-infra divergence

The live GCP infrastructure was created before the project was renamed to `theygrow-app`. The live identifiers do **not** match the new name. They are operational reality and the deployment continues to target them.

- **GCP project id:** `ordinal-avatar-479419-t7`.
- **Cloud Run service:** `child-tracker-service` (region: `europe-west1`).
- **Artifact Registry repository:** `child-tracker-repo` (host: `europe-west1-docker.pkg.dev`).
- **Image path:** `europe-west1-docker.pkg.dev/ordinal-avatar-479419-t7/child-tracker-repo/web-app`.

Renaming live infra is a **separate owner-approved change**, **out of M1 scope**. Until that change is approved and executed, the contract files keep guardrails as unnamed file paths (`cloudbuild.yaml`, `Dockerfile`, `nginx.conf`, `index.html`, `sw.js`, `manifest.json`, `offline.html`, `icons/`) and divergence narrative stays in this RUNBOOK.

When the rename does happen, it will land as its own packet with its own decision-log entry; this section is the only doc that needs to be updated in lockstep.
