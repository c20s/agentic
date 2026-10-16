---
name: copilot
description: Applies the user's inline nit/issue/suggestion comments as real code edits live in nvim, instead of only replying
---

# Copilot

Same watch loop as `review-assistant`, but instead of only replying inline,
Claude makes the requested code change directly, live, while the user
watches. No `review-context.json` bookkeeping here — this skill is about
doing, not profiling the reviewer.

Watching uses shadow copies + `diff -u` (step 3) so Claude only has to read
the changed lines, not the whole file, on every save.

## Flow

1. Open the target file or folder in a tmux split to the right of the
   current pane (`tmux split-window -h`, then `send-keys`), launching nvim
   with an RPC socket: `nvim --listen /tmp/claude-copilot-<id>.sock <file>`.
2. Before watching, seed a shadow copy of each target file under
   `/tmp/claude-copilot-shadow/<md5-of-full-path>` (plain `cp`). This is the
   "last-known-good" snapshot the diff step compares against.
3. Start a background poll loop (~500ms–1s, hash based) and watch it with
   the `Monitor` tool so Claude wakes on every save.
   - Do not use bash associative arrays (`declare -A`) — on some systems
     `/bin/bash` is old enough that this fails outright and the loop
     silently never runs. Use one hash file per watched file instead
     (e.g. under `/tmp/claude-copilot-hashes/`, keyed by an md5 of the
     full path).
   - To watch a whole folder, `find <dir> -type f -name '*.ts'` inside the
     loop on every tick instead of hardcoding paths, so new files are
     picked up too.
   - After seeding the baseline hashes, verify the loop is actually alive
     (e.g. `ps aux | grep <marker>`) rather than trusting that the
     `Monitor` tool call succeeding means the script itself is running.
   - On each detected change, have the loop itself compute
     `diff -u "$SHADOW/$key" "$f" > /tmp/claude-copilot-lastdiff/$key` and
     emit the changed file path in the event line — this is what makes the
     diff-based approach pay off: the diff is produced by the shell loop,
     not by Claude re-reading the file.
4. On wake, read `/tmp/claude-copilot-lastdiff/$key` (the unified diff),
   not the full file, and scan only the added (`+`) lines for new marker
   comments — `nit:`, `nitpick:`, `issue:`, `suggestion:` — in whatever
   comment syntax the file uses. Fall back to a full Read only if the diff
   looks ambiguous (e.g. heavily reformatted, or a rename).
5. Before the first edit of a session, confirm the apply mode with the user
   (ask once, reuse for the rest of the session):
   - **apply only** (default here): make the change at the marker, remove
     the marker, no commentary.
   - **apply + reply**: make the change and add a short `// claude:` note
     explaining what changed.
   - **propose first**: write the proposed change as a comment, wait for
     the user to save/approve it, then apply.
6. Apply the edit with the project's normal edit tool (not a shell
   command), then immediately re-sync that file's stored hash *and* shadow
   copy to the post-edit content before triggering the reload — otherwise
   the edit re-fires the watch loop and gets re-scanned (or re-diffed) as
   if it were a new, unanswered marker.
7. Trigger a buffer reload in the nvim pane so the change shows up without
   the user touching anything:
   `nvim --server <socket> --remote-send '<Esc>:checktime<CR>'`.
8. Repeat until the user ends the session.

## Scope

This skill never reviews solo and never pushes/commits — it only edits the
working tree in response to explicit inline markers the user wrote
themselves, while they're watching.
