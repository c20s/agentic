# Finding the clone location

The context file at `~/.config/c20s/context.json` looks like this:

```json
{
  "default": "/Users/me/code",
  "orgs": {
    "my-work-org": "/Users/me/work"
  },
  "repos": {
    "agentic-": "/Users/me/agentic-projects"
  }
}
```

## Order of checks

1. **Repo prefix match.** Look at `repos`. If any key is a prefix of the repo name (for example `"agentic-"` matches `agentic-foo`), use that path. This is checked first because it's the most specific.
2. **Org match.** If no repo prefix matched, look at `orgs`. If the PR's org has an exact entry, use that path.
3. **Default.** If neither matched, use `default`.
4. **Nothing set.** If the file doesn't exist, or none of the above apply, you have no known location. Ask the user where to clone it.

## Asking the user

Even if you found a match, say what you found and let the user correct it:

> "I'll clone this into `/Users/me/code`. Is that right, or should it go somewhere else?"

If the user gives a new or different path, save it before moving on. Ask them whether this path is just for this one repo, this org, or should become the new default, so you save it with the right flag.
