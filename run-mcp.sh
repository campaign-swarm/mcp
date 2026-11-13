#!/usr/bin/env bash
# Start the MCP server detached (stateless streamable HTTP on :3101).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${MCP_PORT:-3101}"
LOG="${MCP_LOG:-/tmp/campaignswarm-mcp.log}"
PIDFILE="/tmp/campaignswarm-mcp.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: $(cat "$PIDFILE")"
  exit 0
fi

export MCP_PORT="$PORT"
export INTERNAL_API_URL="${INTERNAL_API_URL:-http://localhost:8000}"
# The cell API and control plane can differ in a shared local stack. Branding
# reads the control plane when this is set; tool calls still use INTERNAL_API_URL.
export BRANDING_API_URL="${BRANDING_API_URL:-$INTERNAL_API_URL}"
# Prefer the repo-local binary — the global pnpm shim is not always available.
TSX_BIN="node_modules/.bin/tsx"
[ -x "$TSX_BIN" ] || TSX_BIN="pnpm exec tsx"
setsid nohup $TSX_BIN src/index.ts >"$LOG" 2>&1 </dev/null &
echo $! > "$PIDFILE"
echo "started mcp pid $(cat "$PIDFILE") on :$PORT (log: $LOG)"
