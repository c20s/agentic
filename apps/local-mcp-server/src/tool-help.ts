/**
 * Long-form tool documentation, kept OUT of the tool schemas sent to the model on every turn.
 *
 * Why this file exists:
 * MCP sends every registered tool's `description` + `inputSchema` to the model on every single
 * request, for the lifetime of the session. Strategic/workflow guidance (e.g. "call web_fetch like
 * this, then that, unless X") is only actually useful right before the agent's first (or first
 * tricky) call to a given tool — not on every turn. Keeping it inline in `description` means every
 * turn pays the full token cost for guidance that's irrelevant 95% of the time.
 *
 * Instead: tool descriptions in tools.ts/web.ts are kept to one dense, plain-English line (just
 * enough to pick the right tool and call it with roughly valid args). The full guidance — edge
 * cases, multi-step workflows, "why" behind a constraint — lives here and is fetched on demand via
 * the `tool_help` tool, registered in tools.ts alongside the others.
 *
 * Keep entries here as close to verbatim as possible to the original inline descriptions they
 * replaced, so no information is lost — only *when* it's paid for changes.
 */
export const TOOL_GUIDE: Record<string, string> = {
  read_file:
    "Default (no 'full' or 'symbol' given): returns a compact OUTLINE instead of the whole file: " +
    "for .md all headings/subheadings with line numbers, " +
    "for .ts/.tsx/.js/.jsx all top-level const/function/interface/type/class/enum signatures without body, " +
    "for .json/.yaml/.yml all key paths recursively (e.g. foo.bar.baz, foo.bar, foo). " +
    "Other file types are returned in full as usual.\n\n" +
    "Pass 'symbol' to fetch one specific part instead of the whole outline — in all cases 'symbol' is the " +
    "plain text of the part you want, never including any leading '#'s or other outline markup: " +
    "for .md a heading section (matched against heading text only, no leading '#'s, substring/case-insensitive), " +
    "for .ts/.tsx/.js/.jsx a symbol name (function/const/interface/type/class/enum, full source code incl. body; " +
    "for imports you can match on the module path, a substring of it, or an imported name, e.g. 'create' or 'member.create'), " +
    "for .json/.yaml/.yml a key path (e.g. 'foo.bar.baz' or 'items[0].name').\n\n" +
    "Pass 'full: true' to get the entire file content as-is, without outline shortening. USE SPARINGLY: " +
    "read without 'full' first (you get an outline), then fetch specific parts with 'symbol'. For files " +
    "larger than ~4KB of an outlineable type (.md/.ts/.json/.yaml), 'reason' is also required together with " +
    "full:true — a short justification for why you need the entire file instead of outline/symbol " +
    "(e.g. 'need to see the whole file context for a large refactor').\n\n" +
    "Recommended order: read_file(path) for the outline -> read_file(path, symbol:'...') for the part you " +
    "actually need -> read_file(path, full:true, reason:'...') only if you truly need the whole file.",

  edit_file:
    "Make a TARGETED change to an existing file via search-and-replace (oldString -> newString), without " +
    "needing to know or send the whole file's content. This is the PREFERRED way to change an existing file " +
    "— use this instead of write_file when you're only adding/changing/removing a bounded part " +
    "(e.g. adding an import, changing a function's body, adding a new export).\n\n" +
    "oldString must match exactly once in the file (unless replaceAll:true is used) — this is a safety guard " +
    "so an edit never hits the wrong place or accidentally overwrites something you haven't seen. If the " +
    "match count is 0: your oldString doesn't match the file's exact current text (whitespace/indentation " +
    "included) — re-read the file or symbol to get the exact text. If the match count is >1 and you didn't " +
    "pass replaceAll: make oldString more specific by including more surrounding context, or pass " +
    "replaceAll:true if you deliberately want every occurrence replaced.\n\n" +
    "If you're unsure of the exact current text: read the file (or the relevant symbol/section) with " +
    "read_file first.",

  write_file:
    "Write (create or overwrite) a file within the sandbox with the ENTIRE file content at once. " +
    "WARNING: this replaces the full content of the file — if you only want to change part of an existing " +
    "file (e.g. a function, a line, adding an import), use edit_file instead, which makes a targeted change " +
    "without you needing to know or send the whole file's content.\n\n" +
    "Use write_file to CREATE a new file, or when you deliberately want to replace a file's full content and " +
    "you have actually read the whole file (full:true) first — never overwrite a file you haven't fully read, " +
    "you will likely destroy content you didn't know was there.",

  delete_file:
    "Delete a file or directory within the sandbox. This is NOT a permanent delete: under the hood it's " +
    "implemented as a move of the target into a trash folder under the user's HOME directory — " +
    "'~/.trash/c20s/<sessionId>/<timestamp>/<relative path>' — deliberately OUTSIDE the sandbox/project " +
    "entirely, where <sessionId> is this server session's id, <timestamp> is the moment delete_file was " +
    "called, and <relative path> is the original path of the deleted file/directory relative to the sandbox " +
    "root (preserved in full, not just its name). Every call gets its own timestamped folder, so repeated " +
    "deletes never collide/overwrite each other, and everything removed together in one call ends up " +
    "together.\n\n" +
    "Because it's a move rather than a real delete, anything removed this way can still be found and " +
    "restored by hand afterwards from '~/.trash/c20s/...'. The sandbox root itself cannot be deleted. There " +
    "is no automatic cleanup of '~/.trash' — it accumulates across sessions/projects until removed manually.",

  find_files:
    "Find files based on FILE NAME/PATH (not content) within the sandbox, using ripgrep --files. Use this " +
    "when you know (or are guessing) a file's name but not where it lives — e.g. " +
    "find_files({ pattern: '*invite*' }) to find all files with 'invite' in the name.\n\n" +
    "If the pattern doesn't contain any of the characters * ? [ ] it's treated as a substring match against " +
    "the full relative path (so 'invite' behaves like '*invite*').\n\n" +
    "Complements search_files (which searches file CONTENT, not names) and list_dir (which requires you to " +
    "already know roughly where to look).",

  search_files:
    "Search for text or regex in file CONTENT within the sandbox, using ripgrep. Good for finding where " +
    "something is defined or used.\n\n" +
    "NOTE: this searches file content, not file names — if you're looking for a file based on its name/path " +
    "(e.g. 'where is invite-member-command.ts?'), use find_files instead, it will be faster and more precise.",

  list_dir:
    "List files and directories within the sandbox. Use this to explore project structure when you don't yet " +
    "know specific file names to look for (once you do, find_files or search_files are usually faster than " +
    "listing recursively).",

  file_stat:
    "Get metadata (size, type, last modified) for a file or directory. Useful before read_file(full:true) on " +
    "a file you suspect might be huge, or to check a file exists without reading its content.",

  web_fetch:
    "Fetch a single URL over http(s). Read-only, GET only (no cookies/auth/state). HTML pages are converted " +
    "to markdown-ish readable text (headings, links as [text](url)), and by default only an OUTLINE is " +
    "returned (page title + all headings with their nesting, like read_file does for local .md files) " +
    "instead of the full page — this avoids flooding context with a huge page.\n\n" +
    "Recommended order, cheapest first:\n" +
    "(1) web_fetch({url}) first, to see the outline (headings only) without spending context on the full page.\n" +
    "(2) web_fetch({url, section: \"...\"}) to read the one or two sections that look relevant, in markdown.\n" +
    "(3) only if you specifically need exact, unconverted markup (e.g. a table's real structure, " +
    "tab/accordion boundaries, an element's attributes, or markdown conversion looks like it dropped/garbled " +
    "something) add 'raw: true' — optionally still combined with 'section' to keep it scoped to one part " +
    "instead of the whole raw page.\n" +
    "Avoid reaching for 'raw: true' or 'full: true' by default: they cost more context and, for 'raw', lose " +
    "the readable formatting most tasks don't need.\n\n" +
    "Single-page apps (React/Vue/Angular etc.) that render content with client-side JavaScript are handled " +
    "automatically: by default ('render: \"auto\"') a plain static fetch is tried first, and if the result " +
    "looks like an empty, unrendered SPA shell, a headless Chromium browser renders the page and the real, " +
    "post-JavaScript content is returned instead. Use 'render: \"always\"' to force a browser render, or " +
    "'render: \"never\"' to disable it — rendering is slower so 'auto' only pays that cost when it looks " +
    "necessary.\n\n" +
    "Requests to localhost/private/link-local addresses are blocked. Responses are capped in size (~1MB " +
    "fetched, ~50000 chars returned) and time out after 15000ms.",

  web_search:
    "Search the web for a query and return a list of results (title, URL, snippet). Backed by DuckDuckGo's " +
    "HTML results page, so no API key is required. Use web_fetch afterwards to read the full content of a " +
    "specific result URL — prefer web_fetch's default outline mode first rather than 'raw' or 'full'.",

  tool_help:
    "Returns this same kind of long-form guidance for any other tool by name. You're reading the output of " +
    "it right now.",
};

export function getToolHelp(name: string): string {
  const guide = TOOL_GUIDE[name];
  if (guide) return guide;
  const known = Object.keys(TOOL_GUIDE).sort().join(", ");
  return `No extended help for "${name}" — its one-line description is all there is. Known tools: ${known}.`;
}
