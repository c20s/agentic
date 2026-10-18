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
} from "./outline";

// Filtyper/mappar vi aldrig vill lista eller läsa av misstag (brus/hemligheter).
const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const MAX_READ_BYTES = 1_000_000; // ~1MB skydd mot att råka läsa jättefiler
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
// READ-ONLY CONTEXT-VERKTYG
// ---------------------------------------------------------------------------

const listDirSchema = z.object({
  path: z.string().default(".").describe("Mapp att lista, relativt sandbox-roten. Default '.'"),
  recursive: z.boolean().default(false).describe("Lista rekursivt (max djup 6)."),
});

export const listDirTool: ToolDefinition<typeof listDirSchema> = {
  name: "list_dir",
  description:
    "Lista filer och mappar inom sandboxen. Read-only. Använd detta för att utforska projektstrukturen.",
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
          results.push(`... (fler än ${MAX_LIST_ENTRIES} resultat, avkortat)`);
          return;
        }
        if (recursive && entry.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }

    await walk(abs, 0);
    return results.length > 0 ? results.join("\n") : "(tom mapp)";
  },
};

const readFileSchema = z.object({
  path: z.string().describe("Sökväg till filen, relativt sandbox-roten."),
  full: z
    .boolean()
    .default(false)
    .describe(
      "Hämta hela filinnehållet rakt av, utan outline-förkortning. Default false: för .md/.ts/.json ges en kompakt outline istället (se beskrivning av verktyget)."
    ),
  symbol: z
    .string()
    .optional()
    .describe(
      "Hämta bara en specifik del av filen istället för hela outlinen: " +
        "för .md en rubriksektion (matchas mot rubriktext, substring/case-insensitive), " +
        "för .ts/.tsx/.js/.jsx ett symbolnamn (funktion/const/interface/type/class/enum, hela källkoden inkl. body), " +
        "för .json en nyckel-path (t.ex. 'foo.bar.baz' eller 'items[0].name')."
    ),
});

export const readFileTool: ToolDefinition<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Läs innehållet i en textfil inom sandboxen. Read-only. Detta är den primära vägen för agenten att få context. " +
    "Default (ingen 'full' eller 'symbol' angiven): returnerar en kompakt OUTLINE istället för hela filen: " +
    "för .md alla rubriker/underrubriker med radnummer, " +
    "för .ts/.tsx/.js/.jsx alla top-level const/function/interface/type/class/enum-signaturer utan body, " +
    "för .json alla nyckel-paths rekursivt (t.ex. foo.bar.baz, foo.bar, foo). " +
    "Övriga filtyper returneras i sin helhet som vanligt. " +
    "Ange 'symbol' för att hämta en specifik del (rubriksektion/funktion/nyckelvärde), eller 'full: true' för hela filen.",
  inputSchema: readFileSchema,
  handler: async ({ path, full, symbol }, sandbox) => {
    const abs = sandbox.resolve(path);
    const st = await stat(abs);
    if (st.isDirectory()) {
      throw new Error(`"${path}" är en mapp, inte en fil. Använd list_dir istället.`);
    }
    if (st.size > MAX_READ_BYTES) {
      throw new Error(
        `Filen är för stor (${st.size} bytes, max ${MAX_READ_BYTES}). Läs via search_files istället.`
      );
    }
    const content = await readFile(abs, "utf-8");

    if (full) {
      return content;
    }

    const kind = outlineKindForFile(abs);

    if (symbol) {
      if (kind === "markdown") {
        const section = extractMarkdownSection(content, symbol);
        if (section === null) {
          throw new Error(
            `Ingen rubrik som matchar "${symbol}" hittades i ${path}. Använd read_file utan 'symbol' för att se outlinen (alla rubriker).`
          );
        }
        return section;
      }
      if (kind === "typescript") {
        const source = extractTsSymbolSource(content, abs, symbol);
        if (source === null) {
          throw new Error(
            `Ingen top-level symbol med namnet "${symbol}" hittades i ${path}. Använd read_file utan 'symbol' för att se outlinen (alla symboler).`
          );
        }
        return source;
      }
      if (kind === "json") {
        const value = extractJsonValueAtPath(content, symbol);
        if (value === undefined) {
          throw new Error(
            `Ingen nyckel-path "${symbol}" hittades i ${path}. Använd read_file utan 'symbol' för att se outlinen (alla nyckel-paths).`
          );
        }
        return typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }
      throw new Error(
        `"symbol" stöds bara för .md, .ts/.tsx/.js/.jsx och .json-filer. ${path} har ingen outline-typ — använd read_file utan 'symbol' (eller med 'full: true') för att läsa hela filen.`
      );
    }

    if (kind === null) {
      // Okänd filtyp: ingen outline-koncept, ge hela filen direkt (som tidigare beteende).
      return content;
    }

    const outline = buildOutline(content, abs);
    return `[Outline för ${path} — använd read_file med symbol:"<namn>" för en specifik del, eller full:true för hela filen]\n\n${outline}`;
  },
};

