# Plan: push messages into an idle Claude Code session from `local-mcp-server`

## 1. Investigation summary (`code.claude.com/docs/en/channels` + `channels-reference`)

**What a "channel" is.** A channel is a normal MCP server that additionally declares the
experimental capability `claude/channel`. When a server declares that capability *and* the
user starts Claude Code with `--channels <ref>` (or `--dangerously-load-development-channels
<ref>` during the research preview), Claude Code registers it as an event source for the
running session. The server can then call `mcp.notification()` at any time — including while
the human is away and the session is sitting idle — and the payload is injected into the
conversation as a `<channel>` tag, which Claude reads and reacts to on its next turn.

Key facts that shape the design:

- **Capability flag.** `capabilities.experimental["claude/channel"] = {}` in the `Server`/`McpServer`
  constructor is what makes a server eligible to be a channel. Nothing else distinguishes a
  channel server from any other MCP server at the protocol level.
- **Opt-in per session, not per server.** Being listed in `.mcp.json` is *not* enough — the user
  (or the client that launches `claude`) must also pass `--channels server:<name>` (for a bare
  `.mcp.json` entry) or `--channels plugin:<name>@<marketplace>` (for a packaged plugin). During
  the research preview, a server that isn't on the Anthropic-maintained allowlist needs the
  `--dangerously-load-development-channels` flag instead, plus a one-time confirmation dialog.
- **Delivery, not RPC.** `mcp.notification({ method: "notifications/claude/channel", params: { content, meta } })`
  is fire-and-forget. It resolves once written to the stdio transport, not once Claude has
  processed it. There's no ack, no error if channels are disabled/blocked — messages are just
  dropped silently. If delivery confirmation matters, the server must expose a reply/status tool
  and have Claude call it back.
- **One-way vs two-way.**
  - One-way (alerts, CI, monitoring): omit `capabilities.tools`. Claude reads and acts, nothing
    sent back over the channel.
  - Two-way (chat bridge): add `capabilities.tools = {}` and register an MCP tool (e.g. `reply`)
    that Claude calls to send a response back out through whatever transport the channel owns
    (HTTP POST, SSE, a bot API, AppleScript, etc).
- **`instructions` string matters.** It's delivered to Claude as context the moment the channel
  connects, and is the only place to explain the `<channel>` tag's attributes and which tool/arg
  to use to reply (e.g. "pass back `chat_id`").
- **`meta` → tag attributes.** Each `meta` key becomes an attribute on the `<channel …>` tag.
  Keys must be identifier-safe (letters/digits/underscore); anything else is silently dropped.
  `source` is set automatically from the server's registered name.
- **Idle-session semantics.** "Events only arrive while the session is open" — a channel doesn't
  wake up a terminated process. For an always-on mailbox, Claude Code itself must keep running
  (background process / persistent terminal / tmux pane / detached `claude -p` loop, etc.), and
  the channel MCP server is spawned as a stdio subprocess of that running `claude` process.
  While Claude is idle (not actively responding), queued channel notifications are simply held
  and delivered together on the next turn; if several arrive while Claude is busy, they're
  batched and handled as a group on the next turn.
- **Security.** Any channel that listens on a network-reachable interface is a prompt-injection
  vector. The docs mandate gating inbound messages against a sender allowlist *before* calling
  `mcp.notification()`, and gating on sender identity, not room/chat identity. Binding to
  `127.0.0.1` only protects against remote network access, not against anything with local shell
  access, so an allowlist/shared-secret is still needed for any HTTP-triggered channel.
  Permission prompts can also be relayed over the channel (`claude/channel/permission` capability)
  so a human can approve/deny tool calls remotely instead of the session stalling.
- **Enterprise/org gating.** `channelsEnabled` must be true (org admin setting) and, if set,
  the server's plugin must be in `allowedChannelPlugins`. For a personal/dev server launched via
  `--dangerously-load-development-channels`, this mostly matters for Team/Enterprise accounts —
  irrelevant for a local personal setup but worth flagging in docs/README.
- **Runtime requirement.** Channel delivery requires the *v1* MCP client runtime handshake. A
  stdio server that negotiates protocol revision `2026-07-28` (the newest) won't be registered as
  a channel; set `MCP_PROTOCOL_NEGOTIATION=legacy` or otherwise avoid negotiating that revision
  if using the newest SDK triggers it.

## 2. Mapping onto this repo

