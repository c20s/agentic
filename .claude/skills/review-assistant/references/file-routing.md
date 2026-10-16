# File routing

Specific path or filename matches. Check these before falling back to file extension.

| Match | Domain |
|---|---|
| `**/*.test.*`, `**/*.spec.*`, `tests/**`, `test/**`, `__tests__/**` | tests |
| `eslint.config.*`, `.eslintrc*` | config |
| `tsconfig*.json` | config |
| `*.config.js`, `*.config.ts`, `*.config.json` | config |
| `Dockerfile`, `docker-compose*.yaml`, `docker-compose*.yml` | config |
| `.github/workflows/**` | config |
| `README*`, `CONTRIBUTING*`, `CHANGELOG*`, `**/*.md` | docs |
| `*.agent.md`, `SKILL.md`, `*.instructions.md`, `*.prompt.md` | docs (this repo's own primitives — review them as documentation, not code) |

## Fallback by extension

| Extension | Domain |
|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.rb`, `.java`, `.cs` | code |
| `.yaml`, `.yml`, `.json`, `.toml`, `.ini`, `.env*` | config |
| `.md`, `.mdx`, `.txt` | docs |

## When nothing matches

If a file matches neither table, say so and review it as general code — don't skip it.

## Adding a new domain later

When a domain gets its own checklist file (for example `references/code.md`), add its file patterns here and point to the new file from `SKILL.md`'s dispatch rules.
