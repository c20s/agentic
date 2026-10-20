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

// Unicode code point ranges for the emoji this table actually renders (💬, ✓, ✗, ◷, —, ⭐-style
// icons), each displayed as 2 terminal columns wide. Not a general-purpose emoji-width table —
// just enough to cover this file's fixed icon set:
//   0x1F300–0x1FAFF  Miscellaneous Symbols & Pictographs, Emoticons, Transport, Supplemental
//                     Symbols & Pictographs (covers 💬)
//   0x2600–0x27BF    Miscellaneous Symbols & Dingbats (covers ✓ ✗ ◷)
//   0x2B50           STAR (⭐), kept as its own case since it falls outside both ranges above
const WIDE_EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f300, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b50, 0x2b50],
];

function isWideEmoji(codePoint: number): boolean {
  return WIDE_EMOJI_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** Visible width of a string, treating common emoji as width 2 (good enough for our fixed icon set). */
function displayWidth(text: string): number {
  // Strip ANSI SGR color codes and OSC-8 hyperlink escapes (`\x1b]8;;url\x1b\`...`\x1b]8;;\x1b\`)
  // before measuring — otherwise a hyperlinked cell's URL gets counted as visible text, throwing
  // off padding for every column after it.
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWideEmoji(code) ? 2 : 1;
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

// Column width tuning: each column gets a MIN width (so headers/short values don't look cramped)
// and, for the free-text ones, a MAX width (so one long repo name/title/author doesn't blow out
// the whole table) — the actual width used is clamped between the two, based on the widest value
// actually present in `prs`.
const MIN_PR_LABEL_WIDTH = 6; // fits "#12345" comfortably
const MIN_REPO_WIDTH = 4;
const MAX_REPO_WIDTH = 30;
const MIN_AUTHOR_WIDTH = 6;
const MAX_AUTHOR_WIDTH = 16;
const DATE_WIDTH = 10; // fixed: "YYYY-MM-DD"
const TITLE_WIDTH = 50;

function buildColumns(prs: EnrichedPullRequest[], mode: "team" | "mine"): Column[] {
  const prLabelWidth = Math.max(MIN_PR_LABEL_WIDTH, ...prs.map((pr) => displayWidth(`#${pr.number}`)));
  const repoWidth = Math.max(MIN_REPO_WIDTH, ...prs.map((pr) => displayWidth(pr.repository)), MAX_REPO_WIDTH);
  const authorWidth = Math.max(MIN_AUTHOR_WIDTH, ...prs.map((pr) => displayWidth(pr.author)));

  const cols: Column[] = [
    { header: " ", width: 1, get: approvedIcon },
    { header: " ", width: 3, get: commentIcon },
    {
      header: "PR",
      width: prLabelWidth,
      get: (pr) => hyperlink(pr.url, `#${pr.number}`),
    },
    {
      header: "Repository",
      width: Math.min(repoWidth, MAX_REPO_WIDTH),
      get: (pr) => truncate(pr.repository, MAX_REPO_WIDTH),
    },
  ];
  if (mode === "team") {
    cols.push({
      header: "Author",
      width: Math.min(authorWidth, MAX_AUTHOR_WIDTH),
      get: (pr) => truncate(pr.author, MAX_AUTHOR_WIDTH),
    });
  }
  cols.push(
    { header: "Created", width: DATE_WIDTH, get: (pr) => pr.createdAt.slice(0, 10) },
    { header: "Title", width: TITLE_WIDTH, get: (pr) => truncate(pr.title, TITLE_WIDTH) }
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
