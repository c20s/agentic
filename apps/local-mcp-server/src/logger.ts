import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Logger for the MCP server, with two levels:
 *
 * - SUMMARY (~/.claude/mcp-local-fs.summary.log): one line per tool call,
 *   high level: session id, tool name, a short best-effort argument summary
 *   (e.g. the file path for read_file/write_file/edit_file, or the query for
 *   search_files/find_files), byte size of the RESULT returned to the client
 *   (not the request), duration, ok/error. Meant for a quick `tail -f`
 *   overview of what's happening without needing the detail log.
 * - DETAIL (~/.claude/mcp-local-fs.log): full arguments and a preview of the
 *   result/error for every call.
 *
 * Both logs are colorized (ANSI) and every line starts with the session id
 * in brackets, e.g. "[a1b2c3d4]", so you can follow a single session with:
 *
 *   tail -f ~/.claude/mcp-local-fs.summary.log | grep a1b2c3d4
 *
 * Since this server runs over stdio, each Claude Code session spawns its own
 * server process — so "session" here means "one server process instance",
 * identified by a short random id generated at startup (not the MCP
 * transport sessionId, which stdio never sets).
 *
 * Paths can be overridden with MCP_LOG_FILE (detail log) and
 * MCP_SUMMARY_LOG_FILE (summary log). Set either to "" (empty string) to
 * disable that log file entirely (stderr still gets both levels).
 */

const DEFAULT_LOG_PATH = `${homedir()}/.claude/mcp-local-fs.log`;
const DEFAULT_SUMMARY_LOG_PATH = `${homedir()}/.claude/mcp-local-fs.summary.log`;
const LOG_PATH = process.env.MCP_LOG_FILE ?? DEFAULT_LOG_PATH;
const SUMMARY_LOG_PATH = process.env.MCP_SUMMARY_LOG_FILE ?? DEFAULT_SUMMARY_LOG_PATH;

for (const path of [LOG_PATH, SUMMARY_LOG_PATH]) {
  if (!path) continue;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // if the directory can't be created we just fall back to stderr below
  }
}

// Short, stable id for this server process instance ("session"), generated
// once at startup. Used as a grep-able prefix on every log line.
export const sessionId = crypto.randomUUID().slice(0, 8);

// --- ANSI colors -------------------------------------------------------

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

function color(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

// A stable color per session id, so when multiple sessions interleave in the
// same log file (e.g. several `ai` sessions running at once), each session's
// lines are visually distinguishable at a glance, not just by grepping.
const SESSION_COLORS = [CYAN, MAGENTA, YELLOW, GREEN] as const;
function colorForSession(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return SESSION_COLORS[hash % SESSION_COLORS.length]!;
}
const sessionColor = colorForSession(sessionId);

function writeTo(path: string | undefined, line: string, plainLine: string) {
  // Always also to stderr, with color (visible e.g. if you run the server
  // manually in a terminal, or when Claude Code surfaces stderr).
  console.error(line);
  if (!path) return;
  try {
    // Log files on disk get the colored version too (ANSI codes render fine
    // with `tail -f` / `cat` in a real terminal; tools like `grep` ignore
    // them as part of the matched text, which is fine since the session id
    // itself is plain text).
    appendFileSync(path, line + "\n");
  } catch {
    // fail silently - we never want to crash the server due to logging
    void plainLine;
  }
}

function timestamp(): string {
  return color(DIM, new Date().toISOString());
}

function sessionTag(): string {
  return color(sessionColor, `[${sessionId}]`);
}

const SUMMARY_ARG_MAX_LEN = 110;

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

/**
 * Truncates a file path from the FRONT (keeping the end) when too long, so
 * the file name itself stays visible even for deeply nested paths — e.g.
 * ".../app-commands/invite-member-command.ts" rather than
 * "command-api/packages/member-context/src/app-c…". The file name is
 * almost always more useful at a glance than the leading directory segments.
 */
function truncatePathFront(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return "…" + path.slice(path.length - (maxLen - 1));
}

/**
 * Picks out the single most useful argument to show on a summary log line,
 * so you can tell at a glance *what* was read/searched/written without
 * needing the detail log — e.g. the file path for read_file/write_file/
 * edit_file, or the query for search_files/find_files.
 *
 * This is deliberately a short, best-effort summary (not the full args
 * object) to keep summary lines scannable; the detail log always has the
 * complete picture.
 */
function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "file_stat": {
      const path = typeof a.path === "string" ? a.path : "";
      const extras: string[] = [];
      if (toolName === "read_file") {
        if (a.symbol) extras.push(`symbol:${a.symbol}`);
        if (a.full) extras.push("full");
      }
      const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      // Reserve space for the suffix (symbol/full) and truncate only the path
      // from the front, so e.g. "symbol:inviteMember" is never silently cut
      // off just because the path itself is long.
      const pathBudget = Math.max(10, SUMMARY_ARG_MAX_LEN - suffix.length);
      return `${truncatePathFront(path, pathBudget)}${suffix}`;
    }
    case "search_files": {
      const query = typeof a.query === "string" ? a.query : "";
      const pathSuffix = typeof a.path === "string" && a.path !== "." ? ` in:${a.path}` : "";
      // Same front-truncation approach as read_file: the query is the most
      // important part and must never be silently cut off by a long path.
      const queryBudget = Math.max(10, SUMMARY_ARG_MAX_LEN - pathSuffix.length - 2);
      return `"${truncatePathFront(query, queryBudget)}"${pathSuffix}`;
    }
    case "find_files": {
      const pattern = typeof a.pattern === "string" ? a.pattern : "";
      const pathSuffix = typeof a.path === "string" && a.path !== "." ? ` in:${a.path}` : "";
      const patternBudget = Math.max(10, SUMMARY_ARG_MAX_LEN - pathSuffix.length - 2);
      return `"${truncatePathFront(pattern, patternBudget)}"${pathSuffix}`;
    }
    case "list_dir": {
      const path = typeof a.path === "string" ? a.path : ".";
      return truncate(path, SUMMARY_ARG_MAX_LEN);
    }
    case "web_fetch": {
      const url = typeof a.url === "string" ? a.url : "";
      const extras: string[] = [];
      if (a.section) extras.push(`section:${a.section}`);
      if (a.full) extras.push("full");
      if (a.raw) extras.push("raw");
      if (a.render && a.render !== "auto") extras.push(`render:${a.render}`);
      const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      const urlBudget = Math.max(10, SUMMARY_ARG_MAX_LEN - suffix.length);
      return `${truncatePathFront(url, urlBudget)}${suffix}`;
    }
    case "web_search": {
      const query = typeof a.query === "string" ? a.query : "";
      return `"${truncate(query, SUMMARY_ARG_MAX_LEN - 2)}"`;
    }
    default:
      return "";
  }
}

