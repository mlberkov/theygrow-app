#!/bin/sh
# PWA container entrypoint (A3-P1, vault ADR-038 / ADR-007).
#
# Renders app/nginx.conf from its committed template, mints the ID token the
# same-origin /api proxy authenticates with, keeps that token fresh, and hands off
# to nginx. It deliberately REPLACES the base image's own /docker-entrypoint.sh
# rather than dropping a script into /docker-entrypoint.d/: that machinery's
# ordering and its sourced-vs-executed semantics are undocumented base-image
# internals, and nothing it does applies to a config that hardcodes `listen 8080`
# and uses no `resolver`.
#
# Fail-closed by design. If the upstream is configured but no token can be minted,
# this script exits non-zero and the container never starts. That is safe because
# app/cloudbuild.yaml deploys with --no-traffic --tag: a broken revision takes zero
# users and surfaces as a red Cloud Build, which is strictly better than starting
# and serving a silent 503 all the way to promotion.
#
# Nothing here is validatable off Cloud Run — the metadata server does not exist
# locally. See docs/RUNBOOK.md "Same-origin /api proxy" for the owner-run smoke
# that is the only real proof this works.
set -eu

# --- Proxy knobs (container layer) ------------------------------------------
# changed_in: A3-DL-001. These live here rather than in api/theygrow_api/parameters.py
# because their consumer is this /bin/sh loop, in the PWA image — a DIFFERENT container
# with no Python runtime and no import path to that module; routing them through the
# typed surface would mean inventing a cross-container config channel this packet does
# not need. Same reasoning, same shape, as CACHE_VERSION in app/sw.js (PWA-DL-001).
#
# API_TOKEN_POLL_SECONDS: how often to re-ask the metadata server. Chosen against Cloud
# Run CPU throttling, which is the real hazard for any background timer: metadata identity
# tokens live ~1h, an idle instance is reaped after ~15min, so serving an expired token
# would need an instance to survive ~55min without a single CPU slice while still alive —
# which requires traffic, which grants CPU. The metadata server returns its cached token
# until near expiry, so polling is nearly free and an actual rotation lands roughly hourly.
API_TOKEN_POLL_SECONDS="${API_TOKEN_POLL_SECONDS:-300}"
# API_TOKEN_FETCH_MAX_ATTEMPTS / _BACKOFF: startup retry budget before failing closed.
# Covers a cold instance racing the metadata endpoint, not a misconfiguration.
API_TOKEN_FETCH_MAX_ATTEMPTS="${API_TOKEN_FETCH_MAX_ATTEMPTS:-5}"
API_TOKEN_FETCH_BACKOFF_SECONDS="${API_TOKEN_FETCH_BACKOFF_SECONDS:-2}"

METADATA_IDENTITY_URL='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
TEMPLATE='/etc/nginx/nginx.conf.template'
RENDERED='/etc/nginx/nginx.conf'
TOKEN_CONF='/etc/nginx/conf.d/api-id-token.conf'

# Diagnostics only. §4-safe by construction: attempt counts and HTTP-ish outcomes,
# never a token, never a request path, never a body.
log() { echo "[entrypoint] $*" >&2; }

# --- Upstream resolution ------------------------------------------------------
API_UPSTREAM_URL="${API_UPSTREAM_URL:-}"
# Trailing slashes matter: `proxy_pass http://h/` REPLACES the matched /api/ prefix,
# `proxy_pass http://h` preserves the full URI. The /api prefix is baked into the
# FastAPI router (api/theygrow_api/main.py), so the full URI is what must arrive.
API_UPSTREAM_URL="$(printf '%s' "$API_UPSTREAM_URL" | sed -e 's|/*$||')"

if [ -n "$API_UPSTREAM_URL" ]; then
    API_UPSTREAM_CONFIGURED=1
else
    # Local/dev only. app/cloudbuild.yaml Step 0 fails the build when the substitution
    # is empty, so this branch is unreachable in Cloud Build. The placeholder exists
    # solely so the rendered config still PARSES; the `return 503` written into
    # $TOKEN_CONF below fires first and proxy_pass is never reached.
    API_UPSTREAM_CONFIGURED=0
    API_UPSTREAM_URL='http://127.0.0.1:8080'
    log "WARNING: API_UPSTREAM_URL is unset — /api will answer 503. Local/dev only."
