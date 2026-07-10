#!/usr/bin/env bash
# Orcabot desktop BROWSER smoke — the browser block actually starts and paints.
#
# Why this exists: the browser block (chromium in the VM, streamed over VNC) had NO
# test coverage, and a broken chromium build shipped in the VM image
# (150.0.7871.46 IMMEDIATE_CRASHed on launch), so the block silently showed
# "Browser failed to start" — start() succeeded, but chromium died and status.ready
# never flipped true. This asserts the whole path: start -> chromium up ->
# status.ready=true within a bounded time.
#
# Flow:
#   1. throwaway dashboard + one terminal (an active session pins the VM).
#   2. POST /dashboards/:id/browser/start.
#   3. poll GET /dashboards/:id/browser/status until running && ready (fail on timeout).
#   4. sanity: the in-VM chromium is not the known-broken build.
#
# Usage:  desktop/tests/browser-smoke.sh
# Requires: stack running (`orcabot up`), python3, curl. Exits non-zero on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCABOT="${ORCABOT_BIN:-$SCRIPT_DIR/../app/src-tauri/target/release/orcabot}"
CP="http://127.0.0.1:8787"
SB="http://127.0.0.1:8080"
U="X-User-ID: dev-desktop"
VZ_LOG="/tmp/vz-console.log"
READY_TIMEOUT="${READY_TIMEOUT:-45}"   # chromium cold boot can be slow

# Per-boot surface token (dev-auth gate) — read like the CLI/app do.
SURFACE_TOKEN_FILE="${ORCABOT_SURFACE_TOKEN_FILE:-$HOME/Library/Application Support/com.orcabot.desktop/surface-token}"
ST="$(cat "$SURFACE_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
AUTH=(-H "$U" -H "X-Orcabot-Surface: $ST")

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
jq_py(){ python3 -c "$1"; }

# Run a shell command in the VM as root (debug-exec), print stdout.
TOK="$(grep -a 'debug-exec] auth token:' "$VZ_LOG" 2>/dev/null | tail -1 | sed 's/.*auth token: //' | tr -cd 'a-f0-9')"
X(){ local b; b="$(python3 -c "import json,sys;print(json.dumps({'cmd':sys.argv[1],'timeout_ms':10000}))" "$1")"
  curl -s -m 14 -X POST -H "X-Debug-Exec-Token: $TOK" -H 'Content-Type: application/json' \
    -d "$b" "$SB/debug/exec" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())"; }

# ---- preflight ----
[ -x "$ORCABOT" ] || { echo "orcabot binary not found at $ORCABOT" >&2; exit 2; }
curl -s -m3 "$CP/health" >/dev/null || { echo "control plane down on :8787 — run 'orcabot up'." >&2; exit 2; }

# dedicated throwaway dashboard + an active session (browser needs a VM to attach to)
DID="$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' --data-raw '{"name":"browser-smoke"}' "$CP/dashboards" | jq_py "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
echo "smoke dashboard: $DID"
"$ORCABOT" new terminal shell --dash "$DID" >/dev/null 2>&1; sleep 3

echo "[1] browser starts and reaches ready"
curl -s -o /dev/null -m 30 "${AUTH[@]}" -X POST "$CP/dashboards/$DID/browser/start"
ready=0
for _ in $(seq 1 "$READY_TIMEOUT"); do
  s="$(curl -s -m6 "${AUTH[@]}" "$CP/dashboards/$DID/browser/status")"
  r="$(echo "$s" | jq_py "import json,sys
try:
  d=json.load(sys.stdin); print('1' if d.get('running') and d.get('ready') else '0')
except Exception: print('0')")"
  if [ "$r" = "1" ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] \
  && ok "browser reached running+ready" \
  || bad "browser never became ready within ${READY_TIMEOUT}s (chromium likely crashed on launch)"

echo "[2] chromium is not the known-broken build"
# 150.0.7871.46 SIGTRAPs on launch. Any other build (esp. .100+) is fine. Only assert
# when we can read the version (debug-exec available); otherwise skip, don't fail.
if [ -n "$TOK" ]; then
  ver="$(X 'chromium.real --version 2>/dev/null || chromium --version 2>/dev/null')"
  case "$ver" in
    *150.0.7871.46*) bad "chromium is the broken build: $ver" ;;
    *Chromium*)      ok "chromium build OK: $ver" ;;
    *)               echo "  SKIP: could not read chromium version" ;;
  esac
else
  echo "  SKIP: no debug-exec token (VZ_CONSOLE_DIRECT=1 not set) — version check skipped"
fi

# ---- teardown ----
curl -s -o /dev/null "${AUTH[@]}" -X POST "$CP/dashboards/$DID/browser/stop" 2>/dev/null
curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$CP/dashboards/$DID"
echo
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" -eq 0 ]