`apps/local-mcp-server` is already a long-lived stdio MCP server (`local-fs-mcp`) built with the
high-level `McpServer` SDK wrapper, spawned by Claude Code and kept alive for the life of the
session (`src/index.ts`). It already has: a `logger`, a `Sandbox` for file ops, a `tools.ts`
registry pattern, and a graceful-shutdown handler. This is a natural place to add channel support
rather than standing up a brand-new server, since:

- It's already a persistent process per session (satisfies "events only arrive while the session
  is open").
- It already owns stdio to Claude Code — channels are just an additional MCP capability + an
  additional inbound transport (HTTP, file watch, etc.) feeding `mcp.notification()`.
- Tool-registration conventions (`ToolDefinition`, `allTools`, zod schemas) can be reused for the
  reply tool.

However, `McpServer` (the high-level wrapper) doesn't expose the capability object or the raw
`notification()`/`setRequestHandler` surface directly in the same way the low-level `Server`
class does in the docs' examples. Need to verify during implementation whether `McpServer`
exposes `.server.notification(...)` (it wraps a low-level `Server` internally) — if so we can
keep using `McpServer.registerTool` for the reply tool and drop to `server.server.notification()`
for sending events. This needs a quick SDK check (see Phase 0).

## 3. Goals / non-goals

**Goal:** From any process on the local machine (a script, a CI job, another terminal, a cron
job, a webhook from a hosted service tunneled locally, etc.) be able to push an arbitrary message
into a *currently running but idle* Claude Code session via this MCP server, and optionally have
Claude reply back to the sender.

**Non-goals (for v1):**
- Building a new chat-platform integration (Telegram/Discord/iMessage already exist as official
  plugins — reuse those if the goal is literally "message Claude from my phone").
- Multi-session fan-out/routing (each Claude Code session gets its own subprocess instance of this
  server, so a message is inherently scoped to one session unless we build a dispatcher — out of
  scope initially).
- Permission relay (approving tool-use prompts remotely) — note it as a fast-follow, not v1.

## 4. Proposed design

Add a new local, loopback-only HTTP endpoint + a `notify`-style inbound mechanism to
`local-mcp-server`, exposed as a channel, plus a small CLI/script to push messages into it from
other processes.

### 4.1 Transport for inbound events

Two inbound options, pick based on desired ergonomics — plan supports starting with (a):

