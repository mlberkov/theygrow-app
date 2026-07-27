#!/usr/bin/env bash
# A1-P1 — parity suite runner.
#
# The acceptance gate for every A1 spa-split packet. CI calls THIS script rather
# than re-implementing the steps in YAML, so the gate cannot drift into a local
# shadow of itself: what runs on a laptop and what runs in CI are the same
# command in the same pinned container.
#
# WHY A CONTAINER. app/index.html sizes its skill column from measured text
# (setFixedSkillColumnWidth), so screenshots are font-metric dependent. Pinning
# the Playwright image pins Chromium AND the font set, which is what makes
# visual baselines reproducible; a bare GitHub runner image drifts underneath
# them without notice.
#
# The image tag and the @playwright/test version in app/package.json must match
# exactly — Playwright refuses to run on a mismatch, which is the guard we want.
#
# Usage:
#   scripts/parity-suite.sh                      # full suite
#   scripts/parity-suite.sh --update-snapshots   # rewrite baselines (explicit only)
#   scripts/parity-suite.sh --project=behavior   # any playwright flag passes through
#   PARITY_NO_DOCKER=1 scripts/parity-suite.sh --project=dom-desktop
#                                                # host run; visual baselines will
#                                                # NOT match unless the host is the
#                                                # pinned image
set -euo pipefail

PLAYWRIGHT_VERSION="1.61.1"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Translate our one explicit flag into Playwright's. Baselines are never written
# implicitly: app/playwright.config.js sets updateSnapshots: 'none', so a missing
# or changed baseline FAILS unless this flag is passed.
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --update-snapshots) ARGS+=("--update-snapshots=changed") ;;
    *) ARGS+=("$arg") ;;
  esac
done

# Verify the pin is internally consistent before doing any work.
DECLARED="$(sed -n 's/.*"@playwright\/test": "\([^"]*\)".*/\1/p' "${REPO_ROOT}/app/package.json")"
if [ "${DECLARED}" != "${PLAYWRIGHT_VERSION}" ]; then
  echo "parity-suite: version pin mismatch — app/package.json says '${DECLARED}', this script says '${PLAYWRIGHT_VERSION}'." >&2
  echo "parity-suite: update both together; the container tag and the npm package must match exactly." >&2
  exit 1
fi

if [ "${PARITY_NO_DOCKER:-0}" = "1" ]; then
  echo "parity-suite: running on the host (PARITY_NO_DOCKER=1) — visual baselines are container-only." >&2
  cd "${REPO_ROOT}/app"
  npm ci --ignore-scripts
  exec npx playwright test "${ARGS[@]}"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "parity-suite: docker not found. Install it, or run a non-visual subset with:" >&2
  echo "  PARITY_NO_DOCKER=1 scripts/parity-suite.sh --project=dom-desktop --project=behavior" >&2
  exit 1
fi

echo "parity-suite: image ${PLAYWRIGHT_IMAGE}"

# --ipc=host: Chromium crashes on the default 64 MB /dev/shm.
# --user: keep files written into the repo owned by the caller, not root.
# HOME/npm cache land in /tmp because the mapped user has no home in the image.
exec docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}:/work" \
  -w /work/app \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/.npm \
  -e CI="${CI:-}" \
  "${PLAYWRIGHT_IMAGE}" \
  bash -lc 'npm ci --ignore-scripts && npx playwright test "$@"' _ "${ARGS[@]}"
