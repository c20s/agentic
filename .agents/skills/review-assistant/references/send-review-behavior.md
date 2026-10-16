# What send-review.ts does

```sh
bun scripts/send-review.ts <findings-file>
```

1. Reads the findings JSON file.
2. Goes through each finding one at a time, in order. For each, prints it and asks: `y` include it, `n` skip it, `e` edit the subject and include it, `q` stop asking and move on with whatever's selected so far.
3. If nothing was selected, stops there. Nothing is written or sent.
4. If the findings file has no `pr` URL, this is a local review — the script writes `review-output.md` straight away and stops. It does not ask where to send anything, since there's nowhere else to send it.
5. If the findings file has a `pr` URL, it asks where to send the selected findings:
   - `1` — post as a GitHub PR review, one inline comment per finding, at the file and line given. Uses `gh api` under the hood, so `gh` must be logged in.
   - `2` — write a markdown file, `review-output.md`, in the current directory.

## Why this is interactive and not scripted end to end

The whole point of this script is that nothing gets sent without a human saying yes to each item first. Don't call this script with piped answers to skip the prompts — if you want to pre-select findings, edit the findings JSON file before running the script instead.

## GitHub comments and diff lines

`line` in the findings file is always a real file line number, never a position inside the diff — GitHub's API wants a real line number too, so there's no conversion needed there.

But GitHub only accepts an inline comment on a line that's actually part of the PR's diff. Before posting, the script fetches the PR's diff itself and checks every selected finding's line against it. Any finding whose line isn't part of the diff (the file changed since the review was written, or the line is unchanged context far from any edit) gets skipped with a message, instead of being sent and failing with a GitHub error. Everything else posts as normal.
