---
name: copilot
description: Applies the user's comments and naive implementations as real code edits live in nvim
---

# Copilot

## Flow

1. Open the repo root in a new tmux split, launching nvim with an RPC
   socket, by running `scripts/open-pane.sh <repo-root> <run-id>` from
   Claude's own pane (the script reads `$TMUX`, so it must run in the pane
   Claude is actually attached to, not a pane reached by guessing an id).
   The script does the full sequence deterministically — captures the
   calling pane, splits it (`-P -F '#{pane_id}'` so the new pane's id comes
   from tmux itself, never inferred from a `list-panes` scan), launches
   nvim with `--listen <socket>`, polls for the socket to appear, confirms
   the pane isn't still sitting at a shell prompt, and pings the socket
   with `nvim --remote-expr '1'` to confirm RPC actually answers — and
   refuses to run if a socket for that `<run-id>` already exists, so a
   stale session is never silently reused.
   - On success it prints exactly two lines to stdout:
     `pane_id=<id>` and `socket=<path>`. Parse these — this is the
     reference Claude uses for every later `nvim --server` call and for
     targeting the pane. Treat a non-zero exit (error on stderr) as a hard
     stop: re-diagnose, don't fall back to guessing a pane or socket path.
   - Never `send-keys` or `nvim --server` at a pane/socket this script
     didn't just hand back. A pane found via `list-panes`/pattern matching
     without going through this script may already be mid-edit on an
     unrelated buffer (e.g. in visual mode) — blind keystrokes there edit
     or scroll someone else's work instead of starting the watch session.
2. `git diff HEAD` needs a HEAD. If `git rev-parse HEAD` fails (brand-new
   repo, zero commits), ask the user before doing anything about it — e.g.
   create an empty initial commit so HEAD exists — rather than silently
   committing or falling back to a different diff mechanism. Don't start
   the loop until there is a HEAD to diff against.
3. Run `scripts/watch.sh <repo-root> <run-id>` in the background (pick
   `<run-id>` as a short unique token, e.g. the tmux socket id) and watch
   it with the `Monitor` tool. The script owns the whole loop: it blocks on
   `fswatch` for a filesystem event (no fixed poll interval), then on each
   event runs `git add -N --all`, `git diff HEAD`, diffs that against the
   previous tick, and writes the result — so Claude never re-runs those
   commands by hand and never busy-waits. It emits one changed-file path
   per line to stdout whenever the diff actually changed (a save that
   doesn't change tracked content produces an fswatch event but no
   output), and writes the full unified diff for that tick to
   `/tmp/claude-copilot-lastdiff-<run-id>`.
   - no per-file hashes, no shadow-copy directory — `git diff HEAD` against
     the last commit is already the "shadow copy."
   - `.git/` itself is excluded from the watch so Claude's own commits or
     index updates don't self-trigger a tick.
4. A zero exit from the background launch means the loop is running —
   don't also shell out to `ps`/`grep` to double-check. If `Monitor` later
   reports the task exited, diagnose from its output then, not before.
5. On wake, read `/tmp/claude-copilot-lastdiff-<run-id>` (the unified diff
   for this tick), not the full file, and scan only the added (`+`) lines.
6. If you find a `todo` comment or a naive/stubbed implementation in the
   same diff hunk, or a markdown roadmap checkbox with `- [!]` in it, make
   the change directly — no proposal round-trip, no narration of the plan.
7. After every file you change, stop and make a commit for that file with
   a conventional commit message, including a body with lines max 80
   chars long.
8. Never push anything.
9. Trigger a buffer reload in the nvim pane so the change shows up without
   the user touching anything:
   `nvim --server <socket> --remote-send '<Esc>:checktime<CR>'`.
10. Repeat until the user ends the session.

## Output discipline

Stay silent between ticks. Don't narrate setup steps, Monitor re-arms, or
"nothing to do this tick" — the loop runs unattended. The only user-visible
output per tick is: the file(s) changed, the edit made, and the commit. If
a tick's diff has no marker/todo/stub in it, make no commit and say
nothing.

## Scope

This skill never reviews solo and never pushes — it only edits the working
tree, and commits what it changes, in response to explicit inline markers
(or obvious todos/naive code it finds alongside them) while the user is
watching.
