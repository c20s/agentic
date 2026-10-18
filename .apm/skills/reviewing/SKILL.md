---
name: reviewing
description: Reviews code, tests, docs, or config and writes feedback as conventional comments, in a plain, humble, human voice. Also does a full-repo audit with a rated report when asked to review a whole repo. Use when the user asks for a review of a diff, a PR, a file, or a whole repo.
---

# Reviewing

One entrypoint for reviewing anything: code, tests, docs, config. This file has the rules that apply to every review. Domain checklists (what to actually look for in code vs tests vs docs) live in their own reference files and get added over time — if none exist yet for the files you're reviewing, use your own judgment for what to check, but still follow the format and voice rules below.

## Two modes

- "Review this repo" (or "rate this codebase", "give me an overview of this repo") means a full-repo audit: read [full-repo review](references/full-repo-review.md) and stop reading the rest of this file — that reference has everything you need, and it doesn't use conventional comments or the findings file.
- "Review this branch/PR/diff/file" is the normal mode: everything below this section.

## Before you start

- Read the repo's own `CONTRIBUTING.md` and `README.md` first, if they exist. Judge the change against what that repo actually asks for, not generic taste.
- Check if the repo has its own skills (for example under `.apm/skills/` or `.claude/skills/`) that cover how things should be structured or written here. If one applies to what you're reviewing, follow it.
- Work out if this is a review of a PR or a review of local, uncommitted or unpushed work. If the user didn't give a PR link, or gave one but `gh pr view` finds none for the current branch, treat it as local: there's no `pr` URL for the findings file, and the only output that makes sense is the markdown file — see [after the review is done](#after-the-review-is-done).

## Deciding what applies

- Check [file routing](references/file-routing.md) first. It lists specific paths and filenames (like `eslint.config.json` or `tests/**/*.spec.ts`) that map to a domain. Specific matches win.
- If nothing specific matches, fall back to the file extension (`.ts`, `.md`, `.yaml`, and so on).
- A single review usually touches more than one domain. Check every changed file against the routing list — don't stop after finding the first match.

## Structure and architecture

- On every review, always consider whether the change is in the right place, not just whether it's correct. This matters as much as correctness.
- If something would be cleaner somewhere else — a function that belongs in a different file, a concept that belongs in its own module, a doc that belongs in a different skill's reference — say so, even if nothing is actually broken. See [structure and architecture](references/structure-and-architecture.md) for how to phrase this and what to look for.

## Format

- Each finding is a conventional comment: a label, an optional decoration, a subject, and an optional longer discussion. Labels and decorations are the standard ones from conventionalcomments.org: `praise`, `nitpick`, `suggestion`, `issue`, `todo`, `question`, `thought`, `chore`, `note`, with `(blocking)`, `(non-blocking)`, `(if-minor)` as decorations.
- Every finding needs a file and a line number — the real line number in the file, not a position in the diff. If the finding is about a range of lines, point to one line (usually the last one) and mention the range in the subject or discussion.
- Include at least one `praise` finding per review, but only if something genuinely deserves it. Don't invent praise to be nice.

## Voice

- Read [voice by severity](references/voice-by-severity.md) before writing anything. The tone changes depending on the label — blocking issues are said plainly, nitpicks are hedged and humble. Getting this right matters as much as finding the right problems.
- Never sound like an AI wrote it. No "I would suggest considering", no "Great work overall!", no filler.

## This skill never sends the review

This skill only produces findings. It does not post comments, open PR reviews, or write anywhere outside the findings file. Sending is a separate, human-approved step — see [writing the findings file](references/writing-findings.md) for where it goes and how `scripts/send-review.ts` uses it.

## Before writing the findings file

- Go back through every finding and try to prove it wrong. Re-read the actual code at that line. Drop or soften anything you can't back up. See [verify step](references/verify-step.md).
- Keep the findings in the order the files appear in the diff, not grouped by severity.

## After the review is done

1. Write the findings to a JSON file, in the shape described in [writing the findings file](references/writing-findings.md). Leave out `pr` entirely if this is a local, pre-PR review.
2. If there's no PR, say so and run `bun scripts/send-review.ts <findings-file>` straight away — with no `pr` in the file, the script only offers the markdown output, so there's nothing to ask the user about first.
3. If there is a PR, tell the user the file is ready and ask if they want to send it now. If yes, run `bun scripts/send-review.ts <findings-file>`. It's an interactive script — it will ask the user about each finding itself, including where to send it. Don't pre-filter the findings yourself.
