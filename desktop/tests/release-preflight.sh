#!/usr/bin/env bash
# Orcabot desktop RELEASE PREFLIGHT.
#
# Boots the freshly-built stack headlessly (`orcabot up`) and asserts the core
# user path works END TO END before we ship — catching the "dashboards won't
# load" class of bugs (a missing runtime key, broken dev-auth / surface-token,
# or a CORS preflight gap) that a source-level drift check cannot see.
#
# Checks:
#   1. control plane comes up (/health 200)
#   2. per-boot surface token is generated
#   3. GET /dashboards with dev-auth + surface token -> 200  (dashboards LOAD)
#   4. gate holds: dev-auth WITHOUT the token -> 401/403
#   5. CORS preflight for /dashboards allows X-Orcabot-Surface (else the browser
#      blocks every authed call and "dashboards won't load" in the real UI)
#   6. the frontend worker is serving on :8788
#
# If the stack is already up (e.g. the app is running) it tests that and leaves
# it alone; otherwise it boots the stack and tears down what it started.
#
# Usage:   desktop/tests/release-preflight.sh
# Exit:    0 = all passed, 1 = a check failed, 2 = could not run (no binary/boot)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCABOT="${ORCABOT_BIN:-$SCRIPT_DIR/../app/src-tauri/target/release/orcabot}"
CP="http://127.0.0.1:8787"
FRONTEND="http://127.0.0.1:8788"
TOKEN_FILE="${ORCABOT_SURFACE_TOKEN_FILE:-$HOME/Library/Application Support/com.orcabot.desktop/surface-token}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}"
DEV=(-H "X-User-ID: dev-desktop" -H "X-User-Email: desktop@localhost" -H "X-User-Name: Desktop User")

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$@"; }

STARTED_STACK=0
cleanup() {
  if [ "$STARTED_STACK" = "1" ]; then
    echo "== tearing down (preflight started the stack) =="
    "$ORCABOT" down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== release preflight =="

# Boot the stack unless it's already up.
if [ "$(code "$CP/health")" != "200" ]; then
  [ -x "$ORCABOT" ] || { echo "orcabot binary not found at $ORCABOT (build first: cargo build --release)"; exit 2; }
  echo "== booting stack (orcabot up) — waiting up to ${BOOT_TIMEOUT}s for the control plane =="
  "$ORCABOT" up >/tmp/orcabot-preflight-up.log 2>&1 &
  STARTED_STACK=1
  i=0
  while [ "$i" -lt "$BOOT_TIMEOUT" ]; do
    [ "$(code "$CP/health")" = "200" ] && break
    sleep 2; i=$((i + 2))
  done
fi

if [ "$(code "$CP/health")" != "200" ]; then
  echo "control plane never became healthy (see /tmp/orcabot-preflight-up.log)"
  exit 1
fi
ok "control plane healthy (/health 200)"

# 2. Surface token present (the per-boot dev-auth gate credential)
TOKEN=""
[ -f "$TOKEN_FILE" ] && TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
[ -n "$TOKEN" ] && ok "surface token generated" || bad "surface token missing ($TOKEN_FILE)"

# 3. Dashboards LOAD: dev-auth + surface token -> 200
c=$(code "${DEV[@]}" -H "X-Orcabot-Surface: $TOKEN" "$CP/dashboards")
[ "$c" = "200" ] \
  && ok "GET /dashboards (dev-auth + token) -> 200 — dashboards load" \
  || bad "GET /dashboards (dev-auth + token) -> $c — dashboards would NOT load"

# 4. Gate holds: no token -> 401/403
c=$(code "${DEV[@]}" "$CP/dashboards")
case "$c" in
  401|403) ok "gate: dev-auth without surface token -> $c" ;;
  *)       bad "gate: no token expected 401/403, got $c (VM-origin spoof not blocked)" ;;
esac

# 5. CORS preflight allows the surface header (browser blocks authed calls otherwise)
acah=$(curl -s -D - -o /dev/null -m 15 -X OPTIONS \
  -H "Origin: $FRONTEND" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-orcabot-surface,x-user-id" \
  "$CP/dashboards" | tr -d '\r' | tr 'A-Z' 'a-z' | grep '^access-control-allow-headers:' || true)
if printf '%s' "$acah" | grep -q 'x-orcabot-surface'; then
  ok "CORS preflight allows X-Orcabot-Surface"
else
  bad "CORS preflight missing X-Orcabot-Surface — browser would block authed calls [${acah:-no ACAH header}]"
fi

# 6. Frontend worker serving
c=$(code "$FRONTEND/")
[ "$c" != "000" ] && ok "frontend worker responding on :8788 ($c)" || bad "frontend worker not responding on :8788"

echo
echo "==== $PASS passed, $FAIL failed ===="
[ "$FAIL" -eq 0 ]
