# gh-review-list

Lists open GitHub PRs you care about: your own (assigned + review-requested), PRs you've authored,
and your team's (for spotting things to review), enriched with review/comment status and a computed
priority.

Used both as a CLI (`pnpm run prs` from the repo root) and as the `gh_review_list` tool in
`local-mcp-server`.

## Requirements

- [`gh`](https://cli.github.com/) installed and authenticated (`gh auth login`).

## CLI usage

```sh
pnpm run prs             # pretty ANSI table, uses cache if fresh
pnpm run prs -- --json   # machine-readable JSON instead of the table
pnpm run prs -- --refresh  # bypass the cache and re-fetch from GitHub
```

## Config — `~/.config/c20s/prs.json`

All fields are optional; missing file = defaults (no team, no caching beyond 120s).

```json
{
  "teams": ["my-org/my-team"],
  "extraAuthors": ["someone-not-on-the-team"],
  "extraSearchQueries": ["label:needs-review"],
  "repos": ["my-org/my-repo"],
  "includeArchived": false,
  "cacheTtlSeconds": 120
}
```

- `teams`: `"org/team"` slugs — members' open PRs are pulled in (via `gh api /orgs/{org}/teams/{team}/members`).
- `extraAuthors`: individual logins to include alongside team members.
- `extraSearchQueries`: raw extra arguments appended to `gh search prs` (e.g. `"label:needs-review"`),
  run as additional searches and merged in.
- `repos`: restricts the team/author searches to these repos. Empty = unrestricted.
- `includeArchived`: set `true` to include PRs from archived repositories. Defaults to `false`, i.e.
  every search is run with `--archived=false` so PRs sitting in archived repos never clutter the list.
- `cacheTtlSeconds`: how long a fetch is cached on disk before being considered stale. `0` disables caching.

## Caching

Results (your PRs + authored PRs + team PRs, fully enriched) are cached under `~/.cache/c20s/prs/`,
keyed by your GitHub login, the active config, and an internal cache schema version, so repeated
calls within `cacheTtlSeconds` don't re-hit `gh` at all. The schema version is bumped whenever
`ReviewListResult`'s shape changes, so upgrading never hands back a stale, incompatible cache entry —
it's just treated as a miss. Pass `--refresh` (CLI) or `{ refresh: true }` (library/MCP) to force a
re-fetch regardless.

## Library usage (used by local-mcp-server)

```ts
import { getReviewList, renderReviewList } from "gh-review-list";

const result = await getReviewList(); // { mine, authored, team, login, generatedAt, fromCache }
console.log(renderReviewList(result));
```
