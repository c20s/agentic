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
  path: z.string().default(".").describe("Directory to list, relative to the sandbox root. Default '.'"),
  recursive: z.boolean().default(false).describe("List recursively (max depth 6)."),
});

export const listDirTool: ToolDefinition<typeof listDirSchema> = {
  name: "list_dir",
  description:
    "List files and directories within the sandbox. Read-only. Use this to explore the project structure.",
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
  path: z.string().describe("Path to the file, relative to the sandbox root."),
  full: z
    .boolean()
    .default(false)
    .describe(
      "Get the entire file content as-is, without outline shortening. " +
        "USE SPARINGLY: read without 'full' first (you get an outline), then fetch specific " +
        "parts with 'symbol'. For files larger than ~4KB of an outlineable type (.md/.ts/.json/.yaml), " +
        "'reason' is also required together with full:true."
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Only required if full:true is used on a file >4KB of an outlineable type: a short justification " +
        "for why you need the entire file content instead of outline/symbol (e.g. " +
        "'need to see the whole file context for a large refactor')."
    ),
  symbol: z
    .string()
    .optional()
    .describe(
      "Fetch just a specific part of the file instead of the whole outline: " +
        "for .md a heading section (matched against heading text, substring/case-insensitive), " +
        "for .ts/.tsx/.js/.jsx a symbol name (function/const/interface/type/class/enum, full source code incl. body; " +
        "for imports you can match on the module path, a substring of it, or an imported name, e.g. 'create' or 'member.create'), " +
        "for .json/.yaml/.yml a key path (e.g. 'foo.bar.baz' or 'items[0].name')."
    ),
});

export const readFileTool: ToolDefinition<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Read the content of a text file within the sandbox. Read-only. This is the primary way for the agent to get context. " +
    "Default (no 'full' or 'symbol' given): returns a compact OUTLINE instead of the whole file: " +
    "for .md all headings/subheadings with line numbers, " +
    "for .ts/.tsx/.js/.jsx all top-level const/function/interface/type/class/enum signatures without body, " +
    "for .json/.yaml/.yml all key paths recursively (e.g. foo.bar.baz, foo.bar, foo). " +
    "Other file types are returned in full as usual. " +
    "Pass 'symbol' to fetch a specific part (heading section/function/key value), or 'full: true' for the entire file.",
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
  path: z.string().describe("Path to get metadata for, relative to the sandbox root."),
});

export const fileStatTool: ToolDefinition<typeof fileStatSchema> = {
  name: "file_stat",
  description: "Get metadata (size, type, last modified) for a file or directory. Read-only.",
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
  query: z.string().describe("Text string or regex to search for in file content."),
  path: z.string().default(".").describe("Directory (or file) to search within, relative to the sandbox root."),
  filePattern: z
    .string()
    .optional()
    .describe("Optional glob filter for file names, e.g. '*.ts' or '*.md' (ripgrep --glob)."),
  caseSensitive: z.boolean().default(false),
  regex: z
    .boolean()
    .default(false)
    .describe("Interpret query as regex instead of plain text (default: plain text search)."),
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
    "Search for text or regex in file CONTENT within the sandbox, using ripgrep. Read-only. " +
    "Good for finding where something is defined or used. " +
    "NOTE: this searches file content, not file names — if you're looking for a file based on " +
    "its name/path (e.g. 'where is invite-member-command.ts?'), use find_files instead.",
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
    .describe(
      "Glob pattern or substring to match against FILE NAME/PATH (not content), e.g. " +
        "'*.ts', '*invite*', 'src/**/*.test.ts'. If the pattern doesn't contain any of the characters " +
        "* ? [ ] it's treated as a substring match against the full relative path."
    ),
  path: z.string().default(".").describe("Directory to search within, relative to the sandbox root."),
  caseSensitive: z.boolean().default(false),
});

export const findFilesTool: ToolDefinition<typeof findFilesSchema> = {
  name: "find_files",
  description:
    "Find files based on FILE NAME/PATH (not content) within the sandbox, using ripgrep --files. " +
    "Read-only. Use this when you know (or are guessing) a file's name but not where it lives — " +
    "e.g. find_files({ pattern: '*invite*' }) to find all files with 'invite' in the name. " +
    "Complements search_files (which searches file CONTENT) and list_dir (which requires you to already be in the right directory).",
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
  path: z.string().describe("Path to the file to write, relative to the sandbox root."),
  content: z.string().describe("The complete file content to write (replaces any existing content)."),
  createDirs: z
    .boolean()
    .default(true)
    .describe("Create missing directories in the path if they don't exist."),
});

export const writeFileTool: ToolDefinition<typeof writeFileSchema> = {
  name: "write_file",
  description:
    "Write (create or overwrite) a file within the sandbox with the ENTIRE file content at once. " +
    "WARNING: this replaces the full content of the file — if you only want to change part of an " +
    "existing file (e.g. a function, a line, adding an import), use edit_file instead, which makes a " +
    "targeted change without you needing to know or send the whole file's content. " +
    "Use write_file to CREATE a new file, or when you deliberately want to replace a file's full content " +
    "and you have actually read the whole file (full:true) first.",
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
  path: z.string().describe("Path to the file to edit, relative to the sandbox root. The file must already exist."),
  oldString: z
    .string()
    .describe(
      "The exact text string to replace (incl. whitespace/indentation). Must match EXACTLY once " +
        "in the file, otherwise the edit is rejected (see replaceAll for multiple occurrences)."
    ),
  newString: z.string().describe("The text to replace oldString with."),
  replaceAll: z
    .boolean()
    .default(false)
    .describe(
      "If true: replace ALL occurrences of oldString instead of requiring exactly one match. " +
        "Use with caution — default false requires exactly one match to avoid unintended changes."
    ),
});

export const editFileTool: ToolDefinition<typeof editFileSchema> = {
  name: "edit_file",
  description:
    "Make a TARGETED change to an existing file via search-and-replace (oldString → newString), without needing " +
    "to know or send the whole file's content. This is the PREFERRED way to change an existing " +
    "file — use this instead of write_file when you're only adding/changing/removing a bounded part " +
    "(e.g. adding an import, changing a function's body, adding a new export). " +
    "oldString must match exactly once in the file (unless replaceAll:true is used) — this is a safety guard " +
    "so an edit never hits the wrong place or accidentally overwrites something you haven't seen. " +
    "If you're unsure of the exact current text: read the file (or the relevant symbol/section) with read_file first.",
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

export const allTools = [
  listDirTool,
  readFileTool,
  fileStatTool,
  searchFilesTool,
  findFilesTool,
  writeFileTool,
  editFileTool,
  ...webTools,
];
