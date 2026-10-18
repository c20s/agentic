import ts from "typescript";
import { extname } from "node:path";

// ---------------------------------------------------------------------------
// Markdown: list all headings (#, ##, ### etc.) with line numbers.
// ---------------------------------------------------------------------------

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number; // 1-indexed
}

export function extractMarkdownOutline(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip code blocks so we don't pick up "#" comments in e.g. bash/python.
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
  if (headings.length === 0) return "(no headings found)";
  return headings
    .map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text} (line ${h.line})`)
    .join("\n");
}

/**
 * Extracts an entire section from a markdown file: from a heading (matched by
 * text, case-insensitive substring) up to and including the line before the
 * next heading at the same or higher level. Returns null if no matching
 * heading is found.
 */
export function extractMarkdownSection(content: string, headingQuery: string): string | null {
  const headings = extractMarkdownOutline(content);
  const needle = headingQuery.toLowerCase();
  const idx = headings.findIndex((h) => h.text.toLowerCase().includes(needle));
  if (idx === -1) return null;

  const target = headings[idx]!;
  const next = headings.slice(idx + 1).find((h) => h.level <= target.level);
  const lines = content.split("\n");
  const startLine = target.line - 1; // 0-indexed
  const endLine = next ? next.line - 1 : lines.length;

  return lines.slice(startLine, endLine).join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// TypeScript/JavaScript: top-level const/function/interface/type/class/enum,
// with signature but without body. Built on the real TS AST, not regex.
// ---------------------------------------------------------------------------

export interface TsSymbol {
  kind: string; // "import" | "function" | "const" | "interface" | "type" | "class" | "enum" | "export" | "other"
  name: string;
  signature: string; // single line, no body
  line: number; // 1-indexed
  exported: boolean;
}

export interface TsOutlineResult {
  symbols: TsSymbol[];
  /**
   * true if every top-level statement in the file could be categorized as a
   * known symbol type ("other" does NOT count as fully categorized). false
   * means the outline does not give full coverage of the file — there is
   * top-level code (a loose expression, IIFE, etc.) that doesn't show up in
   * the outline list, and extra caution should be taken before rewriting the
   * file without reading it in full (full:true) first.
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

  // Builds a "header" string for a declaration: everything up to { or ;
  // but without the function/class/interface body.
  function headerOf(node: ts.Node): string {
    const full = node.getText(sourceFile);
    const bodyStart = full.indexOf("{");
    const header = bodyStart === -1 ? full : full.slice(0, bodyStart).trim();
    return header.replace(/\s+/g, " ").trim();
  }

  // Compresses a long line (e.g. a long import statement) into a readable one-line summary.
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
        // Signature: "const name: Type = <first line of initializer>" without body.
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
      // nothing to do, not a real statement
    } else {
      // Unknown top-level statement: loose expression, IIFE, bare console.log, etc.
      // This is EXACTLY the kind of code that outline would otherwise hide completely.
      fullyCovered = false;
      const text = oneLine(node);
      symbols.push({
        kind: "other",
        name: "(uncategorized code)",
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
  if (symbols.length === 0) return "(no top-level symbols found — likely an empty file)";

  const lines = symbols.map(
    (s) => `${s.line}: ${s.exported ? "export " : ""}${s.kind} ${s.name} — ${s.signature}`
  );

  if (!fullyCovered) {
    lines.push(
      "",
      "⚠️  WARNING: this file contains top-level code that is NOT shown above (marked 'other' if present in the " +
        "list, or otherwise uncategorized). The outline is NOT a complete representation of the file. " +
        "Read with full:true (+ reason) before rewriting the file with write_file, otherwise you risk losing code."
    );
  }

  return lines.join("\n");
}

/**
 * Extracts the full source code (including body) for a named top-level
 * symbol in a TS/JS file. Returns null if the name isn't found.
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

  // Matches an import declaration against symbolName in several reasonable ways:
  // - module path, exact or substring (e.g. "../domain/member.create" or "member.create")
  // - one of the imported names (e.g. "create" for `import { create } from "..."`)
  // - the default import's name
  function importMatches(node: ts.ImportDeclaration): boolean {
    const moduleText = node.moduleSpecifier.getText(sourceFile).replace(/^["']|["']$/g, "");
    if (moduleText === symbolName || moduleText.includes(symbolName)) return true;

    const clause = node.importClause;
    if (!clause) return false;
    if (clause.name?.text === symbolName) return true; // default import
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        return clause.namedBindings.name.text === symbolName;
      }
      if (ts.isNamedImports(clause.namedBindings)) {
        return clause.namedBindings.elements.some((el) => el.name.text === symbolName);
      }
    }
    return false;
  }

  sourceFile.forEachChild((node) => {
    if (found) return;

    if (ts.isImportDeclaration(node) && importMatches(node)) {
      found = node;
    } else if (ts.isImportEqualsDeclaration(node) && node.name.text === symbolName) {
      found = node;
    } else if (
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
          // Return the entire statement (incl. "const"/"export" etc.), not just the declarator.
          found = node;
        }
      }
    }
  });

  return found ? (found as ts.Node).getText(sourceFile) : null;
}

// ---------------------------------------------------------------------------
// JSON & YAML: all key paths recursively, e.g. foo.bar.baz, foo.bar, foo.
// Arrays are represented with [i] in the path. The same logic works for both
// formats since they only differ in parsing (JSON.parse vs Bun.YAML.parse)
// — the result is the same kind of nested JS data.
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
  if (paths.length === 0) return "(no keys found, likely a primitive top-level value)";
  return paths.join("\n");
}

export function extractYamlKeyPaths(content: string): string[] {
  return keyPathsOf(Bun.YAML.parse(content));
}

export function formatYamlOutline(paths: string[]): string {
  if (paths.length === 0) return "(no keys found, likely a primitive top-level value)";
  return paths.join("\n");
}

/**
 * Extracts the value at a specific key path in a JSON file, e.g. "foo.bar.baz"
 * or "items[0].name". Returns undefined if the path doesn't exist.
 */
export function extractJsonValueAtPath(content: string, path: string): unknown {
  return valueAtPath(JSON.parse(content), path);
}

/** Same as extractJsonValueAtPath, but for YAML files. */
export function extractYamlValueAtPath(content: string, path: string): unknown {
  return valueAtPath(Bun.YAML.parse(content), path);
}

// ---------------------------------------------------------------------------
// Dispatcher: decides if/how a file should be outlined based on its extension.
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

/** Builds an outline string for the file content, according to the file type's rules. */
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
      return content; // unknown file type: no outline, full content
  }
}
