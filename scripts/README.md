# Scripts

Commit message generation and hook installation moved to `apps/generate-git-commit`.

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
