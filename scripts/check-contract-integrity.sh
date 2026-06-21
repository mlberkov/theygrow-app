#!/usr/bin/env bash
# M1-P3-INV-002 — Contract integrity gate.
#
# Promotes the P1/P2 manual negative-checks (P2 validation checks 4 + 5) into an
# enforced gate. Runs both as a pre-commit hook (repo: local) and in CI (via
# `pre-commit run --all-files` and as a direct step). Must stay GREEN on the
# tracked tree; a non-zero exit means the contract drifted.
#
# Three checks over the contract + spine corpus:
#   1. No superseded stack name reappears as an active target.
#   2. The legacy pre-rename repository directory name does not appear.
#   3. Live-infra names stay confined to docs/RUNBOOK.md (the sole carrier).
#
# Out of scope by design (never scanned):
#   - Live-deploy paths (app/{cloudbuild.yaml,Dockerfile,nginx.conf,index.html,
#     sw.js,manifest.json,offline.html,icons/}, api/{cloudbuild.yaml,Dockerfile})
#     — they legitimately carry the live-infra names as operational reality
#     (docs/RUNBOOK.md "Live-infra divergence"). The build-config relocated into
#     the owning subtrees in M2-P3.
#   - api/pyproject.toml — its PEP 621 distribution name is "theygrow-api"
#     (the same token as the /api Cloud Run service); it is not a contract/spine
#     file, so check 3 never scans it. See the bare-service-name note at check 3.
#   - Historical artifacts (docs/decision-log.md, data/mvp_masterplan.md) — they
#     record the superseded plan verbatim by design (decision M1-DL-001).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0

# Contract + spine files the gate governs.
CONTRACT_FILES=(
  AGENTS.md
  CLAUDE.md
  docs/INVARIANTS.md
  docs/RUNTIME-INVARIANTS.md
  docs/execution-map.md
  docs/RUNBOOK.md
  docs/product/BuildPlan.md
  docs/product/TechSpec.md
  .cursor/rules/masterplan.mdc
)

# --- Check 1: old stack named as an active target ---------------------------
STACK_RE='Neo4j|Next\.js|Tailwind|React Query|Zustand|Alembic|Constitutional|parent graph|Блок [0-8]'
for f in "${CONTRACT_FILES[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE "$STACK_RE" "$f"; then
    echo "  ^ INV-002: superseded stack name used as active target in $f" >&2
    fail=1
  fi
done

# --- Check 2: legacy pre-rename directory name banned from contract + spine --
# Strict bare-ban (P4): the residual sweep removed the last live-spine
# occurrence, so the interim 'theygrow-app' pairing exception is gone. The
# legacy snake-case repo directory name must not appear at all. This script is
# not in CONTRACT_FILES, so the pattern below is never self-scanned.
for f in "${CONTRACT_FILES[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE 'they_grow/' "$f"; then
    echo "  ^ INV-002: legacy pre-rename directory name in $f (banned in contract + spine)" >&2
    fail=1
  fi
done

# --- Check 3: live-infra names confined to docs/RUNBOOK.md -------------------
# Confines the unambiguous live-infra identifiers to RUNBOOK: the legacy PWA
# names (child-tracker-service / -repo) and the /api Artifact Registry repo
# (theygrow-api-repo). The bare /api service name "theygrow-api" is intentionally
# NOT matched — it collides with the PEP 621 distribution name (api/pyproject.toml),
# the FastAPI app title, and the /api/health "service" value, so a bare-name ban
# would false-positive on legitimate, non-infra usage. "theygrow-api-repo" is
# unambiguous (an Artifact Registry repo), so it is the guarded token.
INFRA_RE='child-tracker(-service|-repo)|theygrow-api-repo'
for f in "${CONTRACT_FILES[@]}"; do
  [ -f "$f" ] || continue
  [ "$f" = "docs/RUNBOOK.md" ] && continue
  if grep -nE "$INFRA_RE" "$f"; then
    echo "  ^ INV-002: live-infra name outside docs/RUNBOOK.md in $f" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "contract-integrity: FAIL — contract drift detected (see matches above)." >&2
  exit 1
fi
echo "contract-integrity: OK"
