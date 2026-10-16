# What clone-repo.ts does

```sh
bun scripts/clone-repo.ts <pr-url> <base-dir>
```

Steps it runs, in order:

1. Parses `<pr-url>` to get the owner, repo, and PR number.
2. Runs `gh pr view <pr-url>` to get the real PR number, head branch name, and base branch name. This also checks the PR link is valid.
3. If `<base-dir>/<repo>` doesn't exist yet, clones it: `git clone git@github.com:<owner>/<repo>.git`.
4. If `<base-dir>/<repo>-pr-<number>` doesn't exist yet:
   - Fetches the PR's branch directly: `git fetch origin pull/<number>/head:pr-<number>`. This works even if the PR comes from a fork, since it doesn't need the fork added as a remote.
   - Creates the worktree: `git worktree add <base-dir>/<repo>-pr-<number> pr-<number>`.
5. If the worktree already exists, it skips straight to printing the result. It never deletes or recreates an existing worktree.
6. Prints one line of JSON with the repo path, worktree path, PR number, and head branch name.

## Example

```sh
bun scripts/clone-repo.ts https://github.com/cli/cli/pull/1 /Users/me/code
```

```json
{"owner":"cli","repo":"cli","number":1,"headRefName":"gh-pr","repoDir":"/Users/me/code/cli","worktreeDir":"/Users/me/code/cli-pr-1"}
```

Result on disk:

```
/Users/me/code/
├── cli/             # main clone, untouched
└── cli-pr-1/        # worktree, checked out to the PR's branch
```

## If the base dir isn't known yet

Pass it explicitly as the second argument, like in the example above. The script does not ask the user anything — that's the skill's job, before calling the script.
