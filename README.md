# agentic

A curated collection of Claude Code skills and agents, installable with [apm](https://microsoft.github.io/apm) (Agent Package Manager).

## Install

```sh
apm install c20s/agentic
```

Install a single skill or agent instead of the whole package:

```sh
apm install c20s/agentic/.apm/skills/<skill-name>
apm install c20s/agentic/.apm/agents/<agent-name>.agent.md
```

## What's in here

| Path | Primitive | Purpose |
|---|---|---|
| `.apm/skills/` | Skills (`SKILL.md`) | Triggered automatically when a task matches their `description` |
| `.apm/agents/` | Agents (`*.agent.md`) | Named personas with their own system prompt, model, and tool whitelist |
| `.apm/instructions/` | Instructions (`*.instructions.md`) | Always-on or glob-scoped style/behavior rules |
| `.apm/prompts/` | Prompts (`*.prompt.md`) | Parameterized, reusable prompt templates |

Browse each directory's `README.md` for the current list — this file documents structure, not contents, so it doesn't go stale as skills are added.

## Repo layout

```
agentic/
├── apm.yml                 # package manifest (name, version, targets, deps)
├── apm.lock.yaml            # generated lockfile — commit this, never hand-edit
├── .apm/
│   ├── skills/
│   │   └── <skill-name>/
│   │       ├── SKILL.md
│   │       ├── references/  # optional, linked from SKILL.md, not auto-loaded
│   │       └── scripts/      # optional, code the skill tells Claude to run
│   ├── agents/
│   │   └── <agent-name>.agent.md
│   ├── instructions/
│   │   └── <name>.instructions.md
│   └── prompts/
│       └── <name>.prompt.md
├── .github/                 # compiled output for GitHub Copilot — generated, do not edit
├── .claude/                 # compiled output for Claude Code — generated, do not edit
└── CONTRIBUTING.md
```

Everything under `.apm/` is source. Everything under `.github/` and `.claude/` is build output produced by `apm compile` — never edit those directly, your changes will be overwritten on the next install.

## Targets

This package declares support for:

- **Claude Code** (`claude`) — primary target
- **GitHub Copilot** (`copilot`)

## Primitive formats

### Skill — `.apm/skills/<name>/SKILL.md`

```markdown
---
name: terraform-pr-reviewer
description: Reviews Terraform pull requests for unexpected resource changes and module pin issues. Use when a user shares a Terraform PR or asks why a plan shows unexpected changes.
---

## Reviewing plans

- Put `terraform plan` output in a fenced code block, never pasted raw.
- Flag any module pin that isn't exact. See [module pinning](references/module-pinning.md) for the full decision tree.
```

- `name` must match the folder name: lowercase letters, numbers, hyphens only, 1–64 characters, no leading, trailing, or doubled hyphens. Use a verb-ing name or a short noun phrase.
- `description` is written in third person and says both what the skill does and when to use it — this is what the harness matches against.
- The body is headlines and bullet points, not paragraphs. Keep a point inline if it's short and always useful. Only move it into `references/<case-name>.md` if it's long or only needed sometimes — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full rule. Not every bullet needs a linked file.

```
.apm/skills/<skill-name>/
├── SKILL.md                 # headlines + bullets; short points stay inline, long ones link out
└── references/
    └── <case-name>.md       # only long or situational detail
```

A skill can also ship real code in a `scripts/` folder, for tasks better done by running a script than by asking Claude to write one each time. Tell Claude the exact command to run, and have the skill check the runtime (e.g. `bun --version`) before relying on it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full convention.

### Agent — `.apm/agents/<name>.agent.md`

```markdown
---
name: security-review
description: Reviews diffs for OWASP top-10 issues and missing input validation.
model: claude-sonnet-5-5
tools:
  Read: true
  Grep: true
color: "#c0392b"
---

System prompt body goes here.
```

Fields: `name` (recommended, avoid `default`/`start`), `description` (required), `model` (optional), `tools` (optional whitelist — format varies per target harness), `color` (optional), `handoffs` (optional list of agent names).

Windsurf and Gemini don't support `.agent.md` — author those personas as skills instead if you need cross-target coverage.

### Instructions — `.apm/instructions/<name>.instructions.md`

```markdown
---
description: Python style rules enforced on src/ and tests/
applyTo: "**/*.py"
---

- Rule one.
- Rule two.
```

`description` is required. `applyTo` scopes the rule to matching files via glob(s); omit it for an unconditional rule folded into compiled context files (e.g. `AGENTS.md`).

### Prompts — `.apm/prompts/<name>.prompt.md`

Parameterized templates, filled via `apm run --param key=value`.

## Common commands

| Command | Effect |
|---|---|
| `apm install` | Resolve `apm.yml`, deploy primitives to every detected agent client |
| `apm install -g c20s/agentic#<version>` | Instal agentic skills globally pinned to a specific version |
| `apm compile -t claude` | Compile `.apm/` into Claude Code's expected output format |
| `apm compile --validate` | Validate frontmatter/structure without deploying |
| `apm audit` | Scan for hidden-Unicode / supply-chain issues, detect drift between compiled output and working tree |
| `apm pack` | Bundle the package as a zip for sharing or marketplace publishing |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the authoring workflow.

## local-mcp-server logs

[`apps/local-mcp-server`](apps/local-mcp-server) is a local MCP server used to
give an agent a single, sandboxed, auditable filesystem interface. It logs
every tool call to `~/.claude/mcp-local-fs.log` (detail) and
`~/.claude/mcp-local-fs.summary.log` (one compact line per call). Root-level
`package.json` scripts help with those logs regardless of which project
you're currently working in:

| Command | Effect |
|---|---|
| `bun run logs:tail` | Follow the summary log (session, tool, bytes, duration) |
| `bun run logs:tail:detail` | Follow the detail log (full arguments + result preview) |
| `bun run logs:tail:all` | Follow both logs at once |
| `bun run logs:tail:session -- <sessionId> [detail]` | Follow only one session (grep-filtered); add `detail` for the detail log |
| `bun run logs:clear` | Truncate both log files |
| `bun run logs:clear:summary` | Truncate only the summary log |
| `bun run logs:clear:detail` | Truncate only the detail log |

The session id is printed by the MCP server at startup and on every log
line, e.g. `[1efcb748]`. See
[`apps/local-mcp-server/README.md`](apps/local-mcp-server/README.md) for
full details on the server itself.

## License

MIT — see [LICENSE](LICENSE).

## Upcoming features

- [x] `get_context` tool on the local MCP server (no args) returning a default, AGENTS.md-style response
      guideline. See `apps/local-mcp-server/src/context.ts`.
- [ ] Extend `get_context` with scripted `symbol` lookups (e.g. `review`, `get_project_overview`) — small,
      on-demand summaries of file structure / important files, and a short description of available
      skills + when to use them, drilling down into more specific skills depending on the task.
