import { existsSync } from "node:fs";
import { join } from "node:path";
import { readContext, resolveBaseDir } from "./context.ts";

type PrInfo = {
  number: number;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  url: string;
};

function usageError(message: string): never {
  console.error(message);
  console.error("Usage: bun scripts/clone-repo.ts <pr-url> <base-dir>");
  process.exit(1);
}

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${stderr}`);
  }
  return stdout.trim();
}

async function getPrInfo(prUrl: string): Promise<{ owner: string; repo: string; info: PrInfo }> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    usageError(`Not a GitHub PR URL: ${prUrl}`);
  }
  const [, owner, repo] = match;
  const json = await run([
    "gh",
    "pr",
    "view",
    prUrl,
    "--json",
    "number,headRefName,baseRefName,isCrossRepository,url",
  ]);
  const info = JSON.parse(json) as PrInfo;
  return { owner, repo, info };
}

async function ensureClone(repoDir: string, owner: string, repo: string): Promise<void> {
  if (existsSync(repoDir)) {
    return;
  }
  console.log(`Cloning ${owner}/${repo} into ${repoDir}`);
  await run(["git", "clone", `git@github.com:${owner}/${repo}.git`, repoDir]);
}

async function ensureWorktree(repoDir: string, worktreeDir: string, prNumber: number): Promise<void> {
  if (existsSync(worktreeDir)) {
    console.log(`Worktree already exists: ${worktreeDir}`);
    return;
  }
  const refSpec = `pull/${prNumber}/head`;
  const localBranch = `pr-${prNumber}`;
  console.log(`Fetching ${refSpec}`);
  await run(["git", "fetch", "origin", `${refSpec}:${localBranch}`], repoDir);
  console.log(`Creating worktree at ${worktreeDir}`);
  await run(["git", "worktree", "add", worktreeDir, localBranch], repoDir);
}

async function main(): Promise<void> {
  const [prUrl, baseDirArg] = process.argv.slice(2);
  if (!prUrl) {
    usageError("Missing <pr-url>.");
  }

  const { owner, repo, info } = await getPrInfo(prUrl);

  const baseDir = baseDirArg ?? resolveBaseDir(await readContext(), owner, repo);
  if (!baseDir) {
    usageError("No base directory given and none found in context. Pass <base-dir> explicitly.");
  }

  const repoDir = join(baseDir, repo);
  const worktreeDir = join(baseDir, `${repo}-pr-${info.number}`);

  await ensureClone(repoDir, owner, repo);
  await ensureWorktree(repoDir, worktreeDir, info.number);

  console.log(JSON.stringify({ owner, repo, number: info.number, headRefName: info.headRefName, repoDir, worktreeDir }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