fi

API_UPSTREAM_HOST="$(printf '%s' "$API_UPSTREAM_URL" \
    | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||')"
export API_UPSTREAM_URL API_UPSTREAM_HOST

# --- Token acquisition --------------------------------------------------------
# Audience MUST be the upstream service URL exactly: Cloud Run validates the token's
# aud against the service it is invoked on, and rejects anything else.
fetch_id_token() {
    # `tr -d` is defensive, not cosmetic: any stray newline would land inside the
    # quoted `set` directive and travel into the Authorization header value.
    wget -q -O - --header 'Metadata-Flavor: Google' \
        "${METADATA_IDENTITY_URL}?audience=${API_UPSTREAM_URL}" 2>/dev/null | tr -d '\r\n'
}

write_token_conf() {
    # $1 = token. Written whole then moved, so nginx can never `include` a half-written
    # file during a reload.
    printf 'set $api_id_token "%s";\n' "$1" > "${TOKEN_CONF}.new"
    mv "${TOKEN_CONF}.new" "$TOKEN_CONF"
}

CURRENT_TOKEN=''
if [ "$API_UPSTREAM_CONFIGURED" -eq 1 ]; then
    attempt=1
    while [ "$attempt" -le "$API_TOKEN_FETCH_MAX_ATTEMPTS" ]; do
        if CURRENT_TOKEN="$(fetch_id_token)" && [ -n "$CURRENT_TOKEN" ]; then
            break
        fi
        CURRENT_TOKEN=''
        log "id-token fetch failed (attempt ${attempt}/${API_TOKEN_FETCH_MAX_ATTEMPTS})"
        attempt=$((attempt + 1))
        if [ "$attempt" -le "$API_TOKEN_FETCH_MAX_ATTEMPTS" ]; then
            sleep "$API_TOKEN_FETCH_BACKOFF_SECONDS"
        fi
    done

    if [ -z "$CURRENT_TOKEN" ]; then
        log "FATAL: could not mint an ID token for the /api upstream after ${API_TOKEN_FETCH_MAX_ATTEMPTS} attempts."
        log "FATAL: refusing to start — see docs/RUNBOOK.md 'Same-origin /api proxy'."
        exit 1
    fi
    write_token_conf "$CURRENT_TOKEN"
    log "id-token minted; /api proxy is configured"
else
    # No token, and a hard 503 ahead of proxy_pass. $api_id_token is still declared
    # because the proxy_set_header referencing it is parsed regardless of reachability,
    # and nginx refuses to load a config with an unknown variable.
    {
        printf 'set $api_id_token "";\n'
        printf 'return 503 "api proxy not configured";\n'
    } > "$TOKEN_CONF"
fi

# --- Render the config --------------------------------------------------------
# Explicit two-name allowlist: without it envsubst would consider every defined env
# var, and nginx's own $uri / $proxy_add_x_forwarded_for are the kind of thing that
# must never become a substitution candidate.
envsubst '${API_UPSTREAM_URL} ${API_UPSTREAM_HOST}' < "$TEMPLATE" > "$RENDERED"

# --- Background refresh -------------------------------------------------------
# Rewrites the include and reloads nginx ONLY when the token actually changed, so a
# reload is a roughly-hourly event rather than one per poll. A failed poll keeps the
# previous token rather than blanking it: a stale token still works until it expires,
# an empty one fails every request immediately.
if [ "$API_UPSTREAM_CONFIGURED" -eq 1 ]; then
    (
        while :; do
            sleep "$API_TOKEN_POLL_SECONDS"
            if fresh="$(fetch_id_token)" && [ -n "$fresh" ]; then
                if [ "$fresh" != "$CURRENT_TOKEN" ]; then
                    CURRENT_TOKEN="$fresh"
                    write_token_conf "$CURRENT_TOKEN"
                    if nginx -s reload 2>/dev/null; then
                        log "id-token rotated; nginx reloaded"
                    else
                        log "WARNING: id-token rotated but nginx reload failed"
                    fi
                fi
            else
                log "WARNING: id-token refresh failed; keeping the previous token"
            fi
        done
    ) &
fi

exec "$@"
