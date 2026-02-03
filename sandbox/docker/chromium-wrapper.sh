#!/bin/sh
# Smart chromium wrapper: intercepts "open URL" calls (from CLIs like Gemini)
# and routes them through xdg-open, while passing normal browser launches
# (with flags like --no-sandbox) to the real chromium binary.

# If no arguments, just start chromium normally
if [ $# -eq 0 ]; then
  exec /usr/bin/chromium.real "$@"
fi

# Check if this looks like a "just open this URL" invocation:
# - Exactly one argument
# - Starts with http:// or https://
# In that case, route through our xdg-open wrapper for proper handling
if [ $# -eq 1 ]; then
  case "$1" in
    http://*|https://*)
      exec /usr/local/bin/xdg-open "$1"
      ;;
  esac
fi

# For anything else (browser block's --no-sandbox --remote-debugging-port etc.),
# pass through to the real chromium binary
exec /usr/bin/chromium.real "$@"
