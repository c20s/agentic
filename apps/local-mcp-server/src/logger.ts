import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Enkel fil-logger så man kan köra `tail -f` på vad MCP-servern gör,
 * oavsett om den startades av Claude Code (bakgrundsprocess, ingen egen
 * terminal) eller manuellt av dig själv.
 *
 * Path kan overridas med env MCP_LOG_FILE. Sätt MCP_LOG_FILE="" (tom sträng)
 * för att stänga av filloggning helt (bara stderr kvar).
 */
const DEFAULT_LOG_PATH = `${homedir()}/.claude/mcp-local-fs.log`;
const LOG_PATH = process.env.MCP_LOG_FILE ?? DEFAULT_LOG_PATH;

if (LOG_PATH) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {
    // om det inte går att skapa mappen faller vi bara tillbaka på stderr nedan
  }
}

function write(line: string) {
  // Alltid till stderr också (syns t.ex. om du kör servern manuellt i en terminal).
  console.error(line);
  if (!LOG_PATH) return;
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // tyst fail - vi vill aldrig krascha servern pga loggning
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
    write(`[${new Date().toISOString()}] [fel]  ${name} (${durationMs}ms) -> ${message}`);
  },
};
