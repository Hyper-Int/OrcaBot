#!/usr/bin/env bash
# Orcabot desktop regression smoke test.
#
# Drives the LIVE desktop stack (control plane :8787, sandbox :8080) the same way
# the `orcabot` CLI does and asserts that the bugs found in the bug hunt stay fixed.
# These are stateful / cross-component behaviors that the control-plane mock-D1 unit
# harness can't represent faithfully (it ignores UPDATEs and mis-maps session inserts),
# so they're covered here against real processes + real D1.
#
# Coverage:
#   #1 deleting a terminal reaps its PTY (no zombie / no orphan)
#   #2 concurrent session-create for one item -> exactly one session
#   #3 POST item with invalid JSON -> 400 (not 500)
#   #4 attach with unknown provider -> 4xx (not 500)
#   #5 POST item with missing/invalid type -> 400; valid -> 201
#   #6 ghost session: PTY death -> status reconciled to stopped (not stuck 'running')
#   #7 dashboard delete reaps its terminals' PTYs
#   + invariants: file-API path traversal blocked; broker-secret output redaction
#
# Usage:  desktop/tests/regression-smoke.sh
# Requires: the stack running (`orcabot up`), python3, curl. Exits non-zero on any failure.
# NOTE: not part of the fast PR lane (needs the desktop VM). Run locally / nightly.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCABOT="$SCRIPT_DIR/../app/src-tauri/target/release/orcabot"
CP="http://127.0.0.1:8787"
SB="http://127.0.0.1:8080"
U="X-User-ID: dev-desktop"
VZ_LOG="/tmp/vz-console.log"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

jq_py() { python3 -c "$1"; }
code() { curl -s -o /dev/null -w "%{http_code}" -m 10 "$@"; }

TOK="$(grep -a 'debug-exec] auth token:' "$VZ_LOG" 2>/dev/null | tail -1 | sed 's/.*auth token: //' | tr -cd 'a-f0-9')"
# Run a shell command in the sandbox VM, print stdout.
X() {
  local body
  body="$(python3 -c "import json,sys;print(json.dumps({'cmd':sys.argv[1],'timeout_ms':8000}))" "$1")"
  curl -s -m 12 -X POST -H "X-Debug-Exec-Token: $TOK" -H 'Content-Type: application/json' \
    -d "$body" "$SB/debug/exec" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip(),end='')"
}

# ---- preflight ------------------------------------------------------------
if ! curl -s -m 3 "$CP/health" >/dev/null; then
  echo "control plane not reachable on :8787 — run 'orcabot up' first." >&2
  exit 2
fi
if [ -z "$TOK" ]; then
  echo "no /debug/exec token in $VZ_LOG — stack must be launched with VZ_CONSOLE_DIRECT=1 (orcabot up does this)." >&2
  exit 2
fi

# dedicated throwaway dashboard
DID="$(curl -s -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"name":"regression-smoke"}' "$CP/dashboards" \
  | jq_py "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
echo "smoke dashboard: $DID"
new_term() { "$ORCABOT" new terminal shell --dash "$DID" 2>/dev/null | sed 's/created shell terminal //'; }
sess_field() { # $1=itemId $2=field
  curl -s -H "$U" "$CP/dashboards/$DID" | jq_py "import json,sys;d=json.load(sys.stdin);print(next((s.get('$2','') for s in d['sessions'] if s['itemId']=='$1'),'GONE'))"
}

# ---- #1 delete reaps PTY (no zombie) --------------------------------------
echo "[#1] terminal delete reaps the PTY"
b0="$(X 'pgrep -c bash')"; ITEM="$(new_term)"; sleep 3
b1="$(X 'pgrep -c bash')"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$ITEM"; sleep 3
b2="$(X 'pgrep -c bash')"; z="$(X 'ps -eo stat | grep -c Z')"
{ [ "$b1" -gt "$b0" ] && [ "$b2" -le "$b0" ] && [ "$z" -eq 0 ]; } \
  && ok "PTY reaped (bash $b0->$b1->$b2, zombies=$z)" \
  || bad "PTY leaked/zombied (bash $b0->$b1->$b2, zombies=$z)"

# ---- #2 concurrent session-create -> one session --------------------------
echo "[#2] concurrent session-create coalesces to one"
IT="$(curl -s -X POST -H "$U" -H 'Content-Type: application/json' \
  --data-raw '{"type":"terminal","content":"{\"name\":\"race\",\"bootCommand\":\"\"}"}' "$CP/dashboards/$DID/items" \
  | jq_py "import json,sys;print(json.load(sys.stdin)['item']['id'])")"
for i in 1 2 3; do curl -s -o /dev/null -X POST -H "$U" -H 'Content-Type: application/json' -d '{}' "$CP/dashboards/$DID/items/$IT/session" & done; wait
sleep 3
n="$(curl -s -H "$U" "$CP/dashboards/$DID" | jq_py "import json,sys;print(sum(1 for s in json.load(sys.stdin)['sessions'] if s['itemId']=='$IT'))")"
[ "$n" = "1" ] && ok "exactly one session ($n)" || bad "duplicate sessions ($n)"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$IT"

