---
name: review-orchestrator
description: Runs a full code review by chaining two other skills — new-senior-developer first, then expert-senior-developer — into one combined review.md. Use whenever a review is requested, instead of applying either skill alone.
---
This skill does not review code itself. It drives `new-senior-developer` and `expert-senior-developer` (in that order) into one shared file, `review.md`, at the repo root. Follow these steps in order, don't skip or reorder them.

## 1. Fresh start

Before anything else, check whether `review.md` already exists at the repo root. If it does, delete it (`delete_file`) so this run starts clean — a stale review.md from a previous run must never leak into this one.

## 2. `new-senior-developer` pass

1. Load the skill: `get_context({ symbol: "new-senior-developer" })`.
2. Build the review context for whatever is being reviewed (uncommitted changes, a commit, a PR, a branch, or explicit files — use `review_context` with the matching `mode`, or build the equivalent context yourself if `review_context` doesn't apply).
3. Apply the skill's persona and rules to that context, and write its comments to `review.md` (new file) in the skill's own conventional-comments format, completely unchanged. Don't add a heading naming the skill, don't summarize, don't filter anything out — this file is step 2's raw, complete output.

## 3. `expert-senior-developer` pass, blind to step 2

1. Load the skill: `get_context({ symbol: "expert-senior-developer" })`, and whichever `references/<language>.md` files it points you to for the language(s) involved.
2. **Do not read `review.md` before or during this step.** The expert pass must reach its own conclusions from the code alone, not be anchored by the first pass's comments. Build the review context the same way as step 2 did, and run the skill's own diff pass → context pass → reconcile workflow exactly as described in its `SKILL.md`, ending with its own final comment list, held in memory — not yet written anywhere.

## 4. Merge

Only now, read the existing `review.md` from step 2.

1. Go through every comment currently in `review.md`. For each one, use the repo knowledge and findings gathered in step 3 (full-file reads, usages, dependencies, existing repo patterns, language best practices) to decide if it still holds. Remove any comment that step 3's findings show is not relevant — e.g. a question step 3 already answered from the code, a "why is this duplicated" that turns out to match 3 other call sites on purpose, or anything step 3's language reference shows is just an idiomatic, non-issue pattern. Leave every comment that still holds untouched — don't reword or re-order what survives.
2. Append the `expert-senior-developer` pass's own comments (from step 3) after what survives, in the same conventional-comments format, separated the same way the rest of the file separates comments.
3. Write the result back to `review.md`, overwriting it. This is the final output of this skill — don't produce a separate summary elsewhere.

## Notes

- The two passes must use the same underlying diff/change — don't let `new-senior-developer` review one thing and `expert-senior-developer` review another.
- If `expert-senior-developer` has no reference file for a language in the diff, it still runs (see its own `SKILL.md`) — don't skip step 3 for that reason.
- Conventional-comments format (shared by both skills, keep it consistent across the merged file):

  ```md
  [filename:linefrom(-lineto)]
  **<issue|suggestion|question|praise>**: <short headline-why>

  <longer-body-what>

  ---
  <next-comment>
  ```
