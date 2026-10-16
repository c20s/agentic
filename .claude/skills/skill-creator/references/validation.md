# Validating before committing

Run before opening a PR:

```sh
apm compile --validate
apm compile -t claude
apm compile -t copilot
```

`apm compile --validate` catches frontmatter and structural errors (mismatched `name`, malformed YAML, missing required fields) without deploying anything. The two `apm compile -t` runs confirm the skill actually compiles for both of this repo's declared targets.

Also check by hand, since the CLI won't catch these:

- Every bullet in `SKILL.md` ends with a `[details](references/...)` link.
- Every file listed in `references/` is linked from at least one bullet — an orphaned reference file is dead weight.
- Every link in `SKILL.md` resolves to a file that actually exists under `references/`.
