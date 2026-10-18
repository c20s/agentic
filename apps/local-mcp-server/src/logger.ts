import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Simple file logger so you can `tail -f` what the MCP server is doing,
 * regardless of whether it was started by Claude Code (background process,
 * no terminal of its own) or manually by you.
 *
 * Path can be overridden with the env var MCP_LOG_FILE. Set MCP_LOG_FILE=""
 * (empty string) to disable file logging entirely (stderr only).
 */
const DEFAULT_LOG_PATH = `${homedir()}/.claude/mcp-local-fs.log`;
const LOG_PATH = process.env.MCP_LOG_FILE ?? DEFAULT_LOG_PATH;

if (LOG_PATH) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {
    // if the directory can't be created we just fall back to stderr below
  }
}

function write(line: string) {
  // Always also to stderr (visible e.g. if you run the server manually in a terminal).
  console.error(line);
  if (!LOG_PATH) return;
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // fail silently - we never want to crash the server due to logging
  }
}

export const logger = {
  path: LOG_PATH || null,

  info(message: string) {
    write(`[${new Date().toISOString()}] [info] ${message}`);
  },

  toolCall(name: string, args: unknown) {
    write(`[${new Date().toISOString()}] [call] ${name} ${JSON.stringify(args)}`);
  },

  toolResult(name: string, durationMs: number, resultPreview: string) {
    const preview = resultPreview.length > 500 ? resultPreview.slice(0, 500) + "…" : resultPreview;
    write(`[${new Date().toISOString()}] [ok]   ${name} (${durationMs}ms) -> ${preview}`);
  },

  toolError(name: string, durationMs: number, message: string) {
    write(`[${new Date().toISOString()}] [err]  ${name} (${durationMs}ms) -> ${message}`);
  },
};
