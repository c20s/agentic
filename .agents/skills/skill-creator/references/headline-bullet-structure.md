# Headline and bullet structure

`SKILL.md`'s body is organized as `##` headlines grouping related points, with each point as a single bullet underneath. No prose paragraphs, no nested sub-bullets explaining a single point across multiple lines.

```markdown
## Reviewing plans

- Check for unexpected destroys before approving. [details](references/unexpected-destroy.md)
- Flag any module pin that isn't exact. [details](references/module-pinning.md)

## Writing modules

- Variables need a `description` and a `type`. [details](references/variable-conventions.md)
```

Why this shape: the whole point of splitting a skill this way is that `SKILL.md` stays cheap to load in full, while the model pulls in only the one reference file relevant to the current task. A prose paragraph can't be split that cleanly — a bullet can. If a point needs more than one line to state, that's a sign it belongs entirely in the reference file, with just a short label left in the bullet.

Group bullets under headlines by topic area (e.g. "Reviewing plans" vs "Writing modules"), not by reference file name — the headline is for human and model scanning, not a mirror of the directory listing.
