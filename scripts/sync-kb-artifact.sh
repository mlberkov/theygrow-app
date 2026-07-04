#!/usr/bin/env bash
# VDK-P2 — KB-artifact sync (vendoring mechanism).
#
# Vendors the published domain-kb artifact `compiled/kb-v{N}.json` into
# `app/kb-v{N}.json`, byte-identical. The sync is anchored to the domain-kb
# RELEASE TAG `kb-v{N}` (vault ADR-026 §2 tag-anchor annotation), never floating
# main: `compiled/` holds only the current version (KB-artifact contract §1), so
# the tag is the only reproducible re-sync anchor for a frozen version once
# `compiled/` bumps past it.
#
# Owner-run, RUNBOOK-style — NOT wired into pre-commit/CI by design.
# Toolchain-free: git + coreutils only (no Python — stays outside the Ruff/mypy
# harness). Deeper schema validation stays producer-side (KB-artifact contract);
# this script checks only the two consumer-visible invariants it can check
# byte-level: the file exists in the tag, and `"kb_version"` equals the
# filename N (contract §1).
#
# Idempotent: a re-run overwrites `app/kb-v{N}.json` with identical bytes.
#
# Usage: scripts/sync-kb-artifact.sh <N> [kb-repo-url-or-path]
#   N                     positive-integer artifact version (resolves tag kb-v{N})
#   kb-repo-url-or-path   defaults to git@github.com:mlberkov/theygrow-domain-kb.git
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ ! "${1:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: scripts/sync-kb-artifact.sh <N> [kb-repo-url-or-path]" >&2
  echo "  N must be a positive integer (artifact version, tag kb-v{N})" >&2
  exit 2
fi
N="$1"
KB_REPO="${2:-git@github.com:mlberkov/theygrow-domain-kb.git}"
TAG="kb-v${N}"
ARTIFACT="kb-v${N}.json"

CLONE_DIR="$(mktemp -d)"
trap 'rm -rf "$CLONE_DIR"' EXIT

echo "sync-kb-artifact: resolving tag ${TAG} from ${KB_REPO}"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" \
  "$KB_REPO" "$CLONE_DIR"

SRC="${CLONE_DIR}/compiled/${ARTIFACT}"
if [[ ! -f "$SRC" ]]; then
  echo "FAIL: compiled/${ARTIFACT} not found in tag ${TAG}" >&2
  exit 1
fi

# Contract §1 invariant: kb_version inside the artifact MUST equal filename N.
if ! grep -qE "\"kb_version\": ?${N}([,}[:space:]]|$)" "$SRC"; then
  echo "FAIL: \"kb_version\": ${N} not found in compiled/${ARTIFACT} (contract §1)" >&2
  exit 1
fi

# Byte-identical copy — the vendored file IS the published artifact; never reserialize.
cp "$SRC" "app/${ARTIFACT}"

echo "vendored: app/${ARTIFACT} (byte-identical from tag ${TAG})"
# Record this sha against the domain-kb changelog entry for kb-v{N}.
echo "sha256: $(sha256sum "app/${ARTIFACT}" | cut -d' ' -f1)"
