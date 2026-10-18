# local-mcp-server

A local [MCP](https://modelcontextprotocol.io) server (TypeScript, runs with Bun) that
gives an agent **only one** way into your computer: through this tool.

The idea: a session should be startable with *only* this MCP registered, so that
all context (reading files, listing directories, searching) and all changes
(writing files) go through the same, auditable surface — no other filesystem
tool is needed or exposed.

## Tools

Read-only (context):

- `list_dir` – list files/directories
- `read_file` – read a file's content (see "Outline mode" below — the default
  is a shortened outline, not the whole file)
- `file_stat` – metadata (size, type, last modified)
- `search_files` – search text/regex in file CONTENT, implemented with [ripgrep](https://github.com/BurntSushi/ripgrep)
  (`rg` must be on `PATH`, e.g. `brew install ripgrep`). Supports:
  - `query` – text (default) or regex if `regex: true`
  - `filePattern` – glob filter, e.g. `*.ts`
  - `caseSensitive` – default `false`
  - Automatically skips `node_modules`, `.git`, `dist`, etc.
- `find_files` – find files based on FILE NAME/path (not content), also
  via ripgrep (`rg --files --glob`). Complements `search_files`
  (content) and `list_dir` (requires you to already be in the right directory):
  - `pattern` – glob (`*.ts`, `src/**/*.test.ts`) or a plain substring
    like `"invite"` (automatically interpreted as `*invite*`)
  - `path` – directory to search within, default sandbox root
  - `caseSensitive` – default `false`
  - Example: `find_files({ pattern: "invite-member-command" })` finds the file
    regardless of where in the tree it lives, without you needing to guess
    the directory structure or go via a content search.

### Outline mode for `read_file`

By default `read_file` does **not** return the entire file content for certain
file types — instead a compact outline, to save context:

| File type | Default output |
|---|---|
| `.md` / `.mdx` | All headings/subheadings with line numbers and indentation by level |
| `.ts` / `.tsx` / `.js` / `.jsx` | All top-level `import`/`const`/`function`/`interface`/`type`/`class`/`enum`, with signature but **no body** (real TS AST parsing, not regex) |
| `.json` / `.jsonc` | All key paths recursively, e.g. `foo`, `foo.bar`, `foo.bar.baz`, `items[0].name` |
| `.yaml` / `.yml` | Same as JSON above — all key paths recursively (parsed with `Bun.YAML`, built into Bun) |
| Other file types | The whole file, as usual |

**Coverage guarantee for TS/JS outline:** if a file contains top-level code
that isn't a known declaration type (e.g. a loose `console.log(...)`, an IIFE,
or other "stray" code directly in the file), it's marked as `other` in the
outline **and** an explicit warning is added to the response: the outline is
then NOT a complete representation of the file. Files without such stray code
get no warning — the outline list (incl. imports) then really does cover
everything at the top level of the file.

Two ways to get more:

- **`symbol: "<name/path/heading>"`** – fetch just a specific part:
  - `.md`: matches heading text (substring, case-insensitive) → the entire
    section (up to the next heading at the same or higher level)
  - `.ts`/`.js` etc.: matches a symbol name → the full source code
    **including body**
  - `.json`/`.yaml`/`.yml`: a key path (e.g. `"foo.bar.baz"` or
    `"items[0].name"`) → the value at that path
- **`full: true`** – skip the outline logic entirely, fetch the whole file
  as-is (regardless of file type).

Example flow for an agent: read `src/tools.ts` without arguments → sees a list
of all top-level symbols → then reads `read_file({ path: "src/tools.ts",
symbol: "writeFileTool" })` to get that specific function's/constant's
full source code.

Write (the only ways to change anything):

- `edit_file` – **preferred** way to change an existing file: targeted
  search-and-replace (`oldString` → `newString`) without needing to know or
  send the whole file's content. `oldString` must match exactly once
  (a safety guard against ambiguous edits), unless `replaceAll: true` is given.
- `write_file` – write/create a file with **complete** new content (the
  entire file is overwritten). Use this to create new files, or when you
  deliberately want to replace an entire file and have actually read it in
  full (`full: true`) first.

There is **no** tool for deleting files, running shell commands, moving
files, etc. If you want to extend the server with more write operations, add
them explicitly in `src/tools.ts` and think through the consequences — keep
the write surface as narrow as possible.