- **(a) Loopback HTTP server** (mirrors the docs' webhook example almost exactly): `Bun.serve()`
  on `127.0.0.1:<port>`, `POST /notify` with JSON body `{ text, meta?, replyTo? }`. Simple to
  call from anywhere: `curl`, scripts, other MCP tools, CI steps, launchd/cron jobs.
- **(b) Local Unix domain socket / file-based mailbox** (e.g. append a line to
  `~/.claude/channels/local-fs/inbox.jsonl` and watch it with `fs.watch`): avoids opening any
  network port at all, slightly more friction to call from scripts (needs a tiny helper), but
  marginally more secure-by-default than binding a TCP port, even loopback-only.

Recommendation: implement (a) first (matches the documented pattern exactly, trivially testable
with `curl`, cross-platform), and note (b) as an optional hardening alternative/addition.

### 4.2 Server changes (`apps/local-mcp-server`)

1. **New module `src/channel.ts`**
   - Exports a `registerChannel(server: McpServer, opts)` function that:
     - Confirms/sets `capabilities.experimental["claude/channel"] = {}` (and `tools: {}` since
       this will be two-way) — likely requires passing these capabilities into the `McpServer`
       constructor in `index.ts` rather than mutating after construction; confirm exact SDK shape
       in Phase 0.
     - Sets `instructions` describing the `<channel source="local-fs" reply_id="...">` tag shape
       and telling Claude to use the new `reply` tool, passing back `reply_id`.
     - Starts the loopback HTTP listener (`Bun.serve`) on a configurable port
       (`MCP_CHANNEL_PORT`, default e.g. `8799`, chosen to not collide with the docs' `8788`
       example/fakechat's `8787`).
     - On `POST /notify`, validates a shared secret (see 4.4), assigns a `reply_id`
       (`crypto.randomUUID()`), stores a pending-reply record in an in-memory `Map` (and/or logs
       it), and calls `server.server.notification(...)` (or equivalent) with
       `content = text`, `meta = { reply_id, source: meta?.source ?? "local" }`.
     - Optionally exposes `GET /health` for liveness checks from the calling script.
   - Keep it isolated from `tools.ts`'s pure file-sandbox tools; channel wiring is
     session/transport plumbing, not a sandboxed filesystem operation.

2. **New tool: `channel_reply`** (registered like the existing tools, in a new `src/channel-tools.ts`
   or alongside `channel.ts`)
   - Input schema: `{ reply_id: string, text: string }`.
   - Handler: looks up `reply_id` in the pending-reply map; if present, resolves/delivers the
     reply (e.g. writes it to a response file, replies over the original HTTP connection if kept
     open, or appends to a `~/.claude/channels/local-fs/outbox.log` the caller can tail/poll),
     then clears the pending entry. Returns `"sent"` or an error if the `reply_id` is unknown
     (expired/already replied).
   - Decide the reply-delivery mechanism concretely in Phase 2 — two sub-options:
     - **Hold the HTTP request open** until the reply tool is called (simplest mental model: the
       original `curl -X POST .../notify` blocks and prints Claude's reply when done; matches a
       synchronous "ask Claude something, get an answer" CLI UX). Needs a timeout (e.g. 5 min) to
       avoid hanging forever if Claude never replies.
     - **Decouple notify/reply**: `/notify` returns `{ reply_id }` immediately; a separate
       `GET /reply/:reply_id` (long-poll or simple retry) or an SSE `/events` stream (as in the
       docs' full example) delivers the reply asynchronously. More flexible, slightly more
       moving parts.
   - Recommendation: start with the blocking-HTTP-request model for v1 (simplest for "send a
     message, get a reply" scripting use case), add the SSE/polling variant later if needed for
     fire-and-forget senders.

3. **`index.ts` wiring**
   - Import and call `registerChannel(server, { sandboxRoot: sandbox.root })` after tool
     registration, before `server.connect(transport)`.
   - Reuse `logger` for channel-specific log lines (`logger.info("channel: listening on 127.0.0.1:8799")`,
     inbound/outbound summaries) so existing `tail -f ... | grep <session>` workflows keep working.
   - Extend the graceful `shutdown()` handler to also close the channel's `Bun.serve()` instance.

4. **Config surface**
   - `MCP_CHANNEL_ENABLED` (default off) — explicit opt-in so existing users don't suddenly open
     a port.
   - `MCP_CHANNEL_PORT` (default `8799`).
   - `MCP_CHANNEL_SECRET` — required when enabled; requests without a matching
     `Authorization: Bearer <secret>` (or `X-Channel-Secret` header) are rejected. Generate and
     persist a default under `~/.claude/channels/local-fs/.env` the first time it's enabled,
     mirroring how the Telegram/Discord plugins persist tokens, and print the generated secret
     once on first run.

### 4.3 Client-side helper for sending messages

Add a tiny standalone script, `apps/local-mcp-server/scripts/notify.ts` (or a `bin` entry,
`local-mcp-notify`), that:

```
bun run scripts/notify.ts "build failed on main" --reply       # blocks, prints reply
bun run scripts/notify.ts "fyi: deploy finished" --no-reply     # fire and forget
```

It reads the port/secret from the same `~/.claude/channels/local-fs/.env` file the server writes,
POSTs to `/notify`, and either exits immediately or prints the reply body once received. This is
what CI jobs / cron jobs / other tools in the monorepo would actually shell out to.

### 4.4 Security

- Bind strictly to `127.0.0.1` (never `0.0.0.0`).
- Require a shared-secret header on every request (defense in depth even though loopback-only —
  any local process/user on a shared machine could otherwise hit the port).
- Treat `content`/`text` as untrusted input in the `instructions` string: explicitly tell Claude
  it is external, potentially untrusted text, same caution as the docs give for prompt injection
  via ungated channels, even though our gate is a shared secret rather than a sender allowlist.
- Log inbound/outbound at the summary level but avoid writing secrets to logs.
- Do not implement permission-relay in v1 — keep `claude/channel/permission` unset/`false`, so
  tool-approval prompts still require the human at the actual terminal. Document this explicitly
  so nobody assumes remote messages can silently approve dangerous tool calls.

### 4.5 Running an "always idle but reachable" session

Document (README) that pushing messages only works while a `claude` process for that session is
alive:
- Run `claude --channels server:local-fs` (once this server is confirmed/allow-listed, or
  `--dangerously-load-development-channels server:local-fs` during the research-preview /
  personal-dev phase) inside a long-lived terminal, `tmux`/`screen` session, or background
  process, rather than a one-shot interactive session that exits when you close the terminal.
- Session must have accepted the one-time "new MCP server" consent prompt and the
  dev-channels warning dialog at least once interactively before it can be fully unattended.
- For fully unattended operation (no one around to approve tool-use prompts triggered by a
  pushed message), combine with `--dangerously-skip-permissions`, with the explicit caveat from
  the docs that this bypasses most but not all safety prompts, and only do this in a trusted
  environment/sandbox.

## 5. Phased implementation plan

**Phase 0 — SDK spike (0.5 day)**
- Confirm how `@modelcontextprotocol/sdk` version `1.32.1`'s `McpServer` exposes: (a) a way to
  set `capabilities.experimental` at construction, (b) a way to call
  `notifications/claude/channel` (likely via the underlying low-level `Server`, e.g.
  `mcpServer.server.notification(...)`), and (c) whether registering a capability post-construction
  is possible or must happen in the constructor. Write a 10-line throwaway script to prove this
  works end to end with a manual `claude --dangerously-load-development-channels server:local-fs`
  test and a `curl` POST, before touching the real tool registry.
- Confirm whether the installed SDK/negotiated protocol revision triggers the `2026-07-28`
  incompatibility called out in the docs; set `MCP_PROTOCOL_NEGOTIATION=legacy` if needed and
  document it.

**Phase 1 — One-way channel (0.5–1 day)**
- Add `MCP_CHANNEL_ENABLED`/`MCP_CHANNEL_PORT`/`MCP_CHANNEL_SECRET` config and the loopback
  `Bun.serve()` listener in `src/channel.ts`.
- Wire `capabilities.experimental["claude/channel"]` + `instructions` into the `McpServer`
  construction in `index.ts`.
- `POST /notify` → `mcp.notification()`, one-way only (no reply tool yet).
- Manual test: `claude --dangerously-load-development-channels server:local-fs`, idle the
  session, `curl -X POST localhost:8799/notify -H "Authorization: Bearer $SECRET" -d '{"text":"ping"}'`,
  confirm Claude reacts on the next turn.
- Update `README.md` / `mcp.config.example.json` with the new env vars and an example invocation.

**Phase 2 — Two-way reply tool (0.5–1 day)**
- Add `capabilities.tools`, the `channel_reply` tool, and the pending-reply map with the
  blocking-HTTP-request model described in 4.2.
- Add a timeout + cleanup for abandoned pending replies.
- Add `scripts/notify.ts` client helper and a `package.json` script/`bin` entry for it.

**Phase 3 — Hardening & polish (0.5 day)**
- Secret persistence under `~/.claude/channels/local-fs/.env`, generated on first enable.
- Graceful shutdown closes the HTTP listener.
- Structured logging for inbound/outbound channel traffic via the existing `logger`.
- README section: "Messaging an idle session" with the end-to-end example (enable flag, env
  vars, `claude --channels …` invocation, `notify.ts` usage, security caveats, and the
  `--dangerously-skip-permissions` unattended-mode caveat).

**Phase 4 — Optional fast-follows (not v1)**
- SSE-based async reply / fire-and-forget mode as an alternative to blocking HTTP.
- Permission-relay support (`claude/channel/permission`) so a remote sender can approve/deny
  tool-use prompts, gated by the same shared secret/allowlist.
- Package as an installable plugin (plugin.json + marketplace entry) if this needs to be shared
  beyond this monorepo, per "Package as a plugin" in the reference docs.

## 6. Open questions to resolve during Phase 0

1. Does `McpServer` (high-level SDK) allow injecting `capabilities.experimental` at construction
   time, or do we need to drop to the low-level `Server` class directly (as every example in the
   docs does) and re-implement tool registration ourselves instead of using `registerTool`?
2. Is `notifications/claude/channel` reachable through `McpServer`'s public surface
   (`server.server.notification(...)`) or do we need a reference to the raw `Server` instance?
3. Does this repo's pinned SDK version (`1.32.1`) negotiate protocol revision `2026-07-28` by
   default over stdio, which per the docs would prevent channel registration entirely? If so,
   `MCP_PROTOCOL_NEGOTIATION=legacy` (set where `claude` itself is launched, not in the server)
   is required — needs to be documented prominently since it's easy to miss.
4. Confirm current CLI flag name/availability (`--channels` / `--dangerously-load-development-channels`)
   on the Claude Code version actually installed, since both flags are explicitly undocumented in
   `--help` during the research preview and syntax may shift.
