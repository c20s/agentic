import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "./tools";
import type { Sandbox } from "./sandbox";
import { loadApmSkills } from "./context";

/**
 * `review_context`: builds the best-available context for reviewing some
 * change, in one call, optionally through the lens of one `.apm/skills`
 * skill (see `context.ts` — the same skills `get_context({ symbol: "skills" })`
 * lists). Five independent sources of "what changed":
 *
 * - `changes` — full diff of everything uncommitted (tracked edits + staged +
 *   untracked new files) vs HEAD in the sandboxed project.
 * - `commit`  — full diff of one commit vs its parent, plus that commit's
 *   message (its "description").
 * - `pr`      — full diff of a GitHub PR plus its description and every
 *   existing comment (both inline review comments and conversation
 *   comments), via the `gh` CLI.
 * - `branch`  — full diff of one branch vs its base, plus every commit in
 *   between and their messages ("comments" in the git sense).
 * - `files`   — the full content of an explicit list of files (absolute or
 *   sandbox-relative), no git history involved.
 *
 * All five render to the same `### file (status, +N -M)` / fenced-diff text
 * shape (see `renderDiffAsText`) so the rest of this tool, and whatever reads
 * its output, doesn't need to care which mode produced it.
 */

const MAX_INLINE_DIFF_LINES = 600;

const ALWAYS_COLLAPSE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /\.lock$/,
];

function isAlwaysCollapsed(file: string): boolean {
  return ALWAYS_COLLAPSE_PATTERNS.some((re) => re.test(file));
}

type DiffLineKind = "add" | "del" | "context";

interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file; absent for pure additions. */
  oldLine?: number;
  /** Line number in the new file; absent for pure deletions. */
  newLine?: number;
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface FileDiff {
  file: string;
  /** "unchanged" means this is a whole-file snapshot (no git refs given), not an actual diff. */
  status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
  renamedFrom?: string;
  additions: number;
  deletions: number;
  /** Set when the diff isn't inlined (too large, a lockfile, or binary) — hunks is then empty. */
  collapsedReason?: "too-large" | "lockfile" | "binary";
  hunks: DiffHunk[];
}

function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // skip diff/index/---/+++ preamble lines
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", oldLine, text: raw.slice(1) });
      oldLine += 1;
    } else if (raw.startsWith(" ") || raw === "") {
      current.lines.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // Lines like "\ No newline at end of file" are ignored.
  }
  return hunks;
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

type DiffRangeArgs = string[];

async function discoverChangedFiles(rangeArgs: DiffRangeArgs, cwd: string, includeUntracked: boolean): Promise<string[]> {
  const { stdout, exitCode, stderr } = await runGit(["diff", "--name-only", ...rangeArgs], cwd);
  if (exitCode !== 0) {
    throw new Error(`git diff --name-only failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  const tracked = stdout.split("\n").filter(Boolean);
  if (!includeUntracked) return tracked;

  // Untracked new files don't show up in `git diff` at all.
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  if (untracked.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${untracked.stderr.trim() || `exit code ${untracked.exitCode}`}`);
  }
  const untrackedFiles = untracked.stdout.split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untrackedFiles])];
}