# ---- #3/#5 item input validation ------------------------------------------
echo "[#3/#5] item input validation"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw 'not-json{' "$CP/dashboards/$DID/items")"
[ "$c" = "400" ] && ok "invalid JSON -> 400" || bad "invalid JSON -> $c (want 400)"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"content":"x"}' "$CP/dashboards/$DID/items")"
[ "$c" = "400" ] && ok "missing type -> 400" || bad "missing type -> $c (want 400)"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"type":"bogus"}' "$CP/dashboards/$DID/items")"
[ "$c" = "400" ] && ok "invalid type -> 400" || bad "invalid type -> $c (want 400)"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"type":"note","content":"ok"}' "$CP/dashboards/$DID/items")"
[ "$c" = "201" ] && ok "valid note -> 201" || bad "valid note -> $c (want 201)"

# ---- #4 attach validation (no 500) ----------------------------------------
echo "[#4] attach input validation (never 500)"
ITEM4="$(new_term)"; sleep 3
PTY4="$(sess_field "$ITEM4" ptyId)"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw 'not-json{' "$CP/dashboards/$DID/terminals/$PTY4/integrations")"
{ [ "$c" -ge 400 ] && [ "$c" -lt 500 ]; } && ok "malformed body -> $c (4xx)" || bad "malformed body -> $c (want 4xx)"
c="$(code -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"provider":"bogus","userIntegrationId":"fake"}' "$CP/dashboards/$DID/terminals/$PTY4/integrations")"
{ [ "$c" -ge 400 ] && [ "$c" -lt 500 ]; } && ok "unknown provider -> $c (4xx)" || bad "unknown provider -> $c (want 4xx)"

# ---- #6 ghost session reconcile -------------------------------------------
echo "[#6] PTY death reconciles session to stopped"
before="$(X 'pgrep bash | sort | tr "\n" ","')"
ITEM6="$(new_term)"; sleep 3
after="$(X 'pgrep bash | sort | tr "\n" ","')"
PID6="$(python3 -c "b=set('$before'.split(','))-{''};a=set('$after'.split(','))-{''};print(next(iter(a-b),''))")"
X "kill -9 $PID6 2>/dev/null; echo ." >/dev/null; sleep 1
st_before="$(sess_field "$ITEM6" status)"
timeout 8 "$ORCABOT" tail "$ITEM6" --dash "$DID" --secs 2 >/dev/null 2>&1   # 404 -> reconcile
sleep 2
st_after="$(sess_field "$ITEM6" status)"
{ [ "$st_before" = "active" ] && { [ "$st_after" = "stopped" ] || [ "$st_after" = "GONE" ]; }; } \
  && ok "reconciled ($st_before -> $st_after)" \
  || bad "not reconciled ($st_before -> $st_after; want active -> stopped/GONE)"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$ITEM6"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$ITEM4"

# ---- #7 dashboard delete reaps PTYs ---------------------------------------
echo "[#7] dashboard delete reaps its PTYs"
ND="$(curl -s -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"name":"regression-smoke-del"}' "$CP/dashboards" \
  | jq_py "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
d0="$(X 'pgrep -c bash')"; "$ORCABOT" new terminal shell --dash "$ND" >/dev/null 2>&1; sleep 3
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$ND"; sleep 3
d2="$(X 'pgrep -c bash')"; z="$(X 'ps -eo stat | grep -c Z')"
{ [ "$d2" -le "$d0" ] && [ "$z" -eq 0 ]; } && ok "PTY reaped on dashboard delete (bash $d0->$d2, zombies=$z)" \
  || bad "PTY leaked on dashboard delete (bash $d0->$d2, zombies=$z)"

# ---- invariants: path traversal + output redaction ------------------------
echo "[inv] file-API path traversal blocked"
ITEM8="$(new_term)"; sleep 3
SSID="$(curl -s -H "$U" "$CP/dashboards/$DID" | jq_py "import json,sys;d=json.load(sys.stdin);print(next(s['sandboxSessionId'] for s in d['sessions'] if s['itemId']=='$ITEM8'))")"
out="$(curl -s -m6 -H 'X-Internal-Token: dev-sandbox-token' "$SB/sessions/$SSID/file?path=../../../../etc/passwd")"
echo "$out" | grep -q "root:" && bad "path traversal LEAKED /etc/passwd" || ok "traversal blocked"

echo "[inv] broker-secret output redaction"
SEC="REDACTME_smoke_55512345"
curl -s -o /dev/null -X POST -H "$U" -H 'Content-Type: application/json' \
  --data-raw "{\"name\":\"SMOKE_SECRET\",\"value\":\"$SEC\",\"type\":\"secret\",\"brokerProtected\":true,\"dashboardId\":\"$DID\"}" "$CP/secrets"
ITEM9="$(new_term)"; sleep 3
red="$(timeout 12 "$ORCABOT" tail "$ITEM9" --dash "$DID" --secs 5 --send "echo MK:${SEC}:MK" 2>/dev/null)"
echo "$red" | grep -q "$SEC" && bad "secret LEAKED in output" || ok "secret redacted"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$ITEM8"
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID/items/$ITEM9"

# ---- teardown -------------------------------------------------------------
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID"
echo
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" -eq 0 ]
