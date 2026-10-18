import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Logger for the MCP server, with two levels:
 *
 * - SUMMARY (~/.claude/mcp-local-fs.summary.log): one line per tool call,
 *   high level: session id, tool name, byte size of the result, duration,
 *   ok/error. Meant for a quick `tail -f` overview of what's happening.
 * - DETAIL (~/.claude/mcp-local-fs.log): same as before — full arguments and
 *   a preview of the result/error for every call.
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
   * summary log: one compact high-level line (session, tool, bytes, duration).
   */
  toolResult(name: string, durationMs: number, resultText: string) {
    const bytes = Buffer.byteLength(resultText, "utf-8");
    const preview = resultText.length > 500 ? resultText.slice(0, 500) + "…" : resultText;

    const detailLine = `${timestamp()} ${sessionTag()} ${color(BOLD + GREEN, "[ok]  ")} ${color(
      BOLD,
      name
    )} ${color(DIM, `(${durationMs}ms, ${bytes}B)`)} -> ${preview}`;
    writeTo(LOG_PATH, detailLine, `${name} (${durationMs}ms, ${bytes}B) -> ${preview}`);

    const summaryLine = `${timestamp()} ${sessionTag()} ${color(GREEN, "ok")}    ${color(
      BOLD,
      name.padEnd(14)
    )} ${color(YELLOW, `${bytes}B`.padStart(8))} ${color(DIM, `${durationMs}ms`.padStart(7))}`;
    writeTo(SUMMARY_LOG_PATH, summaryLine, `${name} ${bytes}B ${durationMs}ms`);
  },

  /**
   * Detail log: full error message, AND summary log: one compact high-level
   * line (session, tool, 0 bytes, duration, error flag).
   */
  toolError(name: string, durationMs: number, message: string) {
    const detailLine = `${timestamp()} ${sessionTag()} ${color(BOLD + RED, "[err] ")} ${color(
      BOLD,
      name
    )} ${color(DIM, `(${durationMs}ms)`)} -> ${message}`;
    writeTo(LOG_PATH, detailLine, `${name} (${durationMs}ms) -> ${message}`);

    const summaryLine = `${timestamp()} ${sessionTag()} ${color(RED, "err")}   ${color(
      BOLD,
      name.padEnd(14)
    )} ${color(RED, "0B".padStart(8))} ${color(DIM, `${durationMs}ms`.padStart(7))} ${color(RED, message)}`;
    writeTo(SUMMARY_LOG_PATH, summaryLine, `${name} err ${durationMs}ms ${message}`);
  },
};
