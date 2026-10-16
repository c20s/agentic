# Directory shape

```
.apm/skills/<skill-name>/
├── SKILL.md
└── references/
    ├── <case-one>.md
    ├── <case-two>.md
    └── <case-three>.md
```

- `SKILL.md` is the only file loaded automatically when the skill triggers. Everything else is loaded on demand, only when a bullet's link is followed.
- `references/` sits next to `SKILL.md`, not nested deeper. Links from `SKILL.md` are plain relative paths (`references/<case-name>.md`) so they resolve both on disk and when rendered on GitHub.
- Don't add other top-level files (`templates/`, `scripts/`) unless the skill genuinely needs runnable assets — a pure-instruction skill needs only these two things.
