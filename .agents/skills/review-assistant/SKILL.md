---
name: review-assistant
description: Builds review-context.json together with the reviewer by watching them review real files live in nvim
---

# Reviewing

The mission is to build and maintain `~/.config/c20s/review-context.json` by
watching the user review real files, replying inline with Claude's own take,
and distilling durable preferences over time. This file is consumed later by
a separate, future skill that performs automatic review — this skill never
reviews solo.

## Flow

1. Open the target file (or folder) in a tmux split to the right of the
   current pane (`tmux split-window -h`, then `send-keys` into it), launching
   nvim with an RPC socket: `nvim --listen /tmp/claude-review-<id>.sock <file>`.
2. Start a background poll loop (~500ms–1s, hash based) and watch it with the
   `Monitor` tool so Claude wakes on every save.
   - **Do not use bash associative arrays (`declare -A`)** — on some systems
     `/bin/bash` is old enough that `declare -A` fails outright, and the loop
     silently never runs (no output, no errors surfaced), which looks like
     "monitoring doesn't work." Use one hash file per watched file instead
     (e.g. under `/tmp/claude-review-hashes/`, keyed by filename or by an
     md5 of the full path).
   - To watch a whole folder instead of a fixed file list, `find <dir> -type
     f -name '*.ts'` inside the loop on every tick rather than hardcoding
     paths — this also picks up files added after the watch started.
   - After seeding the baseline hashes, verify the loop is actually alive
     (e.g. `ps aux | grep <marker>`) rather than assuming the `Monitor` tool
     call succeeding means the script itself is running.
3. On wake: diff against the last-seen content, scan for new marker comments
   — `nit:`, `nitpick:`, `issue:`, `suggestion:` — in whatever comment syntax
   the file uses.
4. For each new marker, append a reply directly below it in the same comment
   syntax (e.g. `> claude: ...` or `// claude: ...`) giving Claude's view:
   agree, disagree, or add nuance.
5. Trigger a buffer reload in the nvim pane so the reply shows up without the
   user touching anything: `nvim --server <socket> --remote-send '<Esc>:checktime<CR>'`.
6. If the exchange reveals a durable preference, update
   `review-context.json` immediately and note that it happened with another
   inline reply line — no separate confirmation step.
7. Repeat until the user ends the session.
8. Applying edits (not just replying) is a distinct, opt-in mode — ask the
   user which they want before doing it:
   - reply-only (default): never touch code, only add `// claude:` lines.
   - apply + reply: make the change at the marker and add a short
     `// claude:` note explaining it.
   - apply only: make the change silently, remove the marker, no commentary.
   - propose first: write the proposed change as a comment, wait for the
     user to save/approve, then apply.
   Editing the watched file to add a reply or apply a fix will itself fire
   the watch loop — after editing, re-sync that file's stored hash to the
   post-edit content (not just rely on the next tick) so the resulting
   notification is recognized as self-caused and skipped, instead of
   re-scanned for markers that were already answered.

## review-context.json schema

- **Voice/tone rules** — how the reviewer phrases things (terse vs
  explanatory, humble vs blunt, question vs statement).
- **Concern categories & priorities** — what they care about most and what
  they explicitly don't.
- **Concrete example comments** — snippet + comment pairs as few-shot
  examples.
- **Anti-pattern / never-flag list** — things to never comment on.
