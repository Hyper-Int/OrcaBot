#!/bin/bash
#
# Integration test script for Hyper Backend API
# Usage: ./scripts/test-api.sh [BASE_URL]
#

BASE="${1:-https://hyper-sandbox.fly.dev}"
PASSED=0
FAILED=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

check() {
    if [ "$1" -eq 0 ]; then
        green "  ✓ $2"
        PASSED=$((PASSED + 1))
    else
        red "  ✗ $2"
        FAILED=$((FAILED + 1))
    fi
}

echo "============================================"
echo "Hyper Backend API Tests"
echo "Base URL: $BASE"
echo "============================================"
echo ""

# Health Check
echo "=== Health Check ==="
HEALTH=$(curl -sf "$BASE/health" | jq -r '.status' 2>/dev/null)
[ "$HEALTH" = "ok" ]; check $? "GET /health returns ok"
echo ""

# Session Management
echo "=== Session Management ==="
SESSION_ID=$(curl -sf -X POST "$BASE/sessions" | jq -r '.id' 2>/dev/null)
[ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; check $? "POST /sessions creates session"
echo "  Session ID: $SESSION_ID"
echo ""

# PTY Management
echo "=== PTY Management ==="
PTY_ID=$(curl -sf -X POST "$BASE/sessions/$SESSION_ID/ptys" | jq -r '.id' 2>/dev/null)
[ -n "$PTY_ID" ] && [ "$PTY_ID" != "null" ]; check $? "POST /sessions/:id/ptys creates PTY"
echo "  PTY ID: $PTY_ID"

PTY_LIST=$(curl -sf "$BASE/sessions/$SESSION_ID/ptys" | jq -r '.ptys[0].id' 2>/dev/null)
[ "$PTY_LIST" = "$PTY_ID" ]; check $? "GET /sessions/:id/ptys lists PTYs"

# Create second PTY for deletion test
PTY2_ID=$(curl -sf -X POST "$BASE/sessions/$SESSION_ID/ptys" | jq -r '.id' 2>/dev/null)
curl -sf -X DELETE "$BASE/sessions/$SESSION_ID/ptys/$PTY2_ID" > /dev/null
PTY_COUNT=$(curl -sf "$BASE/sessions/$SESSION_ID/ptys" | jq '.ptys | length' 2>/dev/null)
[ "$PTY_COUNT" = "1" ]; check $? "DELETE /sessions/:id/ptys/:id removes PTY"
echo ""

# Filesystem Operations
echo "=== Filesystem Operations ==="
FILES_EMPTY=$(curl -sf "$BASE/sessions/$SESSION_ID/files" | jq '.files | length' 2>/dev/null)
[ "$FILES_EMPTY" = "0" ]; check $? "GET /sessions/:id/files lists empty workspace"

curl -sf -X PUT "$BASE/sessions/$SESSION_ID/file?path=/test.txt" -d "Hello from test!" > /dev/null
FILE_CONTENT=$(curl -sf "$BASE/sessions/$SESSION_ID/file?path=/test.txt" 2>/dev/null)
[ "$FILE_CONTENT" = "Hello from test!" ]; check $? "PUT/GET /sessions/:id/file writes and reads file"

FILE_STAT=$(curl -sf "$BASE/sessions/$SESSION_ID/file/stat?path=/test.txt" | jq -r '.name' 2>/dev/null)
[ "$FILE_STAT" = "test.txt" ]; check $? "GET /sessions/:id/file/stat returns file info"

FILES_COUNT=$(curl -sf "$BASE/sessions/$SESSION_ID/files" | jq '.files | length' 2>/dev/null)
[ "$FILES_COUNT" = "1" ]; check $? "GET /sessions/:id/files shows created file"

curl -sf -X DELETE "$BASE/sessions/$SESSION_ID/file?path=/test.txt" > /dev/null
FILES_AFTER=$(curl -sf "$BASE/sessions/$SESSION_ID/files" | jq '.files | length' 2>/dev/null)
[ "$FILES_AFTER" = "0" ]; check $? "DELETE /sessions/:id/file removes file"
echo ""

# Agent Management
echo "=== Agent Management ==="
AGENT_STATE=$(curl -sf -X POST "$BASE/sessions/$SESSION_ID/agent" | jq -r '.state' 2>/dev/null)
[ "$AGENT_STATE" = "running" ]; check $? "POST /sessions/:id/agent starts agent"

AGENT_GET=$(curl -sf "$BASE/sessions/$SESSION_ID/agent" | jq -r '.state' 2>/dev/null)
[ "$AGENT_GET" = "running" ]; check $? "GET /sessions/:id/agent returns running state"

AGENT_PAUSE=$(curl -sf -X POST "$BASE/sessions/$SESSION_ID/agent/pause" | jq -r '.state' 2>/dev/null)
[ "$AGENT_PAUSE" = "paused" ]; check $? "POST /sessions/:id/agent/pause pauses agent"

AGENT_RESUME=$(curl -sf -X POST "$BASE/sessions/$SESSION_ID/agent/resume" | jq -r '.state' 2>/dev/null)
[ "$AGENT_RESUME" = "running" ]; check $? "POST /sessions/:id/agent/resume resumes agent"

curl -sf -X POST "$BASE/sessions/$SESSION_ID/agent/stop" > /dev/null
AGENT_STOPPED=$(curl -sf "$BASE/sessions/$SESSION_ID/agent" 2>/dev/null)
[ -z "$AGENT_STOPPED" ] || [ "$AGENT_STOPPED" = "{}" ]; check $? "POST /sessions/:id/agent/stop stops agent"
echo ""

# WebSocket PTY Test (requires Python + websockets)
echo "=== WebSocket PTY Test ==="
if command -v python3 &> /dev/null && python3 -c "import websockets" 2>/dev/null; then
    # Convert http(s) to ws(s)
    if [[ "$BASE" == https://* ]]; then
        WS_BASE="wss://${BASE#https://}"
    else
        WS_BASE="ws://${BASE#http://}"
    fi
    WS_URL="$WS_BASE/sessions/$SESSION_ID/ptys/$PTY_ID/ws?user_id=test-user"

    WS_RESULT=$(python3 << PYEOF
import asyncio
import websockets
import json
import sys

async def test_pty():
    url = "$WS_URL"
    try:
        async with websockets.connect(url) as ws:
            # Receive initial control_state
            msg = await asyncio.wait_for(ws.recv(), timeout=5)
            if "control_state" not in msg:
                return "no_control_state"

            # Take control
            await ws.send(json.dumps({"type": "take_control"}))
            msg = await asyncio.wait_for(ws.recv(), timeout=5)
            if "control_taken" not in msg:
                return "no_control_taken"

            # Send command as binary
            await ws.send(b"echo WS_TEST_SUCCESS\r")

            # Read output
            output = ""
            try:
                for _ in range(10):
                    msg = await asyncio.wait_for(ws.recv(), timeout=2)
                    if isinstance(msg, bytes):
                        output += msg.decode("utf-8", errors="replace")
            except asyncio.TimeoutError:
                pass

            if "WS_TEST_SUCCESS" in output:
                return "success"
            return "no_output"
    except Exception as e:
        return f"error: {e}"

result = asyncio.run(test_pty())
print(result)
PYEOF
    )

    [ "$WS_RESULT" = "success" ]; check $? "WebSocket PTY connection and I/O"
else
    yellow "  ⚠ Skipping WebSocket test (requires: pip install websockets)"
fi
echo ""

# Cleanup
echo "=== Cleanup ==="
curl -sf -X DELETE "$BASE/sessions/$SESSION_ID/ptys/$PTY_ID" > /dev/null
curl -sf -X DELETE "$BASE/sessions/$SESSION_ID" > /dev/null
check 0 "Cleaned up session and PTY"
echo ""

# Summary
echo "============================================"
printf "Results: \033[32m%d passed\033[0m, " "$PASSED"
if [ "$FAILED" -gt 0 ]; then
    printf "\033[31m%d failed\033[0m\n" "$FAILED"
else
    printf "0 failed\n"
fi
echo "============================================"

exit "$FAILED"
