import { z } from "zod";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "./tools";
import type { Sandbox } from "./sandbox";
import { loadApmSkills } from "./context";

/**
 * `review_context`: builds the best-available context for reviewing some
 * change, in one call, optionally through the lens of one `.apm/skills`
 * skill (see `context.ts` — the same skills `get_context({ symbol: "skills" })`
 * lists). Five independent sources of "what changed":
 *
 * - `changes` — full diff of everything uncommitted vs HEAD in the sandboxed project.
 * - `commit`  — full diff of one commit vs its parent, plus its message.
 * - `pr`      — a GitHub PR's description and comments via `gh`, plus a
 *   fresh `gh repo clone`/`gh pr checkout` of its repo (assumed unrelated
 *   to the sandboxed project) and a stat-only file-change summary.
 * - `branch`  — commits between a branch and its base, plus a `git worktree`
 *   checkout of that branch (assumed to belong to the sandboxed repo) and a
 *   stat-only file-change summary.
 * - `files`   — the full content of an explicit list of files, no git history.
 *
 * `changes`/`commit`/`files` render full diffs inline (see `renderDiffAsText`).
 * `pr`/`branch` return a checkout path instead — their diffs can be too
 * large to inline — under `renderCheckoutSummary`/`REVIEWS_ROOT`.
 */

const REVIEWS_ROOT = join(homedir(), ".config", "c20s", "reviews");

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ref";
}

function remoteMatchesRepo(remoteUrl: string, owner: string, repo: string): boolean {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) return false;
  const [, matchedOwner, matchedRepo] = match;
  return matchedOwner?.toLowerCase() === owner.toLowerCase() && matchedRepo?.toLowerCase() === repo.toLowerCase();
}

async function createWorktree(
  cwd: string,
  ref: string,
  label: string
): Promise<{ path: string; error?: string }> {
  await mkdir(REVIEWS_ROOT, { recursive: true });
  const path = join(REVIEWS_ROOT, slugify(label));

  if (existsSync(path)) {
    const list = await runGit(["worktree", "list", "--porcelain"], cwd);
    const isKnownWorktree = list.stdout.split("\n").some((line) => line === `worktree ${path}`);
    if (isKnownWorktree) {
      const checkout = await runGit(["checkout", "--detach", "--force", ref], path);
      if (checkout.exitCode !== 0) {
        return { path, error: `git checkout ${ref} failed in existing worktree: ${checkout.stderr.trim()}` };
      }
      const reset = await runGit(["reset", "--hard", ref], path);
      if (reset.exitCode !== 0) {
        return { path, error: `git reset --hard ${ref} failed in existing worktree: ${reset.stderr.trim()}` };
      }
      return { path };
    }
    return {
      path,
      error: `${path} already exists and isn't a worktree of this repo. Remove it manually (or pick a different branch/PR) and retry.`,
    };
  }

  const add = await runGit(["worktree", "add", "--detach", "--force", path, ref], cwd);
  if (add.exitCode !== 0) {
    return { path, error: `git worktree add failed: ${add.stderr.trim() || `exit code ${add.exitCode}`}` };
  }
  return { path };
}

async function clonePr(pr: { owner: string; repo: string; number: number; label: string }): Promise<{ path: string; error?: string }> {
  const { owner, repo, number, label } = pr;
  await mkdir(REVIEWS_ROOT, { recursive: true });
  const path = join(REVIEWS_ROOT, slugify(label));
  const repoSlug = `${owner}/${repo}`;

  if (!existsSync(path)) {
    const clone = await runGh(["repo", "clone", repoSlug, path]);
    if (clone.exitCode !== 0) {
      await rm(path, { recursive: true, force: true });
      return { path, error: `gh repo clone ${repoSlug} failed: ${clone.stderr.trim() || `exit code ${clone.exitCode}`}` };
    }
  } else {
    const remote = await runGit(["remote", "get-url", "origin"], path);
    if (remote.exitCode !== 0 || !remoteMatchesRepo(remote.stdout, owner, repo)) {
      return {
        path,
        error: `${path} already exists and isn't a clone of ${repoSlug}. Remove it manually (or pick a different PR) and retry.`,
      };
    }
  }

  const checkout = await runCommand("gh", ["pr", "checkout", String(number), "--force"], { cwd: path });
  if (checkout.exitCode !== 0) {
    return { path, error: `gh pr checkout ${number} failed: ${checkout.stderr.trim() || `exit code ${checkout.exitCode}`}` };
  }
  return { path };
}

