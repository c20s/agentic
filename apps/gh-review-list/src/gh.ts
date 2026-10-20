/** Thin wrappers around the `gh` CLI, all shelling out via Bun.spawn. */

async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  return stdout;
}

/**
 * Parses `raw` as JSON and validates it with `isValid`, throwing a descriptive error (naming
 * `context`, e.g. "gh search prs") if the shape doesn't match. This is the boundary where a `gh`
 * CLI/API change would surface — as a clear error here, rather than a confusing type error or
 * silently-wrong data several calls downstream.
 */
function parseJson<T>(raw: string, isValid: (value: unknown) => value is T, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${context}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isValid(parsed)) {
    throw new Error(`${context}: unexpected JSON shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface GhSearchPr {
  number: number;
  repository: { name: string; nameWithOwner?: string; owner?: { login: string } } | string;
  title: string;
  author: { login: string } | string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

function isGhSearchPr(value: unknown): value is GhSearchPr {
  if (!isRecord(value)) return false;
  const repoOk = typeof value.repository === "string" || isRecord(value.repository);
  const authorOk = typeof value.author === "string" || isRecord(value.author);
  return (
    typeof value.number === "number" &&
    repoOk &&
    typeof value.title === "string" &&
    authorOk &&
    typeof value.url === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isGhSearchPrArray(value: unknown): value is GhSearchPr[] {
  return Array.isArray(value) && value.every(isGhSearchPr);
}

const SEARCH_JSON_FIELDS = "number,repository,title,author,url,createdAt,updatedAt";

export async function searchPrs(query: string[]): Promise<GhSearchPr[]> {
  const out = await runGh(["search", "prs", ...query, "--json", SEARCH_JSON_FIELDS]);
  return parseJson(out, isGhSearchPrArray, "gh search prs");
}

const REVIEW_DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);
type ReviewDecisionValue = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

function isReviewDecisionResponse(value: unknown): value is { reviewDecision: ReviewDecisionValue } {
  if (!isRecord(value)) return false;
  const d = value.reviewDecision;
  return d === null || d === undefined || (typeof d === "string" && REVIEW_DECISIONS.has(d));
}

export async function viewPrReviewDecision(repo: string, number: number): Promise<ReviewDecisionValue> {
  const out = await runGh(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision"]);
  const parsed = parseJson(out, isReviewDecisionResponse, "gh pr view --json reviewDecision");
  return (parsed.reviewDecision as ReviewDecisionValue) || null;
}

function isCurrentUserResponse(value: unknown): value is { login: string } {
  return isRecord(value) && typeof value.login === "string";
}

export async function currentUser(): Promise<string> {
  const out = await runGh(["api", "user"]);
  const parsed = parseJson(out, isCurrentUserResponse, "gh api user");
  return parsed.login;
}

function isPrDetailResponse(value: unknown): value is { updated_at: string; head: { sha: string } } {
  return (
    isRecord(value) &&
    typeof value.updated_at === "string" &&
    isRecord(value.head) &&
    typeof value.head.sha === "string"
  );
}

export async function prLatestCommitInfo(
  repo: string,
  number: number
): Promise<{ updatedAt: string; headSha: string }> {
  const out = await runGh(["api", `repos/${repo}/pulls/${number}`]);
  const parsed = parseJson(out, isPrDetailResponse, `gh api repos/${repo}/pulls/${number}`);
  return { updatedAt: parsed.updated_at, headSha: parsed.head.sha };
}

export interface GhReviewComment {
  user: { login: string };
  created_at: string;
}

function isGhReviewComment(value: unknown): value is GhReviewComment {
  return (
    isRecord(value) &&
    isRecord(value.user) &&
    typeof value.user.login === "string" &&
    typeof value.created_at === "string"
  );
}

function isGhReviewCommentArray(value: unknown): value is GhReviewComment[] {
  return Array.isArray(value) && value.every(isGhReviewComment);
}

export async function prReviewComments(repo: string, number: number): Promise<GhReviewComment[]> {
  const out = await runGh(["api", `repos/${repo}/pulls/${number}/comments`]);
  return parseJson(out, isGhReviewCommentArray, `gh api repos/${repo}/pulls/${number}/comments`);
}

function isLoginArray(value: unknown): value is { login: string }[] {
  return Array.isArray(value) && value.every((m) => isRecord(m) && typeof m.login === "string");
}

export async function teamMembers(org: string, team: string): Promise<string[]> {
  const out = await runGh(["api", `/orgs/${org}/teams/${team}/members`]);
  const parsed = parseJson(out, isLoginArray, `gh api /orgs/${org}/teams/${team}/members`);
  return parsed.map((m) => m.login);
}
