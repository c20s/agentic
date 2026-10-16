# Scripts

## install-commit-hooks.ts

Installs the `prepare-commit-msg` hook in every repo under a path. Recursively looks for `.git` directories but stops descending as soon as one is found (does not look inside submodules/nested repos). Symlinks the hook, skipping repos that already have their own custom (non-symlink) hook.

```
bun run scripts/install-commit-hooks.ts [path]
```

`path` is optional, defaults to `.`. Supports `~/`.

```
bun run scripts/install-commit-hooks.ts ~/dev/c20s
```

## generate-commit-message.ts

Run automatically by the `prepare-commit-msg` hook (installed by the script above). Not meant to be invoked directly. On `git commit` (without `-m`), it prompts in the terminal whether Claude should generate a Conventional Commits message from the staged diff, and streams the response live as it's written.

## prepare-commit-msg-hook.sh

The actual hook file symlinked into each repo's `.git/hooks/`. Finds and runs `generate-commit-message.ts` relative to its own location. Never run manually.

## watch-git-commits.ts

Watches all `.git` directories under a path and logs new commits live across all repos.

```
bun run scripts/watch-git-commits.ts [path]
```

`path` is optional, defaults to `.`. Supports `~/`.

```
bun run scripts/watch-git-commits.ts ~/dev/c20s
```

Stop with Ctrl+C.
