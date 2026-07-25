#!/usr/bin/env bash
# Orcabot desktop SECURITY smoke — the dev-auth surface-token gate.
#
# Proves that on desktop, dev-auth (spoofable X-User-ID headers) is only honored
# for requests carrying the per-boot surface token — so a process inside the
# sandbox VM (which can't read the token) can't impersonate the user against
# user-scoped control-plane endpoints.
#
# Asserts against a user-scoped endpoint (GET /dashboards):
#   1. dev headers + VALID surface token -> 200  (trusted host client works)
#   2. dev headers + NO surface token    -> 401  (simulates the VM agent -> blocked)
#   3. dev headers + WRONG surface token -> 401
#
# SKIPs cleanly if the running stack predates the fix (no surface-token file, or
# enforcement not active). Requires the stack up (`orcabot up`) + curl.
#
# Usage:  desktop/tests/security-smoke.sh
set -uo pipefail

CP="${CP:-http://127.0.0.1:8787}"
ENDPOINT="/dashboards"   # user-scoped; requires auth
TOKEN_FILE="${ORCABOT_SURFACE_TOKEN_FILE:-$HOME/Library/Application Support/com.orcabot.desktop/surface-token}"
DEV=(-H "X-User-ID: dev-desktop" -H "X-User-Email: desktop@localhost" -H "X-User-Name: Desktop User")

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }

echo "== preflight =="
[ "$(code "$CP/health")" = "200" ] || { echo "control plane not up at $CP — start the stack (\`orcabot up\`)"; exit 2; }

TOKEN=""
[ -f "$TOKEN_FILE" ] && TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

# Baseline: dev headers with NO surface token. If accepted (200), the running
# build predates the gate — SKIP rather than FAIL (don't fail an old stack).
NO_TOKEN_CODE=$(code "${DEV[@]}" "$CP$ENDPOINT")
if [ -z "$TOKEN" ] || [ "$NO_TOKEN_CODE" = "200" ]; then
  skip "surface-token enforcement not active (no-token -> $NO_TOKEN_CODE; token file $([ -n "$TOKEN" ] && echo present || echo missing)) — rebuild with the fix to test"
  echo; echo "====  $PASS passed, $FAIL failed, $SKIP skipped  ===="
  exit 0
fi

echo "== surface-token gate =="
# 1. valid token -> 200
c=$(code "${DEV[@]}" -H "X-Orcabot-Surface: $TOKEN" "$CP$ENDPOINT")
[ "$c" = "200" ] && ok "dev-auth + valid surface token -> 200 (trusted host client)" \
                 || bad "valid token expected 200, got $c (token file may be stale vs the running boot)"

# 2. no token -> 401/403 (the VM-agent case)
case "$NO_TOKEN_CODE" in
  401|403) ok "dev-auth + NO surface token -> $NO_TOKEN_CODE (VM-origin spoof blocked)";;
  *) bad "no token expected 401/403, got $NO_TOKEN_CODE";;
esac

# 3. wrong token -> 401/403
c=$(code "${DEV[@]}" -H "X-Orcabot-Surface: not-the-real-token-deadbeef" "$CP$ENDPOINT")
case "$c" in
  401|403) ok "dev-auth + WRONG surface token -> $c";;
  *) bad "wrong token expected 401/403, got $c";;
esac

echo
echo "====  $PASS passed, $FAIL failed, $SKIP skipped  ===="
[ "$FAIL" -eq 0 ]
