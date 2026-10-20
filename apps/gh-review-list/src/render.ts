import type { EnrichedPullRequest } from "./types";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function color(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function approvedIcon(pr: EnrichedPullRequest): string {
  if (pr.reviewDecision === "APPROVED") return color(GREEN, "✓");
  if (pr.reviewDecision === "CHANGES_REQUESTED") return color(RED, "✗");
  return color(YELLOW, "◷");
}

function commentIcon(pr: EnrichedPullRequest): string {
  if (pr.commentedByMe && pr.updatedSinceMyComment) return color(RED, "💬!");
  if (pr.commentedByMe) return color(CYAN, "💬");
  return color(DIM, "—");
}

/** Visible width of a string, treating common emoji as width 2 (good enough for our fixed icon set). */
function displayWidth(text: string): number {
  // Strip ANSI escapes before measuring.
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf) || code === 0x2b50;
    width += isWide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + " ".repeat(diff) : text;
}

function truncate(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let result = "";
  let width = 0;
  for (const ch of text) {
    const chWidth = displayWidth(ch);
    if (width + chWidth > maxWidth - 1) break;
    result += ch;
    width += chWidth;
  }
  return `${result}…`;
}

function hyperlink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

interface Column {
  header: string;
  width: number;
  get: (pr: EnrichedPullRequest) => string;
}

function buildColumns(prs: EnrichedPullRequest[], mode: "team" | "mine"): Column[] {
  const prLabelWidth = Math.max(
    6,
    ...prs.map((pr) => displayWidth(`#${pr.number}`))
  );
  const repoWidth = Math.max(4, ...prs.map((pr) => displayWidth(pr.repository)), 20);
  const authorWidth = Math.max(6, ...prs.map((pr) => displayWidth(pr.author)));
  const dateWidth = 10;
  const titleWidth = 50;

  const cols: Column[] = [
    { header: " ", width: 1, get: approvedIcon },
    { header: " ", width: 3, get: commentIcon },
    {
      header: "PR",
      width: prLabelWidth,
      get: (pr) => hyperlink(pr.url, `#${pr.number}`),
    },
    { header: "Repository", width: Math.min(repoWidth, 30), get: (pr) => truncate(pr.repository, 30) },
  ];
  if (mode === "team") {
    cols.push({ header: "Author", width: Math.min(authorWidth, 16), get: (pr) => truncate(pr.author, 16) });
  }
  cols.push(
    { header: "Created", width: dateWidth, get: (pr) => pr.createdAt.slice(0, 10) },
    { header: "Title", width: titleWidth, get: (pr) => truncate(pr.title, titleWidth) }
  );
  return cols;
}

function formatHeader(cols: Column[]): string {
  return color(BOLD, cols.map((c) => pad(c.header, c.width)).join("  "));
}

function formatRow(cols: Column[], pr: EnrichedPullRequest): string {
  return cols.map((c) => pad(c.get(pr), c.width)).join("  ");
}

function ruleWidth(cols: Column[]): number {
  return cols.reduce((sum, c) => sum + c.width, 0) + 2 * (cols.length - 1);
}

function renderTable(title: string, prs: EnrichedPullRequest[], mode: "team" | "mine"): string {
  const heading = color(BOLD, title);
  if (prs.length === 0) return `${heading}\n  ${color(DIM, "(none)")}`;
  const cols = buildColumns(prs, mode);
  const lines = [
    heading,
    formatHeader(cols),
    color(DIM, "─".repeat(ruleWidth(cols))),
    ...prs.map((pr) => formatRow(cols, pr)),
    "",
    color(DIM, `Total: ${prs.length} open PR${prs.length === 1 ? "" : "s"}`),
  ];
  return lines.join("\n");
}

const LEGEND = [
  color(BOLD, "Legend"),
  `  ${color(GREEN, "✓")} Approved`,
  `  ${color(RED, "✗")} Changes requested`,
  `  ${color(YELLOW, "◷")} Not reviewed yet`,
  `  ${color(RED, "💬!")} Commented (updated since)`,
  `  ${color(CYAN, "💬")} Commented`,
  `  ${color(DIM, "—")} No comments`,
].join("\n");

export function renderReviewList(result: {
  mine: EnrichedPullRequest[];
  authored: EnrichedPullRequest[];
  team: EnrichedPullRequest[];
  login: string;
  fromCache: boolean;
}): string {
  const grandTotal = result.team.length + result.mine.length + result.authored.length;
  const parts = [
    renderTable("Team PRs", result.team, "team"),
    "",
    renderTable("My PRs (Assigned or Reviewed)", result.mine, "mine"),
    "",
    renderTable("My authored PRs", result.authored, "mine"),
    "",
    color(BOLD, `Grand Total: ${grandTotal} open PR${grandTotal === 1 ? "" : "s"}`) +
      color(DIM, `  — as ${result.login}`) +
      (result.fromCache ? color(DIM, "  (cached)") : ""),
    "",
    LEGEND,
  ];
  return parts.join("\n");
}
