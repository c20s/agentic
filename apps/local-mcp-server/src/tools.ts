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

// Under denna gräns spelar outline mindre roll (filen är redan liten),
// så vi tillåter full:true fritt. Över gränsen krävs en uttrycklig "reason"
// för att undvika att agenten slentrianmässigt alltid kör full:true och
// därmed gör hela outline-funktionen meningslös.
const FULL_READ_FREE_THRESHOLD_BYTES = 4_000;

const readFileSchema = z.object({
  path: z.string().describe("Sökväg till filen, relativt sandbox-roten."),
  full: z
    .boolean()
    .default(false)
    .describe(
      "Hämta hela filinnehållet rakt av, utan outline-förkortning. " +
        "ANVÄND SPARSAMT: läs först utan 'full' (du får en outline), och hämta sen specifika " +
        "delar med 'symbol'. För filer större än ~4KB av outline-bar typ (.md/.ts/.json/.yaml) " +
        "krävs dessutom 'reason' tillsammans med full:true."
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Krävs bara om full:true används på en fil >4KB av outline-bar typ: en kort motivering " +
        "till varför du behöver hela filinnehållet istället för outline/symbol (t.ex. " +
        "'behöver se hela filens kontext för en stor refaktor')."
    ),
  symbol: z
    .string()
    .optional()
    .describe(
      "Hämta bara en specifik del av filen istället för hela outlinen: " +
        "för .md en rubriksektion (matchas mot rubriktext, substring/case-insensitive), " +
        "för .ts/.tsx/.js/.jsx ett symbolnamn (funktion/const/interface/type/class/enum, hela källkoden inkl. body), " +
        "för .json/.yaml/.yml en nyckel-path (t.ex. 'foo.bar.baz' eller 'items[0].name')."
    ),
});

export const readFileTool: ToolDefinition<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Läs innehållet i en textfil inom sandboxen. Read-only. Detta är den primära vägen för agenten att få context. " +
    "Default (ingen 'full' eller 'symbol' angiven): returnerar en kompakt OUTLINE istället för hela filen: " +
    "för .md alla rubriker/underrubriker med radnummer, " +
    "för .ts/.tsx/.js/.jsx alla top-level const/function/interface/type/class/enum-signaturer utan body, " +
    "för .json/.yaml/.yml alla nyckel-paths rekursivt (t.ex. foo.bar.baz, foo.bar, foo). " +
    "Övriga filtyper returneras i sin helhet som vanligt. " +
    "Ange 'symbol' för att hämta en specifik del (rubriksektion/funktion/nyckelvärde), eller 'full: true' för hela filen.",
  inputSchema: readFileSchema,
  handler: async ({ path, full, reason, symbol }, sandbox) => {
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
    const kind = outlineKindForFile(abs);

    if (full) {
      const isOutlineable = kind !== null;
      const isLarge = st.size > FULL_READ_FREE_THRESHOLD_BYTES;
      if (isOutlineable && isLarge && !reason?.trim()) {
        throw new Error(
          `"${path}" är ${st.size} bytes och stödjer outline-läge. ` +
            `Läs först utan 'full' för att se strukturen, och hämta sen specifika delar med 'symbol'. ` +
            `Om du verkligen behöver hela filen: skicka med 'reason' som förklarar varför ` +
            `(t.ex. "behöver se hela filen för en stor refaktor").`
        );
      }
      return content;
    }

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
      if (kind === "json" || kind === "yaml") {
        const value =
          kind === "json" ? extractJsonValueAtPath(content, symbol) : extractYamlValueAtPath(content, symbol);
        if (value === undefined) {
          throw new Error(
            `Ingen nyckel-path "${symbol}" hittades i ${path}. Använd read_file utan 'symbol' för att se outlinen (alla nyckel-paths).`
          );
        }
        return typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }
      throw new Error(
        `"symbol" stöds bara för .md, .ts/.tsx/.js/.jsx, .json och .yaml/.yml-filer. ${path} har ingen outline-typ — använd read_file utan 'symbol' (eller med 'full: true') för att läsa hela filen.`
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
    "Sök efter text eller regex i filINNEHÅLL inom sandboxen, med ripgrep. Read-only. " +
    "Bra för att hitta var något definieras eller används. " +
    "OBS: detta söker i filernas innehåll, inte i filnamn — om du letar efter en fil baserat på " +
    "dess namn/sökväg (t.ex. 'var ligger invite-member-command.ts?'), använd find_files istället.",
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

const findFilesSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob-mönster eller substring att matcha mot FILNAMN/SÖKVÄG (inte innehåll), t.ex. " +
        "'*.ts', '*invite*', 'src/**/*.test.ts'. Om mönstret inte innehåller något av tecknen " +
        "* ? [ ] tolkas det som en substring-match mot hela den relativa sökvägen."
    ),
  path: z.string().default(".").describe("Mapp att söka inom, relativt sandbox-roten."),
  caseSensitive: z.boolean().default(false),
});

