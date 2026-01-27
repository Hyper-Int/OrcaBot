#!/bin/sh
set -eu

url="${1:-}"
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ -z "$url" ]; then
  exit 0
fi

session_id="${ORCABOT_SESSION_ID:-}"
mcp_local_port="${MCP_LOCAL_PORT:-8081}"
controlplane_url="${CONTROLPLANE_URL:-}"
controlplane_token="${INTERNAL_API_TOKEN:-}"

echo "orcabot-xdg-open ${ts} url=${url} session_id=${session_id:-missing}" >> /tmp/orcabot-open.log
echo "orcabot-xdg-open ${ts} url=${url} session_id=${session_id:-missing}" 1>&2

if [ -z "$session_id" ]; then
  exit 0
fi

escaped_url=$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')
payload=$(printf '{"url":"%s"}' "$escaped_url")
# Use localhost-only MCP server (no auth required)
curl -sS -X POST "http://127.0.0.1:${mcp_local_port}/sessions/${session_id}/browser/open" \
  -H "Content-Type: application/json" \
  --data "$payload" >/dev/null 2>&1 || true

controlplane_status=""
if [ -n "$controlplane_url" ] && [ -n "$controlplane_token" ]; then
  controlplane_payload=$(printf '{"sandbox_session_id":"%s","url":"%s"}' "$session_id" "$escaped_url")
  controlplane_status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${controlplane_url%/}/internal/browser/open" \
    -H "X-Internal-Token: ${controlplane_token}" \
    -H "Content-Type: application/json" \
    --data "$controlplane_payload" || true)
fi

if [ "${controlplane_status:-}" != "204" ]; then
  printf '\033]9;orcabot-open;%s\033\\' "$url"
fi
