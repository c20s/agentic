# One case per reference file

Each file under `references/` covers exactly one case, scenario, or sub-topic — the thing a single bullet in `SKILL.md` points at. Nothing else goes in it.

- Don't group multiple unrelated cases into one reference file "for convenience." If two cases end up in the same file, they either are one case (merge the bullets pointing at them) or need to be split into two files with two separate bullets.
- A reference file can be as long as the case needs — unlike `SKILL.md`, it isn't always loaded, so its cost is only paid when the model actually follows the link.
- Name the file after the case, not the skill: `unexpected-destroy.md`, not `terraform-case-1.md`. The name should make sense read on its own in a file listing.
- It's fine for a reference file to be short — a few lines is enough if that's all the case needs. The goal isn't length, it's isolation: loading one case never pulls in another.
