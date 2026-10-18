#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: watch.sh <repo-root> <run-id>}"
run_id="${2:?usage: watch.sh <repo-root> <run-id>}"

state_dir="/tmp/claude-copilot-${run_id}"
mkdir -p "$state_dir"
previous="$state_dir/previous"
lastdiff="/tmp/claude-copilot-lastdiff-${run_id}"

: > "$previous"

cd "$repo_root"

emit_if_changed() {
  git add -N --all
  if ! git diff HEAD > "$state_dir/current" 2>/dev/null; then
    return
  fi
  if diff -q "$previous" "$state_dir/current" > /dev/null 2>&1; then
    return
  fi
  cp "$state_dir/current" "$previous"
  cp "$state_dir/current" "$lastdiff"
  git diff --name-only HEAD
}

fswatch -0 --event Updated --event Created --event Renamed \
  --latency 0.4 \
  -e "$(git rev-parse --git-dir)" --exclude "\\.git/" \
  --exclude "~$" --exclude "\\.sw[a-z]$" --exclude "\\.swp$" \
  --exclude "4913$" --exclude "/node_modules/" \
  -r "$repo_root" |
while IFS= read -r -d '' _; do
  emit_if_changed
done
