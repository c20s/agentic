---
name: skill-creator
description: Creates and restructures skills in this repo, following Anthropic's skill best practices and this repo's house style. Use when adding a new skill, reviewing an old one, or deciding if a point should be inline or in a separate file.
---

# Skill creator

Read Anthropic's guide first: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices. This file only adds the house-style rules on top of it.

## Naming

- The folder name and the `name` in the frontmatter must match exactly.
- Use lowercase letters, numbers, and hyphens only. No `claude` or `anthropic` in the name.
- Use a verb-ing name (`processing-pdfs`) or a short noun phrase (`pdf-processing`). Don't use vague names like `helper` or `utils`.

## Writing the description

- Write it in third person: "Extracts text from PDFs", not "I can help you extract text".
- Say what the skill does, and when to use it.
- Keep it under 1024 characters.

## Writing the body

- Use headlines and short bullet points. No long paragraphs.
- If a point is short and always useful, write it directly as a bullet. Most points should stay this way.
- Only move a point into its own file in `references/` if it is long, or only needed sometimes. A good test: would most tasks skip this file? If yes, it can be a reference. If every task needs it, keep it in `SKILL.md`.
- When you do link to a reference file, write it like this: `[short label](references/file-name.md)`. Use a relative path.
- One bullet should link to one file. If two bullets want the same file, merge the bullets.
- A reference file should not link to another reference file. If you need that, split the skill into two skills instead.
- If a reference file is longer than 100 lines, add a short list of contents at the top.
- Keep `SKILL.md` under 500 lines. If it's getting long, move more into references instead of writing more.
- Use the same words for the same thing throughout the skill.

## Before you ship it

- Try the task without the skill first. Write down exactly what went wrong or what you had to explain by hand.
- Only write instructions that fix what actually went wrong. Don't guess at problems you haven't seen. See [testing a skill before you write it](references/eval-first.md) for the full steps and an example.
- Run these checks:
  ```sh
  apm compile --validate
  apm compile -t claude
  apm compile -t copilot
  ```
- Check that every file in `references/` is linked from a bullet, and every link points to a file that exists.

## Example

See [a full before-and-after example](references/worked-example.md) of turning a messy skill into a clean one.
