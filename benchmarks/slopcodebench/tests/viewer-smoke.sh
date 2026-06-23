#!/usr/bin/env bash
# Light smoke test for the benchmark *viewer pattern* (branch 2) on the desktop VM.
#
# Validates the core claim of benchmarks/slopcodebench without installing
# slop-code: a read-only Orcabot terminal can WATCH a tmux-mirrored run, and
# cannot inject input into it.
#
# Flow:
#   1. (in VM, via /debug/exec) create a tmux session on a SHARED socket in
#      /workspace that emits a marker — stands in for a host-tmux run.
#   2. create an Orcabot terminal whose bootCommand attaches read-only
#      (`tmux attach -r`) to that session.
#   3. `orcabot tail` the viewer -> assert it shows the marker (it's watching).
#   4. send keystrokes to the viewer -> assert they do NOT reach the session
#      pane (read-only holds).
#
# A shared socket (`tmux -S /workspace/.scb-smoke/tmux.sock`) is used on purpose:
# Orcabot PTYs may run under different uids (egress UID pool), and per-uid default
# tmux sockets aren't cross-visible. A world-accessible shared socket in the
# shared workspace is the uid-agnostic pattern the real host-tmux executor should
# also adopt for cross-PTY viewing.
#
# Usage:  benchmarks/slopcodebench/tests/viewer-smoke.sh
# Requires: stack running (`orcabot up`), python3, curl. Exits non-zero on failure.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ORCABOT="${ORCABOT_BIN:-$ROOT/desktop/app/src-tauri/target/release/orcabot}"
CP="http://127.0.0.1:8787"
SB="http://127.0.0.1:8080"
U="X-User-ID: dev-desktop"
VZ_LOG="/tmp/vz-console.log"
SOCK="/workspace/.scb-smoke/tmux.sock"
MARKER="SMOKE_VIEWER_MARKER_OK"
INJECT="INJECT_RO_SHOULD_NOT_APPEAR"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
jq_py(){ python3 -c "$1"; }

TOK="$(grep -a 'debug-exec] auth token:' "$VZ_LOG" 2>/dev/null | tail -1 | sed 's/.*auth token: //' | tr -cd 'a-f0-9')"
# run a shell command in the VM as root, print stdout
X(){ local b; b="$(python3 -c "import json,sys;print(json.dumps({'cmd':sys.argv[1],'timeout_ms':10000}))" "$1")"
  curl -s -m 14 -X POST -H "X-Debug-Exec-Token: $TOK" -H 'Content-Type: application/json' \
    -d "$b" "$SB/debug/exec" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())"; }

# ---- preflight ----
[ -x "$ORCABOT" ] || { echo "orcabot binary not found at $ORCABOT" >&2; exit 2; }
curl -s -m3 "$CP/health" >/dev/null || { echo "control plane down on :8787 — run 'orcabot up'." >&2; exit 2; }
[ -n "$TOK" ] || { echo "no /debug/exec token in $VZ_LOG (need VZ_CONSOLE_DIRECT=1 / 'orcabot up')." >&2; exit 2; }

echo "[0] tmux present in VM"
TV="$(X 'tmux -V')"; case "$TV" in tmux*) ok "tmux: $TV";; *) bad "tmux missing in VM (got '$TV')"; echo "==== $PASS passed, $FAIL failed ===="; exit 1;; esac

echo "[1] create shared-socket tmux session (stand-in for a host-tmux run)"
X "rm -rf /workspace/.scb-smoke; mkdir -p /workspace/.scb-smoke" >/dev/null
X "tmux -S $SOCK new-session -d -s scb -n run1 \"sh -c 'echo $MARKER; sleep 600'\"; chmod -R 777 /workspace/.scb-smoke" >/dev/null
WINS="$(X "tmux -S $SOCK list-windows -t scb -F '#{window_name}'")"
case "$WINS" in *run1*) ok "session up (windows: $WINS)";; *) bad "session not created (got '$WINS')";; esac

echo "[2] spawn a read-only viewer terminal"
DID="$(curl -s -X POST -H "$U" -H 'Content-Type: application/json' --data-raw '{"name":"viewer-smoke"}' "$CP/dashboards" | jq_py "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
CONTENT="{\"name\":\"viewer\",\"bootCommand\":\"tmux -S $SOCK attach -r -t scb:run1\"}"
# Build the request body with single-quoted python reading $CONTENT from the env,
# so bash never brace-expands the JSON dict.
BODY="$(CONTENT="$CONTENT" python3 -c 'import json,os;print(json.dumps({"type":"terminal","content":os.environ["CONTENT"]}))')"
IT="$(curl -s -X POST -H "$U" -H 'Content-Type: application/json' --data-raw "$BODY" \
  "$CP/dashboards/$DID/items" | jq_py "import json,sys;print(json.load(sys.stdin)['item']['id'])")"
curl -s -o /dev/null -X POST -H "$U" -H 'Content-Type: application/json' -d '{}' "$CP/dashboards/$DID/items/$IT/session"; sleep 3
echo "  dashboard=$DID item=$IT"

echo "[3] viewer shows the run (watching works)"
OUT="$(timeout 12 "$ORCABOT" tail "$IT" --dash "$DID" --secs 6 2>/dev/null)"
echo "$OUT" | grep -q "$MARKER" && ok "viewer shows marker (attached + rendering)" || bad "viewer did not show marker"

echo "[4] viewer is read-only (input cannot reach the run)"
timeout 12 "$ORCABOT" tail "$IT" --dash "$DID" --secs 5 --send "$INJECT" >/dev/null 2>&1; sleep 1
PANE="$(X "tmux -S $SOCK capture-pane -p -t scb:run1")"
echo "$PANE" | grep -q "$INJECT" && bad "INPUT LEAKED into run pane (not read-only!)" || ok "read-only holds (injected text absent from run pane)"

# ---- teardown ----
X "tmux -S $SOCK kill-server 2>/dev/null; rm -rf /workspace/.scb-smoke" >/dev/null
curl -s -o /dev/null -X DELETE -H "$U" "$CP/dashboards/$DID"
echo
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" -eq 0 ]
