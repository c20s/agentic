# Writing the findings file

Write findings as a JSON file. Put it next to where you're working, named `review-findings.json`, unless the user asks for a different path.

## Shape

```json
{
  "pr": "https://github.com/owner/repo/pull/42",
  "findings": [
    {
      "label": "issue",
      "decoration": "blocking",
      "file": "src/parse.ts",
      "line": 42,
      "subject": "this throws on an empty array",
      "discussion": "line 42 calls .at(0) without checking length first"
    },
    {
      "label": "nitpick",
      "decoration": "non-blocking",
      "file": "src/parse.ts",
      "line": 10,
      "subject": "maybe rename this, not a big deal",
      "discussion": null
    }
  ]
}
```

## Fields

| Field | Required | Notes |
|---|---|---|
| `pr` | No | The PR URL, if this review is for a PR. Leave it out for a local-only review. |
| `findings` | Yes | A list, even if it has one item. |
| `findings[].label` | Yes | One of the conventional-comments labels. |
| `findings[].decoration` | No | `blocking`, `non-blocking`, or `if-minor`. Leave out if none applies. |
| `findings[].file` | Yes | Path relative to the repo root. |
| `findings[].line` | Yes | The real line number in the file as it exists now — not a position inside the diff. If a finding is about a range of lines, still give one line here: the one the comment should sit on (usually the last line of the thing you're pointing at). |
| `findings[].subject` | Yes | The one-line comment, already written in the right voice for its label. If the finding is about more than one line, say that in the subject or discussion, since the JSON only carries one line number. |
| `findings[].discussion` | No | Longer reasoning, or `null` if the subject says enough on its own. |

## Why JSON and not markdown

`scripts/send-review.ts` reads this file to build both the interactive prompt and the GitHub API calls. JSON keeps `file`, `line`, `label`, and `subject` as separate fields it can use directly, instead of having to parse them back out of formatted text. See [what send-review.ts does](send-review-behavior.md) for exactly how it uses this file.
