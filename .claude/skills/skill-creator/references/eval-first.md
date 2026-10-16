# Testing a skill before you write it

Don't guess what a skill should say. Try the task first, see what goes wrong, then write instructions that fix exactly that.

## Steps

1. Pick 2-3 real tasks the skill should help with.
2. Try them without the skill. Use normal prompting.
3. Write down exactly what went wrong. Not "it struggled" — the actual wrong output, or the thing you had to explain yourself.
4. For each problem, write one short bullet that fixes it. If a fix needs more than a line or two, put it in a reference file instead.
5. Try the same tasks again, this time with the skill. Check that the problems are gone.
6. Stop there. Don't add instructions for problems you haven't actually seen.

## Example

Task: "Write a commit message for this diff."

Without a skill, Claude wrote: `Updated files`. Too vague — no type, no scope, no reason why.

The fix, added to `SKILL.md`:

```markdown
## Commit messages

- Use the format `type(scope): summary`, then a line explaining why. See [examples](references/commit-examples.md).
```

One bullet, because there was one problem: the format was unknown. The examples file holds a few sample messages, since examples teach a format better than a description does.

## Before you share a skill

- You tried at least 3 real tasks with it.
- If people will use it with different Claude models, you tried it with more than one model. A short skill might work for a strong model but need more detail for a smaller one.
