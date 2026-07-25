#!/usr/bin/env bash
# Light smoke test for the benchmark *viewer pattern* (branch 2) on the desktop VM.
#
# Validates the SECURE viewer mechanism: a read-only Orcabot terminal watches a
# run by tailing its per-run logfile (`tail -F`), NOT by attaching a shared tmux
# control socket.
#
# Why not a shared tmux socket: a world-accessible tmux control socket would let
# any in-VM process attach = read every pane AND inject commands into other
# sessions, bypassing output redaction (CLAUDE.md:96) and the "two terminals
# cannot see each other" / "no cross-session access" isolation invariants
# (CLAUDE.md:94, sandbox/CLAUDE.md:248), via a local channel the egress proxy
# never sees. A logfile tail has no inject capability and no reach into other
# runs — it stays within the already-shared /workspace trust boundary.
#
# This mirrors the real host-tmux executor: it tees each run's output to a
# per-run logfile (its tmux window stays PRIVATE to the executor's own uid).
# A cross-PTY viewer tails that same logfile.
#
# Flow:
#   1. (in VM, via /debug/exec) a "run" writes a marker + heartbeats to a logfile.
#   2. create an Orcabot terminal whose bootCommand is `tail -F <logfile>`.
#   3. `orcabot tail` the viewer -> assert it shows the marker (watching works).
#   4. send keystrokes to the viewer -> assert they do NOT reach the run's
#      logfile (read-only holds; tail cannot write back to the run).
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

# Per-boot surface token: the control plane only trusts dev-auth when the
# X-Orcabot-Surface header matches (devAuthSurfaceTrusted). Read it from the same
# file the desktop app / CLI use so these host-side curls authenticate like the CLI.
# Empty on pre-enforcement stacks (harmless — dev-auth trusted headerless there).
SURFACE_TOKEN_FILE="${ORCABOT_SURFACE_TOKEN_FILE:-$HOME/Library/Application Support/com.orcabot.desktop/surface-token}"
ST="$(cat "$SURFACE_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
AUTH=(-H "$U" -H "X-Orcabot-Surface: $ST")  # dev-auth headers for every control-plane call
RUNDIR="/workspace/.scb-smoke"
LOG="$RUNDIR/run1.log"
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

echo "[1] start a 'run' that tees output to a per-run logfile"
X "rm -rf $RUNDIR; mkdir -p $RUNDIR" >/dev/null
# marker now; then a detached heartbeat writer so tail -F has something live.
X "echo $MARKER > $LOG; nohup sh -c 'for i in \$(seq 1 120); do echo hb_\$i >> $LOG; sleep 1; done' >/dev/null 2>&1 &" >/dev/null
sleep 1
HAVE="$(X "grep -c $MARKER $LOG 2>/dev/null")"
[ "$HAVE" = "1" ] && ok "run logfile created with marker" || bad "logfile/marker not present (got '$HAVE')"

echo "[2] spawn a read-only viewer terminal (tail -F the logfile)"
DID="$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' --data-raw '{"name":"viewer-smoke"}' "$CP/dashboards" | jq_py "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
CONTENT="{\"name\":\"viewer\",\"bootCommand\":\"tail -n +1 -F $LOG\"}"
# Build the request body with single-quoted python reading $CONTENT from the env,
# so bash never brace-expands the JSON dict.
BODY="$(CONTENT="$CONTENT" python3 -c 'import json,os;print(json.dumps({"type":"terminal","content":os.environ["CONTENT"]}))')"
IT="$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' --data-raw "$BODY" \
  "$CP/dashboards/$DID/items" | jq_py "import json,sys;print(json.load(sys.stdin)['item']['id'])")"
curl -s -o /dev/null -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' "$CP/dashboards/$DID/items/$IT/session"; sleep 3
echo "  dashboard=$DID item=$IT"

echo "[3] viewer shows the run (watching works)"
OUT="$(timeout 12 "$ORCABOT" tail "$IT" --dash "$DID" --secs 6 2>/dev/null)"
echo "$OUT" | grep -q "$MARKER" && ok "viewer shows marker (tailing the run logfile)" || bad "viewer did not show marker"

echo "[4] viewer is read-only (input cannot reach the run)"
timeout 12 "$ORCABOT" tail "$IT" --dash "$DID" --secs 5 --send "$INJECT" >/dev/null 2>&1; sleep 1
LOGTXT="$(X "cat $LOG")"
echo "$LOGTXT" | grep -q "$INJECT" && bad "INPUT LEAKED into run logfile (not read-only!)" || ok "read-only holds (injected text absent from run logfile)"

# ---- teardown ----
X "pkill -f 'seq 1 120' 2>/dev/null; rm -rf $RUNDIR" >/dev/null
curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$CP/dashboards/$DID"
echo
echo "================  $PASS passed, $FAIL failed  ================"
[ "$FAIL" -eq 0 ]
