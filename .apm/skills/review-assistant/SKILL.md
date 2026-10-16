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

1. Open the target file in a tmux split to the right of the current pane
   (`tmux split-window -h`, then `send-keys` into it), launching nvim with an
   RPC socket: `nvim --listen /tmp/claude-review-<id>.sock <file>`.
2. Start a background poll loop (~500ms–1s, hash or mtime based) on the file
   and watch it with the `Monitor` tool so Claude wakes on every save.
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

## review-context.json schema

- **Voice/tone rules** — how the reviewer phrases things (terse vs
  explanatory, humble vs blunt, question vs statement).
- **Concern categories & priorities** — what they care about most and what
  they explicitly don't.
- **Concrete example comments** — snippet + comment pairs as few-shot
  examples.
- **Anti-pattern / never-flag list** — things to never comment on.