function renderDiffStat(diffs: FileDiff[]): string {
  if (diffs.length === 0) return "(no changed files)";
  return diffs
    .map((d) => {
      const rename = d.renamedFrom ? ` (was ${d.renamedFrom})` : "";
      return `- ${d.file}${rename} — ${d.status}, +${d.additions} -${d.deletions}`;
    })
    .join("\n");
}

async function renderCheckoutSummary(
  cwd: string,
  prefetch: [remote: string, ref: string] | undefined,
  rangeArgs: DiffRangeArgs,
  diffCommandHint: string
): Promise<string> {
  const instructions =
    `Checked out at: ${cwd}\n` +
    `Run \`git diff ${diffCommandHint}\` (or read files directly) from that path to see the actual changes — ` +
    `it isn't under this sandbox's root, so use your own filesystem/shell tools there, not this server's sandboxed ones.\n`;

  if (prefetch) {
    const [remote, ref] = prefetch;
    const fetch = await runGit(["fetch", remote, ref, "--force"], cwd);
    if (fetch.exitCode !== 0) {
      return `${instructions}(could not fetch ${ref} to compute a file-change summary: ${fetch.stderr.trim() || `exit code ${fetch.exitCode}`} — diff it manually from the checkout)\n`;
    }
  }

  const changedFiles = await discoverChangedFiles(rangeArgs, cwd, false);
  const stats = await getDiffStats(changedFiles, rangeArgs, cwd);
  return `${instructions}Changed files (${changedFiles.length}):\n\n${renderDiffStat(stats)}\n`;
}

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

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawns `bin args...`, collects stdout/stderr fully, and waits for exit — shared by `runGit`/`runGh`. */
async function runCommand(bin: string, args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
  const proc = Bun.spawn([bin, ...args], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return runCommand("git", args, { cwd });
}

function runGh(args: string[]): Promise<CommandResult> {
  return runCommand("gh", args);
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

/** True if `file` isn't tracked by git at all (i.e. `git ls-files` doesn't know about it). */
async function isUntracked(file: string, sandbox: Sandbox): Promise<boolean> {
  const tracked = await runGit(["ls-files", "--error-unmatch", "--", file], sandbox.root);
  return tracked.exitCode !== 0;
}

async function getFileDiff(
  file: string,
  rangeArgs: DiffRangeArgs,
  sandbox: Sandbox,
  options: { treatUntrackedAsAdded: boolean }
): Promise<FileDiff> {
  if (options.treatUntrackedAsAdded && (await isUntracked(file, sandbox))) {
    const snapshot = await getWholeFileSnapshot(file, sandbox);
    return { ...snapshot, status: "added" };
  }

  const meta = await getFileDiffMeta(file, rangeArgs, sandbox.root);

  const base: FileDiff = {
    file,
    status: meta.status,
    renamedFrom: meta.renamedFrom,
    additions: meta.additions,
    deletions: meta.deletions,
    hunks: [],
  };

  if (meta.isBinary) {
    return { ...base, collapsedReason: "binary" };
  }
  if (isAlwaysCollapsed(file)) {
    return { ...base, collapsedReason: "lockfile" };
  }
  if (meta.additions + meta.deletions > MAX_INLINE_DIFF_LINES) {
    return { ...base, collapsedReason: "too-large" };
  }

  const { stdout, exitCode, stderr } = await runGit(
    ["diff", "--unified=3", "--find-renames", ...rangeArgs, "--", file],
    sandbox.root
  );
  if (exitCode !== 0) {
    throw new Error(`git diff failed for ${file}: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  return { ...base, hunks: parseUnifiedDiff(stdout) };
}

interface FileDiffMeta {
  status: FileDiff["status"];
  renamedFrom?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

async function getFileDiffMeta(file: string, rangeArgs: DiffRangeArgs, cwd: string): Promise<FileDiffMeta> {
  const [numstat, nameStatus] = await Promise.all([
    runGit(["diff", "--numstat", ...rangeArgs, "--", file], cwd),
    runGit(["diff", "--name-status", "-M", ...rangeArgs, "--", file], cwd),
  ]);
  if (numstat.exitCode !== 0) {
    throw new Error(`git diff --numstat failed for ${file}: ${numstat.stderr.trim() || `exit code ${numstat.exitCode}`}`);
  }
  if (nameStatus.exitCode !== 0) {
    throw new Error(
      `git diff --name-status failed for ${file}: ${nameStatus.stderr.trim() || `exit code ${nameStatus.exitCode}`}`
    );
  }

  const numstatFields = numstat.stdout.trim().split("\t");
  const isBinary = numstatFields[0] === "-" && numstatFields[1] === "-";
  const additions = isBinary ? 0 : Number(numstatFields[0] ?? 0);
  const deletions = isBinary ? 0 : Number(numstatFields[1] ?? 0);

  const nameStatusFields = nameStatus.stdout.trim().split("\t");
  const statusCode = nameStatusFields[0] ?? "";
  const renamedFrom = statusCode.startsWith("R") ? nameStatusFields[1] : undefined;
  const status: FileDiff["status"] = statusCode.startsWith("D")
    ? "deleted"
    : statusCode.startsWith("A")
      ? "added"
      : statusCode.startsWith("R")
        ? "renamed"
        : "modified";

  return { status, renamedFrom, additions, deletions, isBinary };
}

async function getDiffStats(files: string[], rangeArgs: DiffRangeArgs, cwd: string): Promise<FileDiff[]> {
  return Promise.all(
    files.map(async (file) => {
      const meta = await getFileDiffMeta(file, rangeArgs, cwd);
      return {
        file,
        status: meta.status,
        renamedFrom: meta.renamedFrom,
        additions: meta.additions,
        deletions: meta.deletions,
        hunks: [],
      };
    })
  );
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
  if (!skill) {
    return undefined;
  }
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
  if (owner === undefined || repo === undefined || numberStr === undefined) {
    throw new Error(`Internal error: PR_URL_PATTERN matched "${url}" without all three capture groups.`);
  }
  return { owner, repo, number: Number(numberStr) };
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

const ghPrViewSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  author: z.object({ login: z.string() }),
  url: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
});

type GhPrView = z.infer<typeof ghPrViewSchema>;

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
        "plus its commit message (needs 'commit'). 'pr' = a GitHub pull request's description, every existing " +
        "comment, and a file-change summary, fetched via the 'gh' CLI (needs 'prUrl') — ALWAYS use this mode " +
        "for a github.com '.../pull/123' link, never web_fetch/web_search (they can't see the actual diff). " +
        "The PR's repo (assumed possibly unrelated to the sandboxed project) is cloned fresh via 'gh' and its " +
        "head checked out on disk, and that clone's path is returned, since full PR diffs can be too large " +
        "to inline. 'branch' = every commit between a branch and its base and their messages, plus the same " +
        "kind of worktree + file-change summary (needs 'branch', optionally 'baseRef'). " +
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

type ReviewContextInput =
  | { mode: "changes"; skill?: string }
  | { mode: "commit"; commit: string; skill?: string }
  | { mode: "pr"; prUrl: string; skill?: string }
  | { mode: "branch"; branch: string; baseRef?: string; skill?: string }
  | { mode: "files"; files: string[]; skill?: string };

function narrowReviewContextInput(input: z.infer<typeof reviewContextSchema>): ReviewContextInput {
  switch (input.mode) {
    case "changes":
      return { mode: "changes", skill: input.skill };
    case "commit":
      if (!input.commit) {
        throw new Error("'commit' is required when mode is 'commit'.");
      }
      return { mode: "commit", commit: input.commit, skill: input.skill };
    case "pr":
      if (!input.prUrl) {
        throw new Error("'prUrl' is required when mode is 'pr'.");
      }
      return { mode: "pr", prUrl: input.prUrl, skill: input.skill };
    case "branch":
      if (!input.branch) {
        throw new Error("'branch' is required when mode is 'branch'.");
      }
      return { mode: "branch", branch: input.branch, baseRef: input.baseRef, skill: input.skill };
    case "files":
      if (!input.files || input.files.length === 0) {
        throw new Error("'files' is required (and non-empty) when mode is 'files'.");
      }
      return { mode: "files", files: input.files, skill: input.skill };
  }
}

function renderWithSkill(resolvedSkill: ReturnType<typeof resolveSkill>, title: string, body: string): string {
  const skillSection = resolvedSkill ? `\n# Skill to apply: ${resolvedSkill.skill}\n\n${resolvedSkill.body}\n` : "";
  return `# ${title}\n\n${body}${skillSection}`;
}

async function handleChangesMode(sandbox: Sandbox, resolvedSkill: ReturnType<typeof resolveSkill>): Promise<string> {
  const rangeArgs = ["HEAD"];
  const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, true);
  if (changedFiles.length === 0) {
    return "No uncommitted changes found.";
  }
  const diffs = await Promise.all(
    changedFiles.map((file) => getFileDiff(file, rangeArgs, sandbox, { treatUntrackedAsAdded: true }))
  );
  const body = diffs.map(renderDiffAsText).join("\n");
  return renderWithSkill(resolvedSkill, `Uncommitted changes (${changedFiles.length} file(s))`, body);
}

async function handleCommitMode(
  commit: string,
  sandbox: Sandbox,
  resolvedSkill: ReturnType<typeof resolveSkill>
): Promise<string> {
  const msg = await runGit(["log", "-1", "--pretty=format:%H%n%an <%ae>%n%ad%n%n%s%n%n%b", commit], sandbox.root);
  if (msg.exitCode !== 0) {
    return `Error: could not read commit ${commit}: ${msg.stderr.trim() || `exit code ${msg.exitCode}`}`;
  }
  const rangeArgs = [`${commit}^..${commit}`];
  const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, false);
  if (changedFiles.length === 0) {
    return `Commit ${commit} has no file changes.`;
  }
  const diffs = await Promise.all(
    changedFiles.map((file) => getFileDiff(file, rangeArgs, sandbox, { treatUntrackedAsAdded: false }))
  );
  const body = `Commit message:\n\n${msg.stdout.trim()}\n\n${diffs.map(renderDiffAsText).join("\n")}`;
  return renderWithSkill(resolvedSkill, `Commit ${commit} (${changedFiles.length} file(s))`, body);
}

async function handleBranchMode(
  branch: string,
  baseRef: string | undefined,
  sandbox: Sandbox,
  resolvedSkill: ReturnType<typeof resolveSkill>
): Promise<string> {
  const base = baseRef ?? "main";
  const rangeArgs = [`${base}...${branch}`];
  const changedFiles = await discoverChangedFiles(rangeArgs, sandbox.root, false);
  if (changedFiles.length === 0) {
    return `No changes between ${base} and ${branch}.`;
  }
  const log = await runGit(["log", "--pretty=format:- %h %s (%an)", `${base}..${branch}`], sandbox.root);
  if (log.exitCode !== 0) {
    return `Error: could not list commits between ${base} and ${branch}: ${log.stderr.trim() || `exit code ${log.exitCode}`}`;
  }

  const worktree = await createWorktree(sandbox.root, branch, branch);
  const checkoutSection = worktree.error
    ? `Checkout: could not create one — ${worktree.error}\n`
    : await renderCheckoutSummary(worktree.path, undefined, rangeArgs, `${base}...${branch}`);

  const body = `Commits in ${branch} not in ${base}:\n\n${log.stdout.trim() || "(none)"}\n\n${checkoutSection}`;
  return renderWithSkill(resolvedSkill, `Branch ${branch} vs ${base} (${changedFiles.length} file(s))`, body);
}

async function handleFilesMode(
  files: string[],
  sandbox: Sandbox,
  resolvedSkill: ReturnType<typeof resolveSkill>
): Promise<string> {
  const diffs = await Promise.all(files.map((file) => getWholeFileSnapshot(file, sandbox)));
  const body = diffs.map(renderDiffAsText).join("\n");
  return renderWithSkill(resolvedSkill, `Files (${files.length})`, body);
}

async function handlePrMode(prUrl: string, resolvedSkill: ReturnType<typeof resolveSkill>): Promise<string> {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const repoSlug = `${owner}/${repo}`;

  const viewResult = await runGh(["pr", "view", prUrl, "--json", "title,body,author,url,baseRefName,headRefName"]);

  let pr: GhPrView;
  try {
    if (viewResult.exitCode !== 0) {
      throw new Error(viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`);
    }
    pr = ghPrViewSchema.parse(JSON.parse(viewResult.stdout));
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

  const label = `${slugify(pr.headRefName)}-${number}`;
  const clone = await clonePr({ owner, repo, number, label });
  const checkoutSection = clone.error
    ? `Checkout: could not create one — ${clone.error}\n`
    : await renderCheckoutSummary(
        clone.path,
        ["origin", pr.baseRefName],
        ["FETCH_HEAD...HEAD"],
        `origin/${pr.baseRefName}...HEAD`
      );

  const body =
    `**${pr.title}** by @${pr.author.login} — ${pr.headRefName} -> ${pr.baseRefName}\n${pr.url}\n\n` +
    `Description:\n\n${pr.body?.trim() || "(no description)"}\n\n` +
    `${conversationSection}\n${reviewSection}\n` +
    `${checkoutSection}`;

  return renderWithSkill(resolvedSkill, `PR ${repoSlug}#${number}`, body);
}

export const reviewContextTool: ToolDefinition<typeof reviewContextSchema> = {
  name: "review_context",
  description:
    "Builds the best available context for reviewing a change, in one call. For ANY github.com PR link " +
    "(.../pull/123), use mode 'pr' here — NOT web_fetch/web_search — it clones the PR's repo via 'gh' " +
    "(works for private repos/forks too) instead of trying to scrape the PR's web page, which doesn't " +
    "expose the actual diff anyway. Other modes: 'changes' (everything uncommitted), 'commit' (one " +
    "commit's diff + message), 'branch' (a branch vs its base + every commit message in between, via a " +
    "git worktree), 'files' (full content of an explicit file list). 'pr'/'branch' check the ref out on " +
    "disk (path returned) and return a file-change summary instead of the full diff text, since PR/branch " +
    "diffs can be too large to inline — read/diff that checked-out path directly with your own tools. " +
    "Optionally pass 'skill' (see get_context({ symbol: 'skills' })) to append that skill's full " +
    "instructions to apply while reviewing.",
  inputSchema: reviewContextSchema,
  handler: async (rawInput, sandbox) => {
    const input: ReviewContextInput = narrowReviewContextInput(rawInput);
    const resolvedSkill = resolveSkill(input.skill);

    switch (input.mode) {
      case "changes":
        return handleChangesMode(sandbox, resolvedSkill);
      case "commit":
        return handleCommitMode(input.commit, sandbox, resolvedSkill);
      case "branch":
        return handleBranchMode(input.branch, input.baseRef, sandbox, resolvedSkill);
      case "files":
        return handleFilesMode(input.files, sandbox, resolvedSkill);
      case "pr":
        return handlePrMode(input.prUrl, resolvedSkill);
    }
  },
};

export const reviewTools = [reviewContextTool];
