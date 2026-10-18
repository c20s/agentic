import ts from "typescript";
import { extname } from "node:path";

// ---------------------------------------------------------------------------
// Markdown: lista alla rubriker (#, ##, ### osv.) med radnummer.
// ---------------------------------------------------------------------------

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number; // 1-indexerat
}

export function extractMarkdownOutline(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Hoppa över kodblock så vi inte plockar upp "#"-kommentarer i t.ex. bash/python.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      headings.push({
        level: match[1]!.length,
        text: match[2]!.trim(),
        line: i + 1,
      });
    }
  }

  return headings;
}

export function formatMarkdownOutline(headings: MarkdownHeading[]): string {
  if (headings.length === 0) return "(inga rubriker hittades)";
  return headings
    .map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text} (rad ${h.line})`)
    .join("\n");
}

/**
 * Hämtar en hel sektion ur en markdown-fil: från en rubrik (matchad på text,
 * case-insensitive substring) till och med raden innan nästa rubrik på samma
 * eller högre nivå. Returnerar null om ingen matchande rubrik hittas.
 */
export function extractMarkdownSection(content: string, headingQuery: string): string | null {
  const headings = extractMarkdownOutline(content);
  const needle = headingQuery.toLowerCase();
  const idx = headings.findIndex((h) => h.text.toLowerCase().includes(needle));
  if (idx === -1) return null;

  const target = headings[idx]!;
  const next = headings.slice(idx + 1).find((h) => h.level <= target.level);
  const lines = content.split("\n");
  const startLine = target.line - 1; // 0-indexerat
  const endLine = next ? next.line - 1 : lines.length;

  return lines.slice(startLine, endLine).join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// TypeScript/JavaScript: top-level const/function/interface/type/class/enum,
// med signatur men utan body. Byggd på riktiga TS AST, inte regex.
// ---------------------------------------------------------------------------

export interface TsSymbol {
  kind: string; // "import" | "function" | "const" | "interface" | "type" | "class" | "enum" | "export" | "other"
  name: string;
  signature: string; // en rad, utan body
  line: number; // 1-indexerat
  exported: boolean;
}

export interface TsOutlineResult {
  symbols: TsSymbol[];
  /**
   * true om varje top-level statement i filen kunde kategoriseras som en
   * känd symbol-typ ("other" räknas INTE som fullt kategoriserad). false
   * betyder att outline inte ger full täckning av filen — det finns
   * top-level-kod (löst uttryck, IIFE, etc.) som inte syns i outline-listan,
   * och man bör då vara extra försiktig med att skriva om filen utan att
   * läsa den i sin helhet (full:true) först.
   */
  fullyCovered: boolean;
}

function getLeadingExport(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

export function extractTsOutline(content: string, fileName: string): TsOutlineResult {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const symbols: TsSymbol[] = [];
  let fullyCovered = true;

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  // Bygger en "header"-sträng för en deklaration: allt fram till { eller ;
  // men utan funktions-/class-/interface-body.
  function headerOf(node: ts.Node): string {
    const full = node.getText(sourceFile);
    const bodyStart = full.indexOf("{");
    const header = bodyStart === -1 ? full : full.slice(0, bodyStart).trim();
    return header.replace(/\s+/g, " ").trim();
  }

  // Komprimerar en lång rad (t.ex. en lång import-sats) till en läsbar enrads-sammanfattning.
  function oneLine(node: ts.Node): string {
    return node.getText(sourceFile).replace(/\s+/g, " ").trim();
  }

  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier.getText(sourceFile);
      symbols.push({
        kind: "import",
        name: moduleSpecifier.replace(/^["']|["']$/g, ""),
        signature: oneLine(node),
        line: lineOf(node),
        exported: false,
      });
    } else if (ts.isImportEqualsDeclaration(node)) {
      symbols.push({
        kind: "import",
        name: node.name.text,
        signature: oneLine(node),
        line: lineOf(node),
        exported: false,
      });
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        kind: "function",
        name: node.name.text,
        signature: headerOf(node),
        line: lineOf(node),
        exported: getLeadingExport(node),
      });
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({
        kind: "interface",
        name: node.name.text,
        signature: headerOf(node),
        line: lineOf(node),
        exported: getLeadingExport(node),
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({
        kind: "type",
        name: node.name.text,
        signature: headerOf(node).replace(/\s*=\s*$/, ""),
        line: lineOf(node),
        exported: getLeadingExport(node),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({
        kind: "class",
        name: node.name.text,
        signature: headerOf(node),
        line: lineOf(node),
        exported: getLeadingExport(node),
      });
    } else if (ts.isEnumDeclaration(node)) {
      symbols.push({
        kind: "enum",
        name: node.name.text,
        signature: headerOf(node),
        line: lineOf(node),
        exported: getLeadingExport(node),
      });
    } else if (ts.isVariableStatement(node)) {
      const exported = getLeadingExport(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        // Signatur: "const name: Type = <första raden av initializer>" utan body.
        const typeAnnotation = decl.type ? `: ${decl.type.getText(sourceFile)}` : "";
        let initPreview = "";
        if (decl.initializer) {
          const initText = decl.initializer.getText(sourceFile);
          const firstLine = initText.split("\n")[0]!.trim();
          initPreview = ` = ${firstLine}${initText.includes("\n") ? " …" : ""}`;
        }
        symbols.push({
          kind: "const",
          name: decl.name.text,
          signature: `${node.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${decl.name.text}${typeAnnotation}${initPreview}`,
          line: lineOf(decl),
          exported,
        });
      }
    } else if (ts.isExportAssignment(node)) {
      symbols.push({
        kind: "export",
        name: "default",
        signature: headerOf(node),
        line: lineOf(node),
        exported: true,
      });
    } else if (ts.isExportDeclaration(node)) {
      symbols.push({
        kind: "export",
        name: oneLine(node),
        signature: oneLine(node),
        line: lineOf(node),
        exported: true,
      });
    } else if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      // inget att göra, inte ett riktigt statement
    } else {
      // Okänt top-level statement: löst uttryck, IIFE, bar console.log, etc.
      // Detta är PRECIS den typen av kod som outline annars skulle dölja helt.
      fullyCovered = false;
      const text = oneLine(node);
      symbols.push({
        kind: "other",
        name: "(okategoriserad kod)",
        signature: text.length > 120 ? text.slice(0, 120) + "…" : text,
        line: lineOf(node),
        exported: false,
      });
    }
  });

  return { symbols, fullyCovered };
}

export function formatTsOutline(result: TsOutlineResult): string {
  const { symbols, fullyCovered } = result;
  if (symbols.length === 0) return "(inga top-level symboler hittades — troligen en tom fil)";

  const lines = symbols.map(
    (s) => `${s.line}: ${s.exported ? "export " : ""}${s.kind} ${s.name} — ${s.signature}`
  );

  if (!fullyCovered) {
    lines.push(
      "",
      "⚠️  VARNING: denna fil innehåller top-level-kod som INTE syns ovan (markerad 'other' om den finns i listan, " +
        "eller på annat sätt okategoriserad). Outline är INTE en fullständig representation av filen. " +
        "Läs med full:true (+ reason) innan du skriver om filen med write_file, annars riskerar du att tappa bort kod."
    );
  }

  return lines.join("\n");
}

/**
 * Hämtar den fulla källkoden (inklusive body) för en namngiven top-level
 * symbol i en TS/JS-fil. Returnerar null om namnet inte hittas.
 */
export function extractTsSymbolSource(content: string, fileName: string, symbolName: string): string | null {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  let found: ts.Node | null = null;

  sourceFile.forEachChild((node) => {
    if (found) return;

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === symbolName
    ) {
      found = node;
    } else if (ts.isInterfaceDeclaration(node) && node.name.text === symbolName) {
      found = node;
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === symbolName) {
      found = node;
    } else if (ts.isEnumDeclaration(node) && node.name.text === symbolName) {
      found = node;
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          // Returnera hela statementet (inkl. "const"/"export" osv.), inte bara declaratorn.
          found = node;
        }
      }
    }
  });

  return found ? (found as ts.Node).getText(sourceFile) : null;
}

// ---------------------------------------------------------------------------
// JSON & YAML: alla nyckel-paths rekursivt, t.ex. foo.bar.baz, foo.bar, foo.
// Arrayer representeras med [i] i pathen. Samma logik funkar för båda
// formaten eftersom de bara skiljer sig i parsing (JSON.parse vs Bun.YAML.parse)
// — resultatet är samma typ av nästlad JS-data.
// ---------------------------------------------------------------------------

function keyPathsOf(data: unknown): string[] {
  const paths: string[] = [];

  function walk(value: unknown, prefix: string) {
    if (prefix) paths.push(prefix);

    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        walk(item, prefix ? `${prefix}[${i}]` : `[${i}]`);
      });
    } else if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const next = prefix ? `${prefix}.${key}` : key;
        walk((value as Record<string, unknown>)[key], next);
      }
    }
  }

  walk(data, "");
  return paths.filter((p) => p.length > 0);
}

function valueAtPath(data: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);

  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function extractJsonKeyPaths(content: string): string[] {
  return keyPathsOf(JSON.parse(content));
}

export function formatJsonOutline(paths: string[]): string {
  if (paths.length === 0) return "(inga nycklar hittades, troligen en primitiv top-level-värde)";
  return paths.join("\n");
}

export function extractYamlKeyPaths(content: string): string[] {
  return keyPathsOf(Bun.YAML.parse(content));
}

export function formatYamlOutline(paths: string[]): string {
  if (paths.length === 0) return "(inga nycklar hittades, troligen en primitiv top-level-värde)";
  return paths.join("\n");
}

/**
 * Hämtar värdet på en specifik key-path i en JSON-fil, t.ex. "foo.bar.baz"
 * eller "items[0].name". Returnerar undefined om pathen inte finns.
 */
export function extractJsonValueAtPath(content: string, path: string): unknown {
  return valueAtPath(JSON.parse(content), path);
}

/** Samma som extractJsonValueAtPath, men för YAML-filer. */
export function extractYamlValueAtPath(content: string, path: string): unknown {
  return valueAtPath(Bun.YAML.parse(content), path);
}

// ---------------------------------------------------------------------------
// Dispatcher: avgör om/hur en fil ska outline:as baserat på filändelse.
// ---------------------------------------------------------------------------

export type OutlineKind = "markdown" | "typescript" | "json" | "yaml" | null;

export function outlineKindForFile(fileName: string): OutlineKind {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mts" || ext === ".cts") {
    return "typescript";
  }
  if (ext === ".json" || ext === ".jsonc") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return null;
}

/** Bygger en outline-sträng för filinnehållet, enligt filtypens regler. */
export function buildOutline(content: string, fileName: string): string {
  const kind = outlineKindForFile(fileName);
  switch (kind) {
    case "markdown":
      return formatMarkdownOutline(extractMarkdownOutline(content));
    case "typescript":
      return formatTsOutline(extractTsOutline(content, fileName));
    case "json":
      return formatJsonOutline(extractJsonKeyPaths(content));
    case "yaml":
      return formatYamlOutline(extractYamlKeyPaths(content));
    case null:
      return content; // okänd filtyp: ingen outline, hela innehållet
  }
}
