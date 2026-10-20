import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Sandbox } from "./sandbox";
import {
  outlineKindForFile,
  buildOutline,
  extractMarkdownSection,
  extractTsSymbolSource,
  extractJsonValueAtPath,
  extractYamlValueAtPath,
} from "./outline";
import { webTools } from "./web";
import { getToolHelp } from "./tool-help";

// File types/directories we never want to list or read by accident (noise/secrets).
const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const MAX_READ_BYTES = 1_000_000; // ~1MB guard against accidentally reading huge files
const MAX_LIST_ENTRIES = 2000;
const MAX_SEARCH_RESULTS = 200;

function isIgnored(name: string) {
  return DEFAULT_IGNORES.has(name);
}

export interface ToolDefinition<Schema extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: z.infer<Schema>, sandbox: Sandbox) => Promise<string>;
}

// ---------------------------------------------------------------------------
// READ-ONLY CONTEXT TOOLS
// ---------------------------------------------------------------------------

const listDirSchema = z.object({
  path: z.string().default(".").describe("Dir to list, relative to sandbox root."),
  recursive: z.boolean().default(false).describe("Recurse (max depth 6)."),
});

export const listDirTool: ToolDefinition<typeof listDirSchema> = {
  name: "list_dir",
  description: "List files/dirs in the sandbox. Read-only.",
  inputSchema: listDirSchema,
  handler: async ({ path, recursive }, sandbox) => {
    const abs = sandbox.resolve(path);
    const results: string[] = [];

    async function walk(dir: string, depth: number) {
      if (results.length >= MAX_LIST_ENTRIES || depth > 6) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (isIgnored(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = relative(sandbox.root, full);
        results.push(entry.isDirectory() ? `${rel}/` : rel);
        if (results.length >= MAX_LIST_ENTRIES) {
          results.push(`... (more than ${MAX_LIST_ENTRIES} results, truncated)`);
          return;
        }
        if (recursive && entry.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }

    await walk(abs, 0);
    return results.length > 0 ? results.join("\n") : "(empty directory)";
  },
};

// Below this threshold, outline matters less (the file is already small),
// so we allow full:true freely. Above the threshold, an explicit "reason"
// is required to avoid the agent routinely always running full:true and
// thereby making the whole outline feature pointless.
const FULL_READ_FREE_THRESHOLD_BYTES = 4_000;

const readFileSchema = z.object({
  path: z.string().describe("Path to the file, relative to sandbox root."),
  full: z.boolean().default(false).describe("Whole file, no outline. >4KB outlineable files need 'reason' too."),
  reason: z.string().optional().describe("Why you need 'full' on a large outlineable file. See tool_help."),
  symbol: z.string().optional().describe("Fetch one part instead of the full outline: heading/symbol/key-path. Use the symbol text itself, without any leading '#'."),
});

export const readFileTool: ToolDefinition<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Read a text file. Read-only. Default: compact OUTLINE (md headings / ts top-level signatures / " +
    "json+yaml key paths), not the full file. Use 'symbol' (the heading/symbol/key-path text itself, " +
    "without any leading '#') for one part, 'full:true' for everything. " +
    "Call tool_help('read_file') before relying on 'symbol' or 'full' for the first time.",
  inputSchema: readFileSchema,
  handler: async ({ path, full, reason, symbol }, sandbox) => {
    const abs = sandbox.resolve(path);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`"${path}" does not exist.`);
    }
    if (st.isDirectory()) {
      throw new Error(`"${path}" is a directory, not a file. Use list_dir instead.`);
    }
    if (st.size > MAX_READ_BYTES) {
      throw new Error(
        `File is too large (${st.size} bytes, max ${MAX_READ_BYTES}). Read via search_files instead.`
      );
    }
    const content = await readFile(abs, "utf-8");
    const kind = outlineKindForFile(abs);

    if (full) {
      const isOutlineable = kind !== null;
      const isLarge = st.size > FULL_READ_FREE_THRESHOLD_BYTES;
      if (isOutlineable && isLarge && !reason?.trim()) {
        throw new Error(
          `"${path}" is ${st.size} bytes and supports outline mode. ` +
            `Read without 'full' first to see the structure, then fetch specific parts with 'symbol'. ` +
            `If you really need the whole file: pass 'reason' explaining why ` +
            `(e.g. "need to see the whole file for a large refactor").`
        );
      }
      return content;
    }

    if (symbol) {
      if (kind === "markdown") {
        const section = extractMarkdownSection(content, symbol);
        if (section === null) {
          throw new Error(
            `No heading matching "${symbol}" was found in ${path}. Use read_file without 'symbol' to see the outline (all headings).`
          );
        }
        return section;
      }
      if (kind === "typescript") {
        const source = extractTsSymbolSource(content, abs, symbol);
        if (source === null) {
          throw new Error(
            `No top-level symbol named "${symbol}" was found in ${path}. Use read_file without 'symbol' to see the outline (all symbols).`
          );
        }
        return source;
      }
      if (kind === "json" || kind === "yaml") {
        const value =
          kind === "json" ? extractJsonValueAtPath(content, symbol) : extractYamlValueAtPath(content, symbol);
        if (value === undefined) {
          throw new Error(
            `No key path "${symbol}" was found in ${path}. Use read_file without 'symbol' to see the outline (all key paths).`
          );
        }
        return typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }
      throw new Error(
        `"symbol" is only supported for .md, .ts/.tsx/.js/.jsx, .json and .yaml/.yml files. ${path} has no outline type — use read_file without 'symbol' (or with 'full: true') to read the whole file.`
      );
    }

    if (kind === null) {
      // Unknown file type: no outline concept, return the whole file directly (as before).
      return content;
    }

    const outline = buildOutline(content, abs);
    return `[Outline for ${path} — use read_file with symbol:"<name>" for a specific part, or full:true for the whole file]\n\n${outline}`;
  },
};

const fileStatSchema = z.object({
  path: z.string().describe("Path, relative to sandbox root."),
});

export const fileStatTool: ToolDefinition<typeof fileStatSchema> = {
  name: "file_stat",
  description: "Size/type/mtime of a file or dir. Read-only.",
  inputSchema: fileStatSchema,
  handler: async ({ path }, sandbox) => {
    const abs = sandbox.resolve(path);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`"${path}" does not exist.`);
    }
    return JSON.stringify(
      {
        path,
        type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      },
      null,
      2
    );
  },
};

