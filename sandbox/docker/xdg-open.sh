#!/bin/sh
set -eu

# REVISION: xdg-open-v3-tcp-pty-auth

url="${1:-}"
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ -z "$url" ]; then
  exit 0
fi

session_id="${ORCABOT_SESSION_ID:-}"
pty_id="${ORCABOT_PTY_ID:-}"
mcp_secret="${ORCABOT_MCP_SECRET:-}"
mcp_local_port="${MCP_LOCAL_PORT:-8081}"
controlplane_url="${CONTROLPLANE_URL:-}"
controlplane_token="${INTERNAL_API_TOKEN:-}"
privileged_sock="/run/orcabot/privileged.sock"

echo "orcabot-xdg-open ${ts} invoked_as=$0 url=${url} session_id=${session_id:-missing} pty_id=${pty_id:-missing}" >> /tmp/orcabot-open.log
echo "orcabot-xdg-open ${ts} invoked_as=$0 url=${url} session_id=${session_id:-missing} pty_id=${pty_id:-missing}" 1>&2

if [ -z "$session_id" ]; then
  exit 0
fi

escaped_url=$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')
payload=$(printf '{"url":"%s","pty_id":"%s"}' "$escaped_url" "$pty_id")

# Pool mode: route through the privileged Unix socket, which authenticates via
# SO_PEERCRED — session and pty_id are resolved server-side from the kernel UID.
# Non-pool mode: route through the TCP MCP local server with X-MCP-Secret proof-of-
# possession. The server validates pty_id + X-MCP-Secret so only the PTY that
# created this session can trigger a browser open.
# REVISION: xdg-open-v3-tcp-pty-auth
if [ -S "$privileged_sock" ]; then
  # Pool mode: Unix socket path, session comes from SO_PEERCRED lookup server-side.
  curl -sS -X POST --unix-socket "$privileged_sock" "http://x/browser" \
    -H "Content-Type: application/json" \
    --data "$payload" >/dev/null 2>&1 || true
else
  # Non-pool mode: TCP path with PTY auth. ORCABOT_MCP_SECRET is available in
  # the PTY environment in non-pool mode (withheld only when pool is active).
  curl -sS -X POST "http://127.0.0.1:${mcp_local_port}/sessions/${session_id}/browser/open" \
    -H "Content-Type: application/json" \
    -H "X-MCP-Secret: ${mcp_secret}" \
    --data "$payload" >/dev/null 2>&1 || true
fi

controlplane_status=""
if [ -n "$controlplane_url" ] && [ -n "$controlplane_token" ]; then
  controlplane_payload=$(printf '{"sandbox_session_id":"%s","url":"%s","pty_id":"%s"}' "$session_id" "$escaped_url" "$pty_id")
  controlplane_status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${controlplane_url%/}/internal/browser/open" \
    -H "X-Internal-Token: ${controlplane_token}" \
    -H "Content-Type: application/json" \
    --data "$controlplane_payload" || true)
fi

if [ "${controlplane_status:-}" != "204" ]; then
  printf '\033]9;orcabot-open;%s\033\\' "$url"
fi