async function getFileDiff(
  file: string,
  rangeArgs: DiffRangeArgs,
  sandbox: Sandbox,
  options: { treatUntrackedAsAdded: boolean }
): Promise<FileDiff> {
  if (options.treatUntrackedAsAdded) {
    const tracked = await runGit(["ls-files", "--error-unmatch", "--", file], sandbox.root);
    if (tracked.exitCode !== 0) {
      const snapshot = await getWholeFileSnapshot(file, sandbox);
      return { ...snapshot, status: "added" };
    }
  }

  const { stdout, exitCode, stderr } = await runGit(
    ["diff", "--unified=3", "--find-renames", ...rangeArgs, "--", file],
    sandbox.root
  );
  if (exitCode !== 0) {
    throw new Error(`git diff failed for ${file}: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  const additions = (stdout.match(/^\+[^+]/m) ?? []).length;
  const deletions = (stdout.match(/^-[^-]/m) ?? []).length;
  const isBinary = /^Binary files .* differ$/m.test(stdout);
  const renameMatch = stdout.match(/^rename from (.+)$/m);
  const status: FileDiff["status"] = /^deleted file mode/m.test(stdout)
    ? "deleted"
    : /^new file mode/m.test(stdout)
      ? "added"
      : renameMatch
        ? "renamed"
        : "modified";

  const base: FileDiff = {
    file,
    status,
    renamedFrom: renameMatch?.[1],
    additions,
    deletions,
    hunks: [],
  };

  if (isBinary) return { ...base, collapsedReason: "binary" };
  if (isAlwaysCollapsed(file)) return { ...base, collapsedReason: "lockfile" };
  if (additions + deletions > MAX_INLINE_DIFF_LINES) return { ...base, collapsedReason: "too-large" };

  return { ...base, hunks: parseUnifiedDiff(stdout) };
}

async function getWholeFileSnapshot(file: string, sandbox: Sandbox): Promise<FileDiff> {
  const abs = sandbox.resolve(file);
  let raw: string;
  try {
    raw = await readFile(abs, "utf-8");
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const base: FileDiff = { file, status: "unchanged", additions: 0, deletions: 0, hunks: [] };

  if (raw.includes("\0")) return { ...base, collapsedReason: "binary" };
  if (isAlwaysCollapsed(file)) return { ...base, collapsedReason: "lockfile" };

  const lines = raw.split("\n");
  if (lines.length > MAX_INLINE_DIFF_LINES) return { ...base, collapsedReason: "too-large" };

  const hunk: DiffHunk = {
    header: `@@ -1,${lines.length} +1,${lines.length} @@`,
    lines: lines.map((text, i) => ({ kind: "context" as const, oldLine: i + 1, newLine: i + 1, text })),
  };
  return { ...base, hunks: [hunk] };
}

function renderDiffAsText(diff: FileDiff): string {
  const header = `### ${diff.file} (${diff.status}${diff.status === "unchanged" ? "" : `, +${diff.additions} -${diff.deletions}`})`;
  if (diff.collapsedReason) {
    return `${header}\n[collapsed: ${diff.collapsedReason} — not shown]\n`;
  }
  const body = diff.hunks
    .map((hunk) => {
      const lines = hunk.lines.map((line) => {
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        const lineNo = line.kind === "del" ? line.oldLine : line.newLine;
        return `${String(lineNo ?? "").padStart(5)} ${marker} ${line.text}`;
      });
      return `${hunk.header}\n${lines.join("\n")}`;
    })
    .join("\n");
  return `${header}\n\`\`\`\n${body}\n\`\`\`\n`;
}

/** Resolves a skill by name from `.apm/skills`, or throws listing the valid names. */
function resolveSkill(skill: string | undefined): { skill: string; body: string } | undefined {
  if (!skill) return undefined;
  const skills = loadApmSkills();
  const found = skills.find((s) => s.name === skill);
  if (!found) {
    const available = skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none found under .apm/skills)";
    throw new Error(`Unknown skill "${skill}". Available skills: ${available}.`);
  }
  const refsNote =
    found.references.length > 0
      ? `\n\n---\nReferences for this skill (fetch with get_context({ symbol: "${found.name}/references/<file>" })): ` +
        found.references.join(", ")
      : "";
  return { skill: found.name, body: found.body + refsNote };
}

const PR_URL_PATTERN = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const match = url.match(PR_URL_PATTERN);
  if (!match) {
    throw new Error(`"${url}" doesn't look like a GitHub PR URL (expected .../<owner>/<repo>/pull/<number>).`);
  }
  const [, owner, repo, numberStr] = match;
  return { owner: owner!, repo: repo!, number: Number(numberStr) };
}

interface GhIssueComment {
  user?: { login?: string };
  body?: string;
  created_at?: string;
}

interface GhReviewComment {
  user?: { login?: string };
  body?: string;
  path?: string;
  line?: number | null;
  created_at?: string;
}