export const logger = {
  path: LOG_PATH || null,
  summaryPath: SUMMARY_LOG_PATH || null,
  sessionId,

  info(message: string) {
    const line = `${timestamp()} ${sessionTag()} ${color(DIM, "[info]")} ${message}`;
    writeTo(LOG_PATH, line, message);
    writeTo(SUMMARY_LOG_PATH, line, message);
  },

  /** Detail log: full arguments for a tool call. */
  toolCall(name: string, args: unknown) {
    const line = `${timestamp()} ${sessionTag()} ${color(BOLD + CYAN, "[call]")} ${color(BOLD, name)} ${color(
      DIM,
      JSON.stringify(args)
    )}`;
    writeTo(LOG_PATH, line, `${name} ${JSON.stringify(args)}`);
  },

  /**
   * Detail log: full result preview for a successful tool call, AND
   * summary log: one compact high-level line (session, tool, short arg
   * summary, bytes, duration).
   */
  toolResult(name: string, args: unknown, durationMs: number, resultText: string) {
    const bytes = Buffer.byteLength(resultText, "utf-8");
    const preview = resultText.length > 500 ? resultText.slice(0, 500) + "…" : resultText;

    const detailLine = `${timestamp()} ${sessionTag()} ${color(BOLD + GREEN, "[ok]  ")} ${color(
      BOLD,
      name
    )} ${color(DIM, `(${durationMs}ms, ${bytes}B)`)} -> ${preview}`;
    writeTo(LOG_PATH, detailLine, `${name} (${durationMs}ms, ${bytes}B) -> ${preview}`);

    const argSummary = summarizeArgs(name, args);
    const summaryLine = `${timestamp()} ${sessionTag()} ${color(GREEN, "ok")}    ${color(
      BOLD,
      name.padEnd(14)
    )} ${color(YELLOW, `${bytes}B`.padStart(8))} ${color(DIM, `${durationMs}ms`.padStart(7))}${
      argSummary ? "  " + color(DIM, argSummary) : ""
    }`;
    writeTo(SUMMARY_LOG_PATH, summaryLine, `${name} ${bytes}B ${durationMs}ms ${argSummary}`);
  },

  /**
   * Detail log: full error message, AND summary log: one compact high-level
   * line (session, tool, short arg summary, 0 bytes, duration, error flag).
   */
  toolError(name: string, args: unknown, durationMs: number, message: string) {
    const detailLine = `${timestamp()} ${sessionTag()} ${color(BOLD + RED, "[err] ")} ${color(
      BOLD,
      name
    )} ${color(DIM, `(${durationMs}ms)`)} -> ${message}`;
    writeTo(LOG_PATH, detailLine, `${name} (${durationMs}ms) -> ${message}`);

    const argSummary = summarizeArgs(name, args);
    const summaryLine = `${timestamp()} ${sessionTag()} ${color(RED, "err")}   ${color(
      BOLD,
      name.padEnd(14)
    )} ${color(RED, "0B".padStart(8))} ${color(DIM, `${durationMs}ms`.padStart(7))}${
      argSummary ? "  " + color(DIM, argSummary) : ""
    } ${color(RED, message)}`;
    writeTo(SUMMARY_LOG_PATH, summaryLine, `${name} err ${durationMs}ms ${argSummary} ${message}`);
  },
};
