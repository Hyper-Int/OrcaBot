#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONTROLPLANE_PORT=${CONTROLPLANE_PORT:-8787}
D1_SHIM_ADDR=${D1_SHIM_ADDR:-"127.0.0.1:9001"}
D1_SHIM_DEBUG=${D1_SHIM_DEBUG:-""}
FRONTEND_DIR=${FRONTEND_DIR:-"$ROOT_DIR/../frontend"}
FRONTEND_PORT=${FRONTEND_PORT:-8788}
SANDBOX_URL=${SANDBOX_URL:-"http://127.0.0.1:8080"}
SANDBOX_INTERNAL_TOKEN=${SANDBOX_INTERNAL_TOKEN:-"dev-sandbox-token"}
INTERNAL_API_TOKEN=${INTERNAL_API_TOKEN:-"dev-internal-token"}
DEV_AUTH_ENABLED=${DEV_AUTH_ENABLED:-"true"}
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-"http://localhost:$FRONTEND_PORT"}
FRONTEND_URL=${FRONTEND_URL:-"http://localhost:$FRONTEND_PORT"}

cleanup() {
  if [ -n "${WORKERD_PID:-}" ]; then
    kill "$WORKERD_PID" 2>/dev/null || true
  fi
  if [ -n "${D1_PID:-}" ]; then
    kill "$D1_PID" 2>/dev/null || true
  fi
  if [ -n "${FRONTEND_PID:-}" ]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

printf '%s\n' "Building controlplane worker bundle..."
"$ROOT_DIR/workerd/scripts/build-workerd.sh"

printf '%s\n' "Starting D1 shim..."
D1_SHIM_DEBUG="$D1_SHIM_DEBUG" \
D1_SHIM_ADDR="$D1_SHIM_ADDR" "$ROOT_DIR/d1-shim/scripts/run-d1-shim.sh" &
D1_PID=$!

printf '%s\n' "Starting workerd..."
D1_HTTP_URL="http://d1-shim" \
CONTROLPLANE_PORT="$CONTROLPLANE_PORT" \
SANDBOX_URL="$SANDBOX_URL" \
SANDBOX_INTERNAL_TOKEN="$SANDBOX_INTERNAL_TOKEN" \
INTERNAL_API_TOKEN="$INTERNAL_API_TOKEN" \
DEV_AUTH_ENABLED="$DEV_AUTH_ENABLED" \
ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
FRONTEND_URL="$FRONTEND_URL" \
 D1_SHIM_DEBUG="$D1_SHIM_DEBUG" \
  "$ROOT_DIR/workerd/scripts/run-workerd.sh" &
WORKERD_PID=$!

printf '%s\n' "Initializing database..."
for _ in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$CONTROLPLANE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

printf '%s\n' "Starting frontend dev server..."
(
  cd "$FRONTEND_DIR"
  NEXT_PUBLIC_API_URL="http://localhost:$CONTROLPLANE_PORT" \
  NEXT_PUBLIC_SITE_URL="http://localhost:$FRONTEND_PORT" \
  NEXT_PUBLIC_DEV_MODE_ENABLED="true" \
  npx wrangler dev -c wrangler.toml --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

printf '%s\n' "Desktop dev stack running. Frontend + controlplane on localhost."
wait
