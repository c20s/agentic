#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: open-pane.sh <repo-root> <run-id>}"
run_id="${2:?usage: open-pane.sh <repo-root> <run-id>}"

if [ -z "${TMUX:-}" ]; then
  echo "error: not inside a tmux session" >&2
  exit 1
fi

if ! command -v nvim > /dev/null 2>&1; then
  echo "error: nvim not found in PATH" >&2
  exit 1
fi

socket="/tmp/claude-copilot-${run_id}.sock"

if [ -e "$socket" ]; then
  echo "error: socket already exists: $socket (pick a different run-id, or clean up a stale session)" >&2
  exit 1
fi

origin_pane="$(tmux display-message -p '#{pane_id}')"

new_pane="$(tmux split-window -h -t "$origin_pane" -c "$repo_root" -P -F '#{pane_id}')"
if [ -z "$new_pane" ]; then
  echo "error: tmux split-window did not return a pane id" >&2
  exit 1
fi

tmux send-keys -t "$new_pane" "nvim --listen $socket $repo_root" Enter

attempts=20
until [ -e "$socket" ] || [ "$attempts" -eq 0 ]; do
  sleep 0.25
  attempts=$((attempts - 1))
done

if [ ! -e "$socket" ]; then
  echo "error: nvim did not create socket $socket in time; pane $new_pane left open for inspection" >&2
  exit 1
fi

content="$(tmux capture-pane -t "$new_pane" -p)"
if echo "$content" | tail -1 | grep -qE '\$\s*$'; then
  echo "error: pane $new_pane looks like a shell prompt, not a running nvim; aborting" >&2
  exit 1
fi

if ! nvim --server "$socket" --remote-expr '1' > /dev/null 2>&1; then
  echo "error: socket $socket exists but is not responding to RPC" >&2
  exit 1
fi

echo "pane_id=$new_pane"
echo "socket=$socket"
