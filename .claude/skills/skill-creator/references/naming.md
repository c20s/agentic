# Naming

The frontmatter `name` and the parent directory name must be identical strings. If they differ, apm uses the directory name and silently ignores the declared `name` — so a mismatch is a bug that produces no error.

Rules for the name:

- Lowercase letters, digits, and hyphens only (`a-z`, `0-9`, `-`).
- 1 to 64 characters.
- No leading or trailing hyphen.
- No consecutive hyphens (`--`).

Pick a name that describes the trigger domain, not the output: `terraform-pr-reviewer`, not `terraform-helper`. A reader scanning `.apm/skills/` should be able to guess when each skill fires from its name alone.
