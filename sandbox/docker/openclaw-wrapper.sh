#!/bin/bash
# REVISION: openclaw-gateway-v1-auto-start
# OpenClaw wrapper: ensures the gateway daemon runs in Docker (no systemd).
#
# The orcabot sandbox is a Docker container without systemd/launchd, so
# OpenClaw's built-in daemon installation silently fails. This wrapper
# detects when the gateway is needed and starts it in the background.
#
# Flow:
#   1. Pre-execution: start gateway if config already exists (for 'tui')
#   2. For 'onboard': background watcher polls for config creation and
#      starts gateway mid-onboarding (before the browser-open call)
#   3. exec the real binary (critical for signal propagation)

# Find the real binary (Dockerfile renames original to openclaw.real)
OPENCLAW_REAL=""
for p in /usr/local/bin/openclaw.real /usr/bin/openclaw.real; do
    if [ -x "$p" ]; then OPENCLAW_REAL="$p"; break; fi
done
if [ -z "$OPENCLAW_REAL" ]; then
    echo "[openclaw-wrapper] Error: cannot find openclaw.real" >&2
    exit 1
fi
OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"
GATEWAY_PORT=18789
GATEWAY_PIDFILE="/tmp/openclaw-gateway.pid"
LOGFILE="/tmp/openclaw-gateway.log"

# Start gateway if config exists and gateway isn't already running.
# Returns 0 if gateway is running (or was started), 1 if no config yet.
start_gateway_if_needed() {
    # Fast path: check PID file
    if [ -f "$GATEWAY_PIDFILE" ]; then
        EXISTING_PID=$(cat "$GATEWAY_PIDFILE" 2>/dev/null)
        if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
            return 0
        fi
        rm -f "$GATEWAY_PIDFILE"
    fi

    # Check if port is already in use (gateway started externally)
    if curl -sf --max-time 1 "http://127.0.0.1:${GATEWAY_PORT}/" >/dev/null 2>&1; then
        return 0
    fi

    # Config must exist before we can start the gateway
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        return 1
    fi

    # Start gateway in background, detached from this PTY
    nohup "$OPENCLAW_REAL" gateway --port "$GATEWAY_PORT" \
        >> "$LOGFILE" 2>&1 &
    GATEWAY_PID=$!
    echo "$GATEWAY_PID" > "$GATEWAY_PIDFILE"

    # Wait for readiness (up to 5 seconds)
    for _ in $(seq 1 10); do
        if curl -sf --max-time 1 "http://127.0.0.1:${GATEWAY_PORT}/" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
    done

    # Gateway started but may not be ready yet — not fatal
    return 0
}

# Pre-execution: start gateway if config already exists (handles 'tui' case)
start_gateway_if_needed

# For 'onboard': start a background watcher that polls for config creation
# and starts the gateway before onboarding tries to open the browser URL.
case "$*" in
    *onboard*)
        (
            for _ in $(seq 1 300); do
                if [ -f "$OPENCLAW_CONFIG" ]; then
                    start_gateway_if_needed
                    exit 0
                fi
                sleep 2
            done
        ) &
        ;;
esac

# Replace this process with the real openclaw binary.
# exec is critical: the sandbox sends SIGSTOP/SIGCONT/SIGINT to the PTY
# process for agent pause/resume/stop — these must reach openclaw directly.
exec "$OPENCLAW_REAL" "$@"
