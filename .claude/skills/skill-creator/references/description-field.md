# The description field

`description` is what the harness matches against to decide whether to load the skill for a given task — it is not documentation for a human reader browsing the repo.

- Start with the trigger condition: "Use when...", "Apply when...". Lead with the situation, not the capability.
- Describe the user's intent or the state of the world that should cause this skill to fire, not what the skill then does.
- Keep it to one or two sentences, under 1024 characters.

Bad: `Helps review Terraform pull requests and checks module pins.`
Good: `Apply when a user shares a Terraform pull request or asks why a plan shows unexpected resource changes.`

The bad version describes features. The good version describes the trigger — a task-matcher can act on it, a feature list can't.
