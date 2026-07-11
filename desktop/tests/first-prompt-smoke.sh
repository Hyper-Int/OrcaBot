#!/usr/bin/env bash
# Orcabot desktop FIRST-PROMPT smoke — the "connected but blank" first-PTY race.
#
# Reproduces the SANDBOX side of the flaky first terminal (frontend recipe 09
# covers the full-stack UI side). A client that attaches to a freshly-created PTY
# must see the shell prompt WITHOUT sending any input: it arrives either via the
# live broadcast (if the client registers before the shell emits its prompt) or
# via the hub's scrollback replay on attach (sandbox/internal/pty/hub.go:787,
# `if raw := h.ScrollbackRaw(0); len(raw) > 0`). If the prompt was emitted after
# the session was created but before this client registered AND wasn't yet in the
# 64KB ring buffer, the client sees a blank terminal until it presses a key.
#
# This loops many fresh terminals, attaches to each immediately with NO input
# (`orcabot tail`, no --send), and reports how often the prompt shows up
# input-free. On the local desktop VM the race window is tiny, so this normally
# passes — its job is to guard the replay path against regressions (e.g. someone
# removing the replay, or breaking the ring buffer) and to be pointable at a
# laggier stack. The statistical repro of the ~30% flake lives in e2e recipe 09.
#
# Usage:  desktop/tests/first-prompt-smoke.sh [iterations]
# Requires: stack running (`orcabot up`), python3, curl. Exits non-zero if the
# input-free prompt rate is below FIRST_PROMPT_THRESHOLD (default 100%).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCABOT="${ORCABOT_BIN:-$SCRIPT_DIR/../app/src-tauri/target/release/orcabot}"
CP="http://127.0.0.1:8787"
U="X-User-ID: dev-desktop"
ITER="${1:-15}"
TAIL_SECS="${FIRST_PROMPT_TAIL_SECS:-3}"
THRESHOLD="${FIRST_PROMPT_THRESHOLD:-100}"   # percent input-free prompts required

# Per-boot surface token (dev-auth gate), read like the CLI/app do. Empty is
# harmless on stacks that predate surface enforcement.
SURFACE_TOKEN_FILE="${ORCABOT_SURFACE_TOKEN_FILE:-$HOME/Library/Application Support/com.orcabot.desktop/surface-token}"
ST="$(cat "$SURFACE_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
AUTH=(-H "$U" -H "X-Orcabot-Surface: $ST")

curl -s -m3 "$CP/health" >/dev/null \
  || { echo "control plane not reachable on :8787 — run 'orcabot up' first." >&2; exit 2; }

DID="$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  --data-raw '{"name":"first-prompt-smoke"}' "$CP/dashboards" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['dashboard']['id'])")"
echo "smoke dashboard: $DID  (iterations=$ITER, tail=${TAIL_SECS}s, threshold=${THRESHOLD}%)"

# Does captured PTY output contain a real shell prompt (user@host:...#/$)?
# ANSI/OSC escapes are stripped first so styling can't hide the prompt text.
has_prompt() {
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1]
s = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', s)   # OSC (e.g. title sets)
s = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', s)           # CSI / SGR colour codes
sys.exit(0 if re.search(r'[\w.-]+@[\w.-]+:[^\n]*[#$]', s) else 1)
PY
}

ok=0; bad=0
for i in $(seq 1 "$ITER"); do
  ITEM="$("$ORCABOT" new terminal shell --dash "$DID" 2>/dev/null | sed 's/created shell terminal //')"
  if [ -z "$ITEM" ]; then echo "  [$i] FAIL: could not create terminal"; bad=$((bad + 1)); continue; fi
  # Attach IMMEDIATELY and read WITHOUT sending any input.
  out="$(timeout $((TAIL_SECS + 6)) "$ORCABOT" tail "$ITEM" --dash "$DID" --secs "$TAIL_SECS" 2>/dev/null)"
  if has_prompt "$out"; then
    ok=$((ok + 1)); echo "  [$i] ok"
  else
    bad=$((bad + 1)); echo "  [$i] BLANK — no input-free prompt"
  fi
  curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$CP/dashboards/$DID/items/$ITEM"
done

curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$CP/dashboards/$DID"
total=$((ok + bad))
rate="$(python3 -c "print(round(100*$ok/max($total,1)))")"
echo
echo "================  input-free prompt: $ok/$total  (${rate}%)  ================"
[ "$rate" -ge "$THRESHOLD" ]
