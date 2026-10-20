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
- `web_fetch` – fetch a single http(s) URL (GET only, no cookies/auth/state).
  HTML is converted to markdown-ish readable text and, like `read_file`, an
  **outline** (title + headings) is returned by default instead of the whole
  page — see "Outline mode for `web_fetch`" below. Single-page apps are
  handled by optionally rendering the page with a real headless browser
  first — see "Rendering single-page apps (`render`)" below.
- `web_search` – search the web (backed by DuckDuckGo's no-JS HTML results
  page, so no API key is needed) and return a list of `{ title, url,
  snippet }` results. Pair with `web_fetch` to read a specific result.

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

### Outline mode for `web_fetch`

Same philosophy as `read_file`'s outline mode, applied to web pages: a full
HTML page converted to text can easily be tens of thousands of characters,
which is wasteful if the agent only needs one section of it (e.g. one entry
in a changelog, one section of a docs page).

`web_fetch` converts HTML into a lightweight markdown representation first
(headings become `#`/`##`/etc., links become `[text](url)`, resolved to
absolute URLs) and then reuses the exact same heading-outline/section logic
from `src/outline.ts` as `read_file` uses for local `.md` files:

- **Default** (no `full`/`section`): if the converted page is larger than a
  small threshold (~4,000 chars) and has at least one heading, only the page
  title + outline of headings is returned (with line-number-free indentation
  by level, since "line numbers" aren't meaningful for a fetched page).
  Smaller pages, or pages with no headings at all, are returned in full
  directly since there's nothing meaningful to outline.
- **`section: "<heading text>"`** – like `read_file`'s `symbol`: matches a
  heading by substring (case-insensitive) and returns that heading's full
  content through the next heading of equal-or-higher level.
- **`full: true`** – skip outline mode, return the entire converted page
  (still subject to the overall size cap below).
- **`raw: true`** – bypass HTML→markdown conversion, outline mode, and SPA
  rendering entirely; returns the response body as-is. Useful for JSON APIs,
  plain text endpoints, or whenever you need the exact markup (e.g. table
  structure, tab/accordion markers, element attributes) that gets flattened
  or lost by the markdown conversion. Takes precedence over `full` and
  `render`.

  `section` still works together with `raw: true` for HTML pages: instead of
  matching against the markdown outline, it scans the raw HTML directly for
  `<h1>`-`<h6>` tags, matches one by its visible text (substring,
  case-insensitive), and returns the raw HTML from that heading's opening tag
  through the next heading of equal-or-higher level (or the end of the
  document). This gives you the unmodified markup for just one section
  instead of the whole page, without ever going through the markdown
  conversion. If no heading matches, or the page has no headings at all, the
  call fails with an error explaining why (same shape as the markdown
  `section` not-found error).

Typical flow: `web_fetch({ url })` → see the outline → `web_fetch({ url,
section: "Installation" })` to read just that part → `web_fetch({ url,
section: "Installation", raw: true })` if you need the exact HTML for that
part instead of the markdown version.

### Rendering single-page apps (`render`) for `web_fetch`

A plain `fetch()` only gets you the server-sent HTML — for a client-rendered
SPA (React/Vue/Angular/Svelte/etc.) that's often just an empty shell like
`<div id="root"></div>` plus a pile of `<script>` tags, with none of the
actual content. `web_fetch` can drive a real headless browser
([Playwright](https://playwright.dev), via the `playwright-core` package) to
execute the page's JavaScript first and then read the fully rendered DOM.

- **`render: "auto"`** (default) – fetch statically first (fast, no browser
  needed for the ~90% of the web that's plain server-rendered HTML). The
  result is checked against a few heuristics for "this looks like an
  unrendered SPA shell":
  - a `<noscript>` block that says JavaScript is required
  - a near-empty known SPA mount point (`#root`, `#app`, `#__next`,
    `#___gatsby`, etc.)
  - a page that's mostly `<script>` tags with almost no visible text
  
  If any of those match, `web_fetch` transparently re-fetches the page with
  headless Chromium and returns the rendered content instead — you don't
  need to know up front whether a given URL is a SPA.
- **`render: "always"`** – skip the heuristics and always render with a
  headless browser. Useful if you know a site is a SPA, or if `auto`'s
  heuristics happened to miss a particular page.
- **`render: "never"`** – never render, even if the page looks like an
  unrendered SPA shell. Fastest/lightest option when you specifically want
  the raw server response (e.g. to inspect what a non-JS client/crawler
  would see).

The rendered page goes through the exact same outline/`section`/`full`
pipeline as a statically fetched one — from the caller's point of view,
rendering is an implementation detail, not a different response shape. The
response header gets an extra `rendered: js` tag when a browser render was
used, so it's visible at a glance which path was taken, e.g.:

```
[https://example.com/app — HTTP 200, content-type: text/html, rendered: js]
```

**Setup**: `playwright-core` is an **optional** dependency (see
`package.json`) so installing/running the rest of the server never requires
it. To actually use rendering:

```bash
cd apps/local-mcp-server
bun install                       # installs playwright-core itself
bunx playwright install chromium  # downloads a Chromium binary (one-time, ~150-300MB)
```

If `playwright-core` isn't installed, or no Chromium binary is available,
`render: "auto"` degrades gracefully: it still returns the static HTML it
already fetched, with a note appended explaining that rendering was
attempted and failed (and why). `render: "always"` instead surfaces that
failure as an error, since rendering was explicitly requested.

A single headless Chromium instance is launched lazily on first use and
reused for the life of the server process (not relaunched per request), and
closed automatically on server shutdown (`SIGINT`/`SIGTERM`). Rendering is
treated as executing fully untrusted, potentially hostile code, with several
layers of hardening (see `src/browser.ts`):

- **Sandboxed launch**: Chromium's own OS sandbox is kept enabled (no
  `--no-sandbox`), plus extensions, background networking, default apps, and
  notifications are explicitly disabled at launch.
- **Per-render isolation**: every render gets a brand-new, throwaway
  `BrowserContext` — no cookies, `localStorage`/IndexedDB, cache, or
  permissions are shared across calls or between different sites. Service
  workers are blocked outright and all permission prompts (geolocation,
  notifications, camera, clipboard, etc.) are denied by default.
- **SSRF protection on every request the page makes**, not just the URL you
  asked for: the same loopback/private/link-local blocklist used for the
  initial static `fetch()` (see `src/net-guard.ts`) is re-applied to *every*
  request the rendered page itself issues — redirects, `fetch`/XHR, iframes,
  sub-resources — so a hostile page can't pivot to internal services or the
  cloud metadata endpoint from inside the renderer. The final navigated URL
  is also re-checked after the page settles.
- **No popups, downloads, or dialogs**: any extra tab/window a page tries to
  open (`window.open`, `target="_blank"`, etc.) is immediately closed,
  downloads are cancelled outright, and JS dialogs (`alert`/`confirm`/
  `prompt`/`beforeunload`) are auto-dismissed instead of being left to hang.
- **Resource limits**: image/font/media requests are blocked (faster,
  lighter rendering), rendered HTML is capped at 5 MB before it's handed back
  (on top of `web_fetch`'s own ~50,000-char response cap), concurrent
  renders are capped (default 2 in flight) to bound CPU/memory use, and a
  hard wall-clock deadline bounds the whole render independent of
  Playwright's own per-call timeouts.

The same timeout/size caps as the rest of `web_fetch` apply to rendered
pages too.

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

Optional, only needed for `web_fetch`'s SPA rendering (see "Rendering
single-page apps" below) — everything else works without this:

```bash
bunx playwright install chromium
```

## Monitoring what the agent is actually doing

When Claude Code (e.g. via the `ai` alias) starts a session, it spawns the
MCP server itself as a background process — it doesn't show up in its own
terminal, and you **can't** connect a separate client to an already-running
instance (stdio transport is a 1-to-1 connection between the process that
started the server and the server itself).

Instead, the server logs every tool call to **two** colorized, append-only
log files:

- **Summary log** (`~/.claude/mcp-local-fs.summary.log`) – one compact line
  per call: session id, tool name, a short best-effort argument summary
  (e.g. the file path for `read_file`/`write_file`/`edit_file`, the query for
  `search_files`, the pattern for `find_files`, the URL for `web_fetch`, the
  query for `web_search`), result size in bytes, duration, ok/error. Good for
  a quick, high-level overview of activity without needing the detail log.
- **Detail log** (`~/.claude/mcp-local-fs.log`) – full arguments and a
  preview of the result/error for every call. Good for debugging exactly
  what an agent read, searched for, or wrote.

The byte count in both logs is the size of the **result returned to the
client** (i.e. the tool's output), not the size of the request/arguments —
e.g. for `read_file` it's the size of the outline/symbol/full content
actually sent back, for `write_file`/`edit_file` it's the size of the
confirmation message, not the file written.

The argument summary on the summary log is deliberately short (truncated to
~110 chars, from the front for both file paths and search queries, so the
file name — or the end of a long query/pattern — stays visible rather than
being silently cut off) — it's meant to answer "what was this call roughly
about" at a glance, not to replace the detail log. For example:

```
ok    read_file          829B    17ms  command-api/packages/member-context/src/app-commands/invite-member-command.ts
ok    read_file          288B     5ms  command-api/packages/member-context/src/app-commands/invite-member-command.ts (symbol:inviteMember)
ok    search_files       360B    11ms  "logInvited"
ok    read_file         7763B     1ms  pnpm-lock.yaml (full)
ok    web_search         612B   340ms  "claude code mcp channels"
ok    web_fetch          418B   890ms  https://code.claude.com/docs/en/channels
ok    web_fetch         3102B   910ms  https://code.claude.com/docs/en/channels (section:Overview)
```

Note the `(symbol:...)` / `(full)` suffixes on `read_file` lines, and the
`(section:...)` / `(full)` / `(raw)` suffixes on `web_fetch` lines — these
make it possible to tell at a glance whether a call fetched the outline, a
specific symbol/section, or the entire file/page, which otherwise looks
identical in the summary log (same tool name, same path/URL).

Since the server runs over stdio, each Claude Code session spawns its own
server process — so "session" here means one server process instance,
identified by a short id (first 8 chars of a random UUID) generated at
startup and printed in every log line, e.g. `[1efcb748]`. Each session also
gets a stable color so interleaved sessions in the same log file are easy to
tell apart visually, not just by grepping.

Run in a separate terminal window to follow everything live:

```bash
tail -f ~/.claude/mcp-local-fs.summary.log
```

```
2026-10-18T19:49:53.389Z [1efcb748] [info] Started. Sandbox root: /Users/<user>/dev/c20s/golden-project. PID: 23405. Session: 1efcb748.
2026-10-18T19:49:53.390Z [1efcb748] [info] To follow just this session: tail -f ~/.claude/mcp-local-fs.summary.log | grep 1efcb748
2026-10-18T19:49:55.617Z [1efcb748] ok    find_files         134B    21ms
2026-10-18T19:49:57.816Z [1efcb748] ok    read_file          591B    19ms
2026-10-18T19:49:57.827Z [1efcb748] ok    read_file          829B     3ms
```

To follow **only one session** (e.g. when several `ai` sessions are running
at once and sharing the same log file), grep on the session id printed at
startup:

```bash
tail -f ~/.claude/mcp-local-fs.summary.log | grep 1efcb748
```

The same works for the detail log if you need full arguments/results for
just that session:

```bash
tail -f ~/.claude/mcp-local-fs.log | grep 1efcb748
```

Log file paths can be changed with the `MCP_LOG_FILE` (detail) and
`MCP_SUMMARY_LOG_FILE` (summary) env vars. Set either to an empty string
(e.g. `MCP_LOG_FILE=""`) to disable that file entirely — stderr still gets
both levels, which is only visible if you run the server manually in a
terminal.

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
        "/Users/<user>/path/to/agentic/apps/local-mcp-server/src/index.ts",
        "/Users/<user>/dev/my-project"
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
           "/Users/<user>/path/to/agentic/apps/local-mcp-server/src/index.ts"
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
     `mcp__local-fs__*` becomes the only remaining path to disk. `WebFetch`
     and `WebSearch` are included here too: this server provides its own
     `web_fetch`/`web_search` (see "Tools" above), so keep blocking the
     *built-in* versions even though the agent still has (sandboxed,
     logged) web access through this MCP — the point is one single,
     auditable path in/out, not zero network access.

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
   `search_files`, `find_files`, `edit_file`, `write_file`, `web_fetch` and
   `web_search`.

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
- `web_fetch`/`web_search` are **not** bound to the filesystem sandbox (there's
  no local root concept for the network), but have their own guardrails:
  GET only, no cookies/auth/redirected-state carried across requests, a
  15s timeout, a response size cap (~1MB fetched / ~50,000 chars returned to
  the model), and requests to `localhost`/loopback/private
  (`10.x`, `172.16-31.x`, `192.168.x`)/link-local (incl. the
  `169.254.169.254` cloud metadata address) hosts are rejected — including
  after following redirects — to prevent SSRF via a malicious or
  prompt-injected URL.
- `web_search` is implemented by parsing DuckDuckGo's no-JS HTML results
  page rather than calling a paid search API, so no API key/config is
  required to use it out of the box. This is a best-effort HTML scrape and
  may need updating if DuckDuckGo changes that page's markup.
- `web_fetch`'s optional headless-browser rendering (`playwright-core`) is a
  meaningfully larger attack/resource surface than a plain `fetch()` — it
  executes arbitrary third-party JavaScript. It's hardened accordingly (see
  the "Rendering single-page apps" section above for the full list): the
  OS-level Chromium sandbox stays enabled, every request the rendered page
  makes (not just the final URL) is re-checked against the SSRF blocklist,
  each render uses a fresh, fully isolated browser context (no shared
  cookies/storage/service-workers/permissions across calls), popups/
  downloads/JS dialogs are blocked or auto-dismissed, and both render
  concurrency and rendered-HTML size are capped. It's still a real browser
  engine executing untrusted JS, though, so only enable rendering (`bunx
  playwright install chromium`) if you're comfortable with that trade-off;
  `render: "never"` disables it per-call, and simply not installing
  `playwright-core` disables it server-wide.