export const findFilesTool: ToolDefinition<typeof findFilesSchema> = {
  name: "find_files",
  description:
    "Hitta filer baserat på FILNAMN/SÖKVÄG (inte innehåll) inom sandboxen, med ripgrep --files. " +
    "Read-only. Använd detta när du vet (eller gissar) hur filen heter men inte var den ligger — " +
    "t.ex. find_files({ pattern: '*invite*' }) för att hitta alla filer med 'invite' i namnet. " +
    "Komplement till search_files (som söker i filINNEHÅLL) och list_dir (som kräver att du redan är i rätt mapp).",
  inputSchema: findFilesSchema,
  handler: async ({ pattern, path, caseSensitive }, sandbox) => {
    const abs = sandbox.resolve(path);

    // Om mönstret inte ser ut som en glob (inga * ? [ ]), omvandla det till
    // "*pattern*" så en enkel substring som "invite" fungerar intuitivt,
    // precis som agenten i praktiken försökte göra manuellt.
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
      return `Inga filer matchade "${pattern}".`;
    }
    if (files.length > MAX_LIST_ENTRIES) {
      return [
        ...files.slice(0, MAX_LIST_ENTRIES),
        `... (fler än ${MAX_LIST_ENTRIES} träffar, avkortat — förfina mönstret)`,
      ].join("\n");
    }
    return files.join("\n");
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
    "Skriv (skapa eller skriv över) en fil inom sandboxen med HELA filinnehållet på en gång. " +
    "VARNING: detta ersätter filens fulla innehåll — om du bara vill ändra en del av en befintlig fil " +
    "(t.ex. en funktion, en rad, lägga till en import) ska du använda edit_file istället, som gör en " +
    "riktad ändring utan att du behöver känna till eller skicka med hela filens innehåll. " +
    "Använd write_file för att SKAPA en ny fil, eller när du medvetet vill ersätta en fils fulla innehåll " +
    "och du faktiskt har läst hela filen (full:true) först.",
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

const editFileSchema = z.object({
  path: z.string().describe("Sökväg till filen som ska ändras, relativt sandbox-roten. Filen måste redan finnas."),
  oldString: z
    .string()
    .describe(
      "Den exakta textsträngen som ska bytas ut (inkl. whitespace/indentering). Måste matcha EXAKT en gång " +
        "i filen, annars avvisas ändringen (se replaceAll för flera förekomster)."
    ),
  newString: z.string().describe("Texten som ska ersätta oldString."),
  replaceAll: z
    .boolean()
    .default(false)
    .describe(
      "Om true: ersätt ALLA förekomster av oldString istället för att kräva exakt en match. " +
        "Använd med försiktighet — default false kräver exakt en match för att undvika oavsiktliga ändringar."
    ),
});

export const editFileTool: ToolDefinition<typeof editFileSchema> = {
  name: "edit_file",
  description:
    "Gör en RIKTAD ändring i en befintlig fil genom sök-och-ersätt (oldString → newString), utan att behöva " +
    "känna till eller skicka med hela filens innehåll. Detta är det FÖREDRAGNA sättet att ändra en befintlig " +
    "fil — använd detta istället för write_file när du bara ska lägga till/ändra/ta bort en avgränsad del " +
    "(t.ex. lägga till en import, ändra en funktions body, lägga till en ny export). " +
    "oldString måste matcha exakt en gång i filen (om inte replaceAll:true används) — detta är en säkerhetsspärr " +
    "så att en ändring aldrig träffar fel ställe eller råkar skriva över något du inte sett. " +
    "Om du är osäker på den exakta nuvarande texten: läs filen (eller relevant symbol/sektion) med read_file först.",
  inputSchema: editFileSchema,
  handler: async ({ path, oldString, newString, replaceAll }, sandbox) => {
    const abs = sandbox.resolve(path);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(
        `"${path}" finns inte. edit_file kan bara ändra befintliga filer — använd write_file för att skapa en ny fil.`
      );
    }
    if (st.isDirectory()) {
      throw new Error(`"${path}" är en mapp, inte en fil.`);
    }
    if (st.size > MAX_READ_BYTES) {
      throw new Error(`Filen är för stor (${st.size} bytes, max ${MAX_READ_BYTES}) för edit_file.`);
    }

    const content = await readFile(abs, "utf-8");

    if (oldString === newString) {
      throw new Error("oldString och newString är identiska — ingen ändring att göra.");
    }

    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `Hittade ingen förekomst av den angivna oldString i ${path}. ` +
          `Kontrollera att texten matchar exakt (inkl. whitespace/indentering) — läs filen/symbolen igen för att se exakt nuvarande innehåll.`
      );
    }

    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString matchar ${occurrences} ställen i ${path}, inte exakt ett. ` +
          `Gör oldString mer specifik (t.ex. inkludera mer omgivande kontext) så den bara matchar en gång, ` +
          `eller skicka med replaceAll:true om du medvetet vill ersätta alla förekomster.`
      );
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await writeFile(abs, newContent, "utf-8");

    const verb = occurrences > 1 ? `${occurrences} förekomster` : "1 förekomst";
    return `Ersatte ${verb} i ${sandbox.toRelative(abs)} (${Buffer.byteLength(newContent, "utf-8")} bytes totalt efter ändring).`;
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
];
