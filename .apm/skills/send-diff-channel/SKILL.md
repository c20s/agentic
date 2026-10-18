---
name: send-diff-channel
description: Starts a per-project Claude Code channel that an external tool (e.g. an nvim plugin) can POST a git diff into, waking up this session with it. Use when the user wants to start listening for diffs sent from their editor, or asks to wire up nvim to send changes to this session.
---

# Send diff channel

Starts a named channel server for the current project so an outside process can push a `git diff` into this Claude Code session. The channel is registered in `~/.config/c20s/channels.json` under the project's name (its git repo basename), so an editor plugin can look up which port belongs to which project.

This is built on Claude Code's Channels feature (research preview): https://code.claude.com/docs/en/channels.md

## Steps to start listening

1. Check `bun --version` is available. If missing, stop and tell the user to install Bun.
2. Run `bun scripts/start-channel.ts` from this skill's directory, with cwd set to the project the user wants to listen in. This re-launches `claude` in the current project with the channel wired up via `--dangerously-load-development-channels`.
3. Tell the user the project name being registered (printed on start) — that's the name their nvim plugin needs to target.

Note: `start-channel.ts` re-execs `claude`, replacing the running session. Only run this when the user explicitly asks to turn on diff-listening for this session — it is not something to do proactively.

## How a diff arrives

When a POST lands on the project's channel port, it shows up in the conversation as:

```
<channel source="<project-name>" project="<project-name>">
<diff content>
</channel>
```

It queues and is processed on the next turn — it does not interrupt a turn in progress.

## Sending a diff manually (for testing)

```
bun scripts/send-diff.ts <file-path> [--project <name>]
```

It matches `<file-path>` against every registered channel's project root. One match sends immediately. Several matches print `{"needsSelection": true, "candidates": [...]}` to stdout instead of sending — call it again with `--project <name>` to disambiguate. It then runs `git diff -- <file-path>` in that project's cwd and POSTs the result to the channel's HTTP listener.

## Listing active channels

```
bun scripts/list-channels.ts
```

Prints the registry (`~/.config/c20s/channels.json`), pruning entries whose process has died.

## nvim integration

See `nvim/send-diff.lua`. It shells out to `list-channels.ts` to populate a picker, then `send-diff.ts` to send the current buffer's diff. See [how the nvim plugin talks to this skill](references/nvim-integration.md).

## Limitations

- Channels are a research preview: flag syntax and protocol may change.
- No built-in auth on the HTTP listener — it's bound to 127.0.0.1 only. Don't expose the port beyond localhost.
- One channel server per project; running `start-channel.ts` again for the same project overwrites its registry entry when the old process has died, but two live sessions for the same project name will collide in the registry (last one to start wins the recorded port).
