# Full repo review

A full-repo review is different from a normal review. It doesn't look at a diff — it looks at the whole repo, and it produces one markdown report instead of conventional-comment findings. Use this for a first look at an unfamiliar repo, or before a really big PR where a normal diff review isn't enough context.

This still follows the general rules from the rest of this skill where they make sense: read the repo's own `CONTRIBUTING.md`/`README.md` first, write in the same plain and humble voice, don't invent praise. It does not use the findings JSON file or `send-review.ts` — this is a single markdown report, written directly, with nothing to select or send.

## The two parts of the report

1. **Overview** — a 2-minute read. What the repo is, how it's built, what state it's in, at a glance.
2. **Ratings** — the 6 categories below, each scored 1-5, plus one combined score.

Both parts go in one file. Overview first, ratings below it.

## The 2-minute limit is a hard limit

The overview section must be readable in 2 minutes. That's roughly 400-500 words, not a word-for-word budget to hit exactly, but a real ceiling — if you're explaining in paragraphs, you've gone over. Use short sections, not prose:

- What the repo does, in 1-2 sentences.
- The main pieces (a short list: the stack, the top-level structure, anything unusual).
- What stands out, good or bad, in a few bullets.

If you find yourself wanting to explain something at length, that detail belongs in the ratings section below, not the overview.

## The 6 categories

Score each 1-5. 1 is a real problem, 5 is genuinely excellent — don't default to the middle. Give one line of reasoning per score, not a bullet list.

1. **Architecture** — do the pieces fit together sensibly? Are responsibilities where you'd expect them?
2. **Structure** — within that architecture, is the file/folder layout easy to navigate? Would a newcomer find things where they'd look for them?
3. **Test quality** — this is not about coverage percentage. Do the tests check real behavior, not implementation details? Would they survive a reasonable refactor? Can you tell what's being tested just by reading the test?
4. **Best practices** — does the repo follow sensible, common conventions for its language/stack? Linting, formatting, error handling, consistency.
5. **Complexity** — is the code as simple as the problem allows, or is there unnecessary abstraction, cleverness, or indirection?
6. **Maturity** — does this feel like a repo that's been cared for over time (sensible history, docs that match reality, dependencies kept reasonably current), or one that's been left to drift?

## Combined score

After the 6 individual scores, give one combined score: the average, rounded to one decimal. State it plainly, don't hide it in a sentence — it's the number someone skimming the report is looking for.

## Report shape

```markdown
# Repo review: <name>

## Overview

<2-minute read: what it is, main pieces, what stands out>

## Ratings

| Category | Score | Why |
|---|---|---|
| Architecture | 4/5 | one line |
| Structure | 3/5 | one line |
| Test quality | 2/5 | one line |
| Best practices | 4/5 | one line |
| Complexity | 3/5 | one line |
| Maturity | 4/5 | one line |

**Overall: 3.3/5**
```

## Where to look

Don't read every file. Read enough to judge each category honestly:

- `README.md`, `CONTRIBUTING.md`, and any top-level docs — for maturity and structure.
- The top-level folder layout and a few representative source files — for architecture and complexity.
- A handful of actual test files, not just their names — for test quality. Open at least 2-3, don't judge from file count alone.
- Lint/format config, CI config if present — for best practices.
- Commit history at a glance (recent activity, commit message quality) and dependency file dates — for maturity.

If something is missing entirely (no tests, no docs, no CI), that's real information for the relevant category — say so plainly, don't soften it just because it's a whole-repo judgment rather than a single finding.
