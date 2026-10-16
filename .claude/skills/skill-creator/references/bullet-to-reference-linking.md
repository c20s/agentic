# Linking a bullet to its reference

Every bullet ends with a Markdown link, not an arrow or a bare path:

```markdown
- Check for unexpected destroys before approving. [details](references/unexpected-destroy.md)
```

- Use `[details](references/<case-name>.md)` as the standard link text — consistent link text makes the pattern instantly recognizable when scanning a skill.
- The path is relative to `SKILL.md`'s own location (`references/<case-name>.md`), never absolute and never with a leading slash — this is what makes the link resolve correctly both for the harness and when the file is rendered on GitHub.
- One bullet links to exactly one reference file. If a point genuinely needs two references, it's two bullets.
- Don't link to a reference file from more than one bullet. If two bullets need the same detail, the detail is either one case (merge the bullets) or the shared part belongs in `SKILL.md` itself, not a reference.
