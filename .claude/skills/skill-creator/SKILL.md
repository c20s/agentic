---
name: skill-creator
description: Use when creating or restructuring a skill in this repo, so it follows the repo's headline-and-bullet convention with one reference file per case.
---

## Naming and location

- Directory and frontmatter `name` must match exactly: lowercase letters, digits, hyphens only, 1-64 chars, no leading/trailing/consecutive hyphens. [details](references/naming.md)
- Skill lives at `.apm/skills/<skill-name>/SKILL.md`, with its references in a sibling `references/` directory. [details](references/directory-shape.md)

## Writing the description

- Lead with the trigger condition ("Use when...", "Apply when..."), not a feature summary — this is what the harness matches against. [details](references/description-field.md)

## Writing the body

- Structure the body as headlines and bullet points, never prose paragraphs. [details](references/headline-bullet-structure.md)
- Each bullet states exactly one point in a single line, then ends with a Markdown link to its reference file. [details](references/bullet-to-reference-linking.md)
- Put the full reasoning, examples, and edge cases for that one point in its own `references/<case-name>.md` file — never in the bullet itself. [details](references/one-case-per-reference-file.md)

## Checking the result

- Validate frontmatter and structure before committing. [details](references/validation.md)
