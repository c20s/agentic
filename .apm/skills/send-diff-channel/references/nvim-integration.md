# nvim plugin contract

The plugin never talks to Claude Code directly — it only calls into `scripts/send-diff.ts` via the `bun` CLI, using the skill directory as cwd.

## Send the current buffer's diff

```sh
bun scripts/send-diff.ts <absolute-file-path>
```

- If exactly one registered channel's project root covers the file, it sends immediately and prints a confirmation to stdout.
- If several do, it prints `{"needsSelection": true, "candidates": ["proj-a", "proj-b"]}` to stdout and does nothing else. Re-run with `--project <name>` to send.
- If none do, or the matched session has died, it exits non-zero with a message on stderr.

```sh
bun scripts/send-diff.ts <absolute-file-path> --project <name>
```

## nvim flow

1. User runs `:ClaudeSendDiff`.
2. Plugin calls `send-diff.ts <current-buffer-path>`.
3. If stdout parses as `{needsSelection: true, candidates: [...]}`, show `vim.ui.select` over `candidates`, then re-call with `--project <choice>`.
4. Otherwise show the script's stdout/stderr via `vim.notify`.

`scripts/list-channels.ts` still exists standalone for inspecting `~/.config/c20s/channels.json` directly, but the plugin doesn't need it.
