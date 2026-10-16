---
name: review-prepare
description: Sets up a local git worktree for reviewing a GitHub pull request. Use when the user gives a GitHub PR link and wants to review, check out, or look at the code locally.
---

# Review prepare

Turns a GitHub PR link into a ready-to-review local checkout: clones the repo if needed, then creates a git worktree for that PR's branch.

## Steps

1. Get the PR link from the user. It must look like `https://github.com/<owner>/<repo>/pull/<number>`.
2. Check `bun --version` and `gh --version` are available. If either is missing, stop and tell the user what to install.
3. Read `~/.config/c20s/context.json` if it exists, using `scripts/context.ts`. This file remembers where repos are cloned.
4. Work out where this repo should live, using the rule in [finding the clone location](references/finding-clone-location.md).
5. If you're not already sure of the location from context, ask the user to confirm it before doing anything. Never clone without confirming the path first.
6. Once confirmed, save it with `bun scripts/save-context.ts <path> [--org <org> | --repo-prefix <prefix>]` so you don't have to ask again next time.
7. Run `bun scripts/clone-repo.ts <pr-url> <path>`. It clones the repo if missing, then fetches the PR branch into a worktree named `<repo>-pr-<number>` next to the main clone. See [what clone-repo.ts does](references/clone-repo-behavior.md) for the exact steps and output.
8. Tell the user the worktree path from the script's output. That's where the review happens.

## Fixing problems

- If `gh pr view` fails, the PR link is wrong or `gh` isn't logged in. Run `gh auth status` to check.
- If the worktree already exists, the script reuses it and does nothing else — this is expected on a second run of the same PR.