### Why both `edit_file` and `write_file`?

Outline mode (above) is excellent for **reading/understanding** code
efficiently, but it's a partial view of the file. Since `write_file`
overwrites the ENTIRE file, a write based solely on a partial read would risk
losing code the agent never saw (imports it didn't read, comments, stray
code, exact formatting, etc.).

`edit_file` solves this: it only requires the exact piece being changed
(`oldString`/`newString`), never the whole file. This lets the agent make
fully targeted changes — adding an import, changing a function's body,
adding a new export — without ever needing to read or rewrite the rest of
the file it didn't care about.

Recommended flow for the agent:
1. `read_file` (outline or `symbol`) to find and understand the right spot
2. `edit_file` to make the targeted change
3. `write_file` only when creating a brand new file, or when the whole file
   is deliberately being replaced (after a `full: true` read)

## Sandbox

Everything is confined to a **root directory**. Paths that try to escape
(`../../etc/passwd`, symlinks pointing outside the root, etc.) are rejected
with an error. See `src/sandbox.ts`.

The root is determined in priority order:

1. First CLI argument: `bun run src/index.ts /path/to/project`
2. The `MCP_SANDBOX_ROOT` env var
3. Otherwise: the directory the server was started from (`cwd`)

## Running locally

```bash
bun install
bun run start /path/to/my/project
```

The server speaks MCP over stdio (standard for local MCP servers) and logs
status to stderr, so it doesn't interfere with the JSON-RPC traffic on
stdout.

## Monitoring what the agent is actually doing

When Claude Code (e.g. via the `ai` alias) starts a session, it spawns the
MCP server itself as a background process — it doesn't show up in its own
terminal, and you **can't** connect a separate client to an already-running
instance (stdio transport is a 1-to-1 connection between the process that
started the server and the server itself).

Instead, the server logs every tool call (name, arguments, result/error,
duration) to a log file. Run in a separate terminal window:

```bash
tail -f ~/.claude/mcp-local-fs.log
```

and you'll see in real time what the agent is doing — e.g.:

```
[2026-10-18T15:59:35.995Z] [call] list_dir {"path":".","recursive":false}
[2026-10-18T15:59:35.998Z] [ok]   list_dir (2ms) -> .apm/
.gitignore
...
[2026-10-18T15:59:36.010Z] [call] read_file {"path":"README.md"}
[2026-10-18T15:59:36.011Z] [ok]   read_file (1ms) -> # agentic
...
```

The log file path can be changed with the `MCP_LOG_FILE` env var. Set it to
an empty string (`MCP_LOG_FILE=""`) to disable file logging entirely (you'll
then only get stderr logging, which is only visible if you run the server
manually in a terminal).

If you want to run the server completely standalone (e.g. to test it in
isolation or point an MCP inspector at it), that works too of course:

```bash
bun run start /path/to/the/directory
```

but remember: then Claude Code can't connect to *that* instance at the same
time — Claude Code always starts its own process according to
`--mcp-config`.

## Connecting to Claude Code / Claude Desktop

Add to your MCP configuration (e.g. `~/.claude.json` or the equivalent
`mcpServers` section):

```json
{
  "mcpServers": {
    "local-fs": {
      "command": "bun",
      "args": [
        "run",
        "/Users/erihan/dev/c20s/agentic/apps/local-mcp-server/src/index.ts",
        "/Users/erihan/dev/my-project"
      ]
    }
  }
}
```

Replace the last argument with the directory you want the agent to have
access to in that particular session. Start a new session per project/root
if you want to keep the sandboxes strictly separate.

If you start a session with **only** this MCP enabled (i.e. no other
filesystem/shell tools allowed in that client), this is the agent's only way
in/out to your disk, exactly as intended.

### Strict, locked-down session via the `claude` CLI

To truly enforce "only this MCP, nothing else" it's **not enough** to use
`--bare` + `--strict-mcp-config` alone — they only control which *MCP
servers* are loaded. Claude Code still has its built-in tools (`Bash`,
`Edit`, `Read`, `Write`, `Glob`, `Grep`, etc.) by default. They must be
blocked explicitly with `--disallowedTools`.