const fileStatSchema = z.object({
  path: z.string().describe("Sökväg att hämta metadata för, relativt sandbox-roten."),
});

export const fileStatTool: ToolDefinition<typeof fileStatSchema> = {
  name: "file_stat",
  description: "Hämta metadata (storlek, typ, senast ändrad) för en fil eller mapp. Read-only.",
  inputSchema: fileStatSchema,
  handler: async ({ path }, sandbox) => {
    const abs = sandbox.resolve(path);
    const st = await stat(abs);
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
  query: z.string().describe("Textsträng eller regex att söka efter i filinnehåll."),
  path: z.string().default(".").describe("Mapp (eller fil) att söka inom, relativt sandbox-roten."),
  filePattern: z
    .string()
    .optional()
    .describe("Valfritt glob-filter för filnamn, t.ex. '*.ts' eller '*.md' (ripgrep --glob)."),
  caseSensitive: z.boolean().default(false),
  regex: z
    .boolean()
    .default(false)
    .describe("Tolka query som regex istället för ren text (default: ren textsökning)."),
});

/** Kör ripgrep och samla upp stdout. Kastar fel vid rg-exitkod > 1 (1 = inga träffar, OK). */
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
  // exitCode 0 = träffar, 1 = inga träffar (inte ett fel), 2+ = faktiskt fel (t.ex. trasig regex)
  if (exitCode >= 2) {
    throw new Error(`ripgrep misslyckades: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  return { stdout, exitCode };
}

export const searchFilesTool: ToolDefinition<typeof searchFilesSchema> = {
  name: "search_files",
  description:
    "Sök efter text eller regex i filer inom sandboxen, med ripgrep. Read-only. Bra för att hitta var något definieras eller används.",
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
      // -e/--regexp gör att query alltid tolkas som ett sökmönster (aldrig som
      // flagga eller fil), oavsett om den börjar med "-" eller om --fixed-strings
      // är satt. Positional-argumentet som blir kvar är då bara sökvägen.
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
        matches.push(`... (fler än ${MAX_SEARCH_RESULTS} träffar, avkortat)`);
        break;
      }
    }

    return matches.length > 0 ? matches.join("\n") : "Inga träffar.";
  },
};

// ---------------------------------------------------------------------------
// DET ENDA SKRIVVERKTYGET
// ---------------------------------------------------------------------------

const writeFileSchema = z.object({
  path: z.string().describe("Sökväg till filen som ska skrivas, relativt sandbox-roten."),
  content: z.string().describe("Fullständigt filinnehåll som ska skrivas (ersätter ev. befintligt innehåll)."),
  createDirs: z
    .boolean()
    .default(true)
    .describe("Skapa saknade mappar i sökvägen om de inte finns."),
});

export const writeFileTool: ToolDefinition<typeof writeFileSchema> = {
  name: "write_file",
  description:
    "Skriv (skapa eller skriv över) en fil inom sandboxen med nytt innehåll. Detta är det ENDA verktyget som får göra ändringar på disk.",
  inputSchema: writeFileSchema,
  handler: async ({ path, content, createDirs }, sandbox) => {
    const abs = sandbox.resolve(path);
    if (createDirs) {
      await mkdir(dirname(abs), { recursive: true });
    }
    await writeFile(abs, content, "utf-8");
    return `Skrev ${Buffer.byteLength(content, "utf-8")} bytes till ${sandbox.toRelative(abs)}`;
  },
};

export const allTools = [
  listDirTool,
  readFileTool,
  fileStatTool,
  searchFilesTool,
  writeFileTool,
];