const searchFilesSchema = z.object({
  query: z.string().describe("Text or regex to find in file content."),
  path: z.string().default(".").describe("Dir/file to search within, relative to sandbox root."),
  filePattern: z.string().optional().describe("Glob filter, e.g. '*.ts' (ripgrep --glob)."),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false).describe("Treat query as regex (default: literal text)."),
});

/** Runs ripgrep and collects stdout. Throws on rg exit code > 1 (1 = no matches, OK). */
async function runRipgrep(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["rg", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // exit code 0 = matches, 1 = no matches (not an error), 2+ = actual error (e.g. broken regex)
  if (exitCode >= 2) {
    throw new Error(`ripgrep failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  return { stdout, exitCode };
}

export const searchFilesTool: ToolDefinition<typeof searchFilesSchema> = {
  name: "search_files",
  description:
    "Search file CONTENT (not names — use find_files for that) via ripgrep. Read-only. " +
    "Good for finding where something is defined/used.",
  inputSchema: searchFilesSchema,
  handler: async ({ query, path, filePattern, caseSensitive, regex }, sandbox) => {
    const abs = sandbox.resolve(path);

    const args = [
      "--json",
      "--line-number",
      ...(regex ? [] : ["--fixed-strings"]),
      ...(caseSensitive ? [] : ["--ignore-case"]),
      ...(filePattern ? ["--glob", filePattern] : []),
      "--max-count",
      String(MAX_SEARCH_RESULTS),
      ...[...DEFAULT_IGNORES].flatMap((dir) => ["--glob", `!${dir}`]),
      // -e/--regexp ensures query is always interpreted as a search pattern (never as a
      // flag or file), regardless of whether it starts with "-" or --fixed-strings is set.
      // The remaining positional argument is then just the path.
      "--regexp",
      query,
      "--",
      abs,
    ];

    const { stdout } = await runRipgrep(args, sandbox.root);

    const matches: string[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "match") continue;

      const filePath: string = event.data.path.text;
      const lineNumber: number = event.data.line_number;
      const lineText: string = event.data.lines.text.replace(/\n$/, "");
      const rel = relative(sandbox.root, filePath);

      matches.push(`${rel}:${lineNumber}: ${lineText.trim()}`);
      if (matches.length >= MAX_SEARCH_RESULTS) {
        matches.push(`... (more than ${MAX_SEARCH_RESULTS} matches, truncated)`);
        break;
      }
    }

    return matches.length > 0 ? matches.join("\n") : "No matches.";
  },
};

const findFilesSchema = z.object({
  pattern: z
    .string()
    .describe("Glob or substring to match FILE NAME/PATH (not content), e.g. '*.ts', 'invite'."),
  path: z.string().default(".").describe("Dir to search within, relative to sandbox root."),
  caseSensitive: z.boolean().default(false),
});

export const findFilesTool: ToolDefinition<typeof findFilesSchema> = {
  name: "find_files",
  description:
    "Find files by NAME/PATH (not content — use search_files for content) via ripgrep --files. Read-only.",
  inputSchema: findFilesSchema,
  handler: async ({ pattern, path, caseSensitive }, sandbox) => {
    const abs = sandbox.resolve(path);

    // If the pattern doesn't look like a glob (no * ? [ ]), turn it into
    // "*pattern*" so a plain substring like "invite" works intuitively,
    // just like the agent in practice tried to do manually.
    const looksLikeGlob = /[*?\[\]]/.test(pattern);
    const glob = looksLikeGlob ? pattern : `*${pattern}*`;

    const args = [
      "--files",
      ...(caseSensitive ? ["--glob", glob] : ["--glob", glob, "--ignore-case"]),
      ...[...DEFAULT_IGNORES].flatMap((dir) => ["--glob", `!${dir}`]),
      "--",
      abs,
    ];

    const { stdout } = await runRipgrep(args, sandbox.root);

    const files = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((f) => relative(sandbox.root, f))
      .sort();

    if (files.length === 0) {
      return `No files matched "${pattern}".`;
    }
    if (files.length > MAX_LIST_ENTRIES) {
      return [
        ...files.slice(0, MAX_LIST_ENTRIES),
        `... (more than ${MAX_LIST_ENTRIES} matches, truncated — refine the pattern)`,
      ].join("\n");
    }
    return files.join("\n");
  },
};

// ---------------------------------------------------------------------------
// THE ONLY WRITE TOOLS
// ---------------------------------------------------------------------------

const writeFileSchema = z.object({
  path: z.string().describe("Path to write, relative to sandbox root."),
  content: z.string().describe("Full file content (replaces anything existing)."),
  createDirs: z.boolean().default(true).describe("Create missing parent dirs."),
});

export const writeFileTool: ToolDefinition<typeof writeFileSchema> = {
  name: "write_file",
  description:
    "Create a file, or overwrite one's ENTIRE content. For partial edits of an existing file use " +
    "edit_file instead. Call tool_help('write_file') before overwriting a file you haven't fully read.",
  inputSchema: writeFileSchema,
  handler: async ({ path, content, createDirs }, sandbox) => {
    const abs = sandbox.resolve(path);
    if (createDirs) {
      await mkdir(dirname(abs), { recursive: true });
    }
    await writeFile(abs, content, "utf-8");
    return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${sandbox.toRelative(abs)}`;
  },
};

const editFileSchema = z.object({
  path: z.string().describe("Path to an EXISTING file, relative to sandbox root."),
  oldString: z.string().describe("Exact text to replace; must match exactly once unless replaceAll."),
  newString: z.string().describe("Replacement text."),
  replaceAll: z.boolean().default(false).describe("Replace all matches instead of requiring exactly one."),
});

export const editFileTool: ToolDefinition<typeof editFileSchema> = {
  name: "edit_file",
  description:
    "Targeted search-and-replace edit (oldString -> newString) without sending the whole file. " +
    "PREFERRED over write_file for partial changes. oldString must match exactly once (or pass " +
    "replaceAll). Not sure of exact current text? read_file first.",
  inputSchema: editFileSchema,
  handler: async ({ path, oldString, newString, replaceAll }, sandbox) => {
    const abs = sandbox.resolve(path);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(
        `"${path}" does not exist. edit_file can only change existing files — use write_file to create a new file.`
      );
    }
    if (st.isDirectory()) {
      throw new Error(`"${path}" is a directory, not a file.`);
    }
    if (st.size > MAX_READ_BYTES) {
      throw new Error(`File is too large (${st.size} bytes, max ${MAX_READ_BYTES}) for edit_file.`);
    }

    const content = await readFile(abs, "utf-8");

    if (oldString === newString) {
      throw new Error("oldString and newString are identical — nothing to change.");
    }

    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `No occurrence of the given oldString was found in ${path}. ` +
          `Check that the text matches exactly (incl. whitespace/indentation) — read the file/symbol again to see the exact current content.`
      );
    }

    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString matches ${occurrences} places in ${path}, not exactly one. ` +
          `Make oldString more specific (e.g. include more surrounding context) so it only matches once, ` +
          `or pass replaceAll:true if you deliberately want to replace all occurrences.`
      );
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await writeFile(abs, newContent, "utf-8");

    const verb = occurrences > 1 ? `${occurrences} occurrences` : "1 occurrence";
    return `Replaced ${verb} in ${sandbox.toRelative(abs)} (${Buffer.byteLength(newContent, "utf-8")} bytes total after edit).`;
  },
};

// ---------------------------------------------------------------------------
// ON-DEMAND DOCS (kept out of every other tool's description — see tool-help.ts)
// ---------------------------------------------------------------------------

const toolHelpSchema = z.object({
  name: z.string().describe("Tool name, e.g. 'read_file' or 'web_fetch'."),
});

export const toolHelpTool: ToolDefinition<typeof toolHelpSchema> = {
  name: "tool_help",
  description:
    "Full usage guide for one tool (edge cases, multi-step workflow, the 'why' behind a constraint). " +
    "Call this before the first tricky use of read_file, edit_file, write_file, find_files, " +
    "search_files or web_fetch — their one-line descriptions are intentionally terse.",
  inputSchema: toolHelpSchema,
  handler: async ({ name }) => getToolHelp(name),
};

export const allTools = [
  listDirTool,
  readFileTool,
  fileStatTool,
  searchFilesTool,
  findFilesTool,
  writeFileTool,
  editFileTool,
  toolHelpTool,
  ...webTools,
];