async function ghApi<T>(path: string): Promise<T> {
  const { stdout, exitCode, stderr } = await runGh(["api", path]);
  if (exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  return JSON.parse(stdout) as T;
}

function renderComments(title: string, comments: { author: string; body: string; location?: string }[]): string {
  if (comments.length === 0) return `${title}: none.\n`;
  const rendered = comments
    .map((c) => `- **${c.author}**${c.location ? ` on \`${c.location}\`` : ""}:\n  ${c.body.replace(/\n/g, "\n  ")}`)
    .join("\n");
  return `${title} (${comments.length}):\n\n${rendered}\n`;
}

const reviewContextSchema = z.object({
  mode: z
    .enum(["changes", "commit", "pr", "branch", "files"])
    .describe(
      "What to build context for: 'changes' = everything uncommitted in the sandboxed project right now " +
        "(tracked edits + staged + untracked new files) vs HEAD. 'commit' = one commit's diff vs its parent, " +
        "plus its commit message (needs 'commit'). 'pr' = a GitHub pull request's full diff, description, and " +
        "every existing comment, fetched via the 'gh' CLI (needs 'prUrl'). 'branch' = a branch's diff vs its " +
        "base, plus every commit in between and their messages (needs 'branch', optionally 'baseRef'). " +
        "'files' = the full current content of an explicit file list, no git history involved (needs 'files')."
    ),
  commit: z.string().optional().describe("Commit SHA or ref, required when mode is 'commit' (e.g. 'a1b2c3d' or 'HEAD~2')."),
  prUrl: z.string().optional().describe("GitHub pull request URL, required when mode is 'pr' (e.g. 'https://github.com/owner/repo/pull/123')."),
  branch: z.string().optional().describe("Branch to diff, required when mode is 'branch' (e.g. 'feature/x')."),
  baseRef: z.string().optional().describe("Base ref 'branch' is compared against, e.g. 'main' or 'origin/main'. Defaults to 'main' if omitted."),
  files: z
    .array(z.string())
    .optional()
    .describe("File paths (absolute, or relative to the sandbox root), required when mode is 'files'."),
  skill: z
    .string()
    .optional()
    .describe(
      "Optional .apm/skills skill name to apply to the diff (e.g. one returned by " +
        "get_context({ symbol: 'skills' })). Its full instructions are appended to the output so the " +
        "agent can review the context through that lens. Omit to get the raw context with no checklist."
    ),
});

export const reviewContextTool: ToolDefinition<typeof reviewContextSchema> = {
  name: "review_context",
  description:
    "Builds the best available context for reviewing a change, in one call: 'changes' (everything " +
    "uncommitted), 'commit' (one commit's diff + message), 'pr' (a GitHub PR's diff + description + " +
    "comments), 'branch' (a branch vs its base, + every commit message in between), or 'files' (full " +
    "content of an explicit file list). Optionally pass 'skill' (see get_context({ symbol: 'skills' })) " +
    "to append that skill's full instructions to apply while reviewing.",
  inputSchema: reviewContextSchema,
  handler: async ({ mode, commit, prUrl, branch, baseRef, files, skill }, sandbox) => {
    const resolvedSkill = resolveSkill(skill);

    const renderWithSkill = (title: string, body: string): string => {
      const skillSection = resolvedSkill
        ? `\n# Skill to apply: ${resolvedSkill.skill}\n\n${resolvedSkill.body}\n`
        : "";
      return `# ${title}\n\n${body}${skillSection}`;
    };

    if (mode === "changes") {
      const rangeArgs = ["HEAD"];
      const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, true);
      if (changedFiles.length === 0) return "No uncommitted changes found.";
      const diffs = await Promise.all(
        changedFiles.map((file) => getFileDiff(file, rangeArgs, sandbox, { treatUntrackedAsAdded: true }))
      );
      const body = diffs.map(renderDiffAsText).join("\n");
      return renderWithSkill(`Uncommitted changes (${changedFiles.length} file(s))`, body);
    }

    if (mode === "commit") {
      if (!commit) return "Error: 'commit' is required when mode is 'commit'.";
      const msg = await runGit(["log", "-1", "--pretty=format:%H%n%an <%ae>%n%ad%n%n%s%n%n%b", commit], sandbox.root);
      if (msg.exitCode !== 0) {
        return `Error: could not read commit ${commit}: ${msg.stderr.trim() || `exit code ${msg.exitCode}`}`;
      }
      const rangeArgs = [`${commit}^..${commit}`];
      const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, false);
      if (changedFiles.length === 0) return `Commit ${commit} has no file changes.`;
      const diffs = await Promise.all(
        changedFiles.map((file) => getFileDiff(file, rangeArgs, sandbox, { treatUntrackedAsAdded: false }))
      );
      const body = `Commit message:\n\n${msg.stdout.trim()}\n\n${diffs.map(renderDiffAsText).join("\n")}`;
      return renderWithSkill(`Commit ${commit} (${changedFiles.length} file(s))`, body);
    }

    if (mode === "branch") {
      if (!branch) return "Error: 'branch' is required when mode is 'branch'.";
      const base = baseRef ?? "main";
      const rangeArgs = [`${base}...${branch}`];
      const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, false);
      if (changedFiles.length === 0) return `No changes between ${base} and ${branch}.`;
      const diffs = await Promise.all(
        changedFiles.map((file) => getFileDiff(file, rangeArgs, sandbox, { treatUntrackedAsAdded: false }))
      );
      const log = await runGit(["log", "--pretty=format:- %h %s (%an)", `${base}..${branch}`], sandbox.root);
      if (log.exitCode !== 0) {
        return `Error: could not list commits between ${base} and ${branch}: ${log.stderr.trim() || `exit code ${log.exitCode}`}`;
      }
      const body =
        `Commits in ${branch} not in ${base}:\n\n${log.stdout.trim() || "(none)"}\n\n` +
        `${diffs.map(renderDiffAsText).join("\n")}`;
      return renderWithSkill(`Branch ${branch} vs ${base} (${changedFiles.length} file(s))`, body);
    }

    if (mode === "files") {
      if (!files || files.length === 0) return "Error: 'files' is required (and non-empty) when mode is 'files'.";
      const diffs = await Promise.all(files.map((file) => getWholeFileSnapshot(file, sandbox)));
      const body = diffs.map(renderDiffAsText).join("\n");
      return renderWithSkill(`Files (${files.length})`, body);
    }

    // mode === "pr"
    if (!prUrl) return "Error: 'prUrl' is required when mode is 'pr'.";
    const { owner, repo, number } = parsePrUrl(prUrl);
    const repoSlug = `${owner}/${repo}`;

    const diffResult = await runGh(["pr", "diff", prUrl]);
    if (diffResult.exitCode !== 0) {
      return `Error: gh pr diff failed: ${diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`}. Is 'gh' installed and authenticated?`;
    }

    let pr: { title: string; body: string; author: { login: string }; url: string; baseRefName: string; headRefName: string };
    try {
      const view = await runGh(["pr", "view", prUrl, "--json", "title,body,author,url,baseRefName,headRefName"]);
      if (view.exitCode !== 0) {
        throw new Error(view.stderr.trim() || `exit code ${view.exitCode}`);
      }
      pr = JSON.parse(view.stdout);
    } catch (err) {
      return `Error: gh pr view failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    let issueComments: GhIssueComment[] = [];
    let reviewComments: GhReviewComment[] = [];
    try {
      [issueComments, reviewComments] = await Promise.all([
        ghApi<GhIssueComment[]>(`repos/${repoSlug}/issues/${number}/comments`),
        ghApi<GhReviewComment[]>(`repos/${repoSlug}/pulls/${number}/comments`),
      ]);
    } catch (err) {
      return `Error: could not fetch PR comments: ${err instanceof Error ? err.message : String(err)}`;
    }

    const conversationSection = renderComments(
      "Conversation comments",
      issueComments.map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "" }))
    );
    const reviewSection = renderComments(
      "Inline review comments",
      reviewComments.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        location: c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : undefined,
      }))
    );

    const body =
      `**${pr.title}** by @${pr.author.login} — ${pr.headRefName} -> ${pr.baseRefName}\n${pr.url}\n\n` +
      `Description:\n\n${pr.body?.trim() || "(no description)"}\n\n` +
      `${conversationSection}\n${reviewSection}\n` +
      `Diff:\n\n${diffResult.stdout}`;

    return renderWithSkill(`PR ${repoSlug}#${number}`, body);
  },
};

export const reviewTools = [reviewContextTool];
