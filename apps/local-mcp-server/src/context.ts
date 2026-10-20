import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Project context lookup for the `get_context` tool.
 *
 * Same shape/philosophy as `tool-help.ts`: the tool's own description (sent to
 * the model on every turn) stays a single dense line, while the actual
 * content lives here and is only paid for (in context tokens) on the turns
 * where it's actually fetched.
 *
 * For now this only returns one thing: a generic, AGENTS.md-style guideline
 * for how to respond/behave in this repo, returned when `get_context` is
 * called with no symbol (or an empty one). The content lives in
 * `prompts/default.md` (edit that file directly, not this one) — it's part
 * of the MCP server itself, not the sandboxed project, so it's loaded
 * relative to this module rather than through the Sandbox.
 *
 * This is meant to grow into a small lookup table keyed by "symbol" (e.g.
 * `review`, `get_project_overview`) for scripted, on-demand summaries of
 * this repo — short descriptions of what's here and when to use them, a
 * replacement/extension for ad-hoc skills — but that's intentionally not
 * built yet; only the default guideline is implemented so far.
 */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf-8").trim();
}

export function getContext(symbol?: string): string {
  if (!symbol) return loadPrompt("default.md");
  return (
    `No context entry for "${symbol}" yet — only the default guideline (no symbol) is implemented so far. ` +
    `Fall back to list_dir/search_files/find_files to explore directly.`
  );
}
