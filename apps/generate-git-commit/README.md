# generate-git-commit

## install-commit-hooks.ts

Installs the `prepare-commit-msg` hook in every repo under a path. Recursively looks for `.git` directories but stops descending as soon as one is found (does not look inside submodules/nested repos). Symlinks the hook, skipping repos that already have their own custom (non-symlink) hook.

```
bun run apps/generate-git-commit/install-commit-hooks.ts [path]
```

`path` is optional, defaults to `.`. Supports `~/`.

```
bun run apps/generate-git-commit/install-commit-hooks.ts ~/dev/c20s
```

## generate-commit-message.ts

Run automatically by the `prepare-commit-msg` hook (installed by the script above). Not meant to be invoked directly. On `git commit` (without `-m`), it generates a Conventional Commits message from the staged diff using Claude, and streams the response live as it's written.

Behavior is controlled by `~/.config/c20s/pre-commit-message.json`:

```json
{ "mode": "ask" }
```

- `"ask"` (default if the file is missing or invalid) — prompts in the terminal each time whether to generate a message.
- `"always"` — always generates without asking.
- `"manual"` — never generates; you write the commit message yourself.

`-m`/`-F`/merge/squash/template commits always skip generation regardless of `mode`.

## prepare-commit-msg-hook.sh

The actual hook file symlinked into each repo's `.git/hooks/`. Finds and runs `generate-commit-message.ts` relative to its own location. Never run manually.
