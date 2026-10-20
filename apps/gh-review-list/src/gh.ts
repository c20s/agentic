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

export interface GhSearchPr {
  number: number;
  repository: { name: string; nameWithOwner?: string; owner?: { login: string } } | string;
  title: string;
  author: { login: string } | string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const SEARCH_JSON_FIELDS = "number,repository,title,author,url,createdAt,updatedAt";

export async function searchPrs(query: string[]): Promise<GhSearchPr[]> {
  const out = await runGh(["search", "prs", ...query, "--json", SEARCH_JSON_FIELDS]);
  return JSON.parse(out) as GhSearchPr[];
}

export async function viewPrReviewDecision(
  repo: string,
  number: number
): Promise<"APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null> {
  const out = await runGh(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision"]);
  const parsed = JSON.parse(out) as { reviewDecision: string | null };
  return (parsed.reviewDecision as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null) || null;
}

export async function currentUser(): Promise<string> {
  const out = await runGh(["api", "user"]);
  const parsed = JSON.parse(out) as { login: string };
  return parsed.login;
}

export async function prLatestCommitInfo(
  repo: string,
  number: number
): Promise<{ updatedAt: string; headSha: string }> {
  const out = await runGh(["api", `repos/${repo}/pulls/${number}`]);
  const parsed = JSON.parse(out) as { updated_at: string; head: { sha: string } };
  return { updatedAt: parsed.updated_at, headSha: parsed.head.sha };
}

export interface GhReviewComment {
  user: { login: string };
  created_at: string;
}

export async function prReviewComments(repo: string, number: number): Promise<GhReviewComment[]> {
  const out = await runGh(["api", `repos/${repo}/pulls/${number}/comments`]);
  return JSON.parse(out) as GhReviewComment[];
}

export async function teamMembers(org: string, team: string): Promise<string[]> {
  const out = await runGh(["api", `/orgs/${org}/teams/${team}/members`]);
  const parsed = JSON.parse(out) as { login: string }[];
  return parsed.map((m) => m.login);
}
