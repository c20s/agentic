#!/usr/bin/env bash
# Tail the MCP local-fs server logs, optionally filtered to a single session id.
#
# Usage:
#   ./scripts/tail-session-logs.sh                 # tail summary log, all sessions
#   ./scripts/tail-session-logs.sh <sessionId>      # tail summary log, one session
#   ./scripts/tail-session-logs.sh <sessionId> detail  # tail detail log, one session
#
# The session id is printed by the MCP server at startup, e.g. "[1efcb748]".

set -euo pipefail

SESSION_ID="${1:-}"
LOG_KIND="${2:-summary}"

if [[ "$LOG_KIND" == "detail" ]]; then
  LOG_FILE="$HOME/.claude/mcp-local-fs.log"
else
  LOG_FILE="$HOME/.claude/mcp-local-fs.summary.log"
fi

if [[ -z "$SESSION_ID" ]]; then
  exec tail -f "$LOG_FILE"
else
  # -n +1 includes existing history for that session (not just new lines),
  # and --line-buffered keeps grep streaming live instead of buffering output.
  exec tail -n +1 -f "$LOG_FILE" | grep --line-buffered "$SESSION_ID"
fi