1. Create **one single, global** MCP config file, e.g. `~/.claude/mcp-local-fs.json`
   — **without** a `cwd` field:

   ```json
   {
     "mcpServers": {
       "local-fs": {
         "command": "bun",
         "args": [
           "run",
           "/Users/erihan/dev/c20s/agentic/apps/local-mcp-server/src/index.ts"
         ]
       }
     }
   }
   ```

   (The template is also available as `mcp.config.example.json` in this repo.)

   No `cwd` is needed since the server falls back to `process.cwd()` — and
   Claude Code starts the MCP server with the same working directory that
   `claude` itself was run from. That means **the same global config works
   for every project**: the sandbox root automatically becomes whichever
   directory you're in when you run the command (verified: running from
   directory A vs. directory B with the identical config gave isolated
   access to each respective directory, and `../` attempts to read out of
   the sandbox were blocked).

   The priority order for the sandbox root in the server is still: CLI arg →
   `MCP_SANDBOX_ROOT` env → the `cwd` it was started with — so you can still
   override it per project if you ever want to, but it's not needed for the
   normal case.

2. Run with the following combination (verified to work):

   ```bash
   claude --bare \
     --settings ~/.claude/settings.json \
     --setting-sources project \
     --mcp-config ~/.claude/mcp-local-fs.json \
     --strict-mcp-config \
     --disable-slash-commands \
     --disallowedTools "Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit"
   ```

   What each flag does here:

   - `--bare` – minimal mode, skips e.g. auto-discovery of
     `.mcp.json`/CLAUDE.md (but respects `--mcp-config`/`--settings` since
     they're given explicitly).
   - `--settings ~/.claude/settings.json` – your usual settings
     (auth via `apiKeyHelper`, permissions, etc.) since `--bare` never
     reads OAuth/keychain.
   - `--setting-sources project` – only read the project's `settings.json`
     in addition to the `--settings` file, not user/local.
   - `--mcp-config ~/.claude/mcp-local-fs.json` – **must** be given
     explicitly; without it `--strict-mcp-config` allows zero MCP servers
     at all.
   - `--strict-mcp-config` – ignore all other MCP sources, only use
     what's in `--mcp-config`.
   - `--disable-slash-commands` – no slash commands.
   - `--disallowedTools "Bash,Edit,Read,Write,..."` – **this is critical**:
     blocks Claude Code's built-in filesystem/shell tools so that
     `mcp__local-fs__*` becomes the only remaining path to disk.

   In practice: put the whole command in a shell alias, e.g. in `~/.zshrc`:

   ```bash
   alias ai='claude --bare --settings ~/.claude/settings.json --setting-sources project --mcp-config ~/.claude/mcp-local-fs.json --strict-mcp-config --disable-slash-commands --disallowedTools "Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit"'
   ```

   Then just run `ai` from whichever project root directory you want to
   give the agent access to — no project-specific configuration needed.

3. Verify in a session that it worked correctly:

   ```bash
   ai -p "What tools do you have access to? List them all."
   ```

   Expected answer: only `mcp__local-fs__list_dir`, `read_file`, `file_stat`,
   `search_files`, `find_files`, `edit_file` and `write_file`.

   **Important to remember:** a normal, unrestricted `claude` session
   (without `--bare`/`--disallowedTools`) still has full `Bash`/`Edit`/`Read`/
   `Write` tools as usual — it's only the `ai` alias (or the equivalent
   explicit flags) that gives the locked-down, MCP-only experience. If you
   see e.g. `git ls-files` run via `Bash` in a session, that means that
   session was started without these flags, not that the lockdown leaked.

## Limitations / deliberate choices

- Max file size for `read_file`: 1 MB (guard against accidentally
  swallowing huge files/binaries into context).
- `list_dir`/`search_files` ignore noise like `node_modules`, `.git`, `dist`,
  etc.
- `write_file` overwrites the entire file (no patch/diff logic) — simplest
  to reason about and review; use `edit_file` for targeted changes instead.
- No destructive tools (delete, move, exec) exist by design.
- `search_files` requires `ripgrep` (`rg`) installed on the system and on
  `PATH`. The server runs `rg` as a subprocess (`Bun.spawn`) with `--json`
  for robust result parsing. The path (`path` argument) is validated and
  locked to the sandbox *before* `rg` is invoked, so traversal attempts via
  that argument are stopped by our own sandbox layer, not by ripgrep.
