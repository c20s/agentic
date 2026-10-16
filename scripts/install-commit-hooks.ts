#!/usr/bin/env bun
import { readdir, lstat, symlink, unlink, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const IGNORED_DIRS = new Set(["node_modules", "apm_modules"]);
const HOOK_SOURCE = resolve(dirname(Bun.main), "prepare-commit-msg-hook.sh");
const HOOK_NAME = "prepare-commit-msg";

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

const findRepoRoots = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
    return [root];
  }
  const nested = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => findRepoRoots(join(root, e.name))),
  );
  return nested.flat();
};

const installHook = async (repoRoot: string): Promise<string> => {
  const hooksDir = join(repoRoot, ".git", "hooks");
  const hookPath = join(hooksDir, HOOK_NAME);

  await mkdir(hooksDir, { recursive: true });

  const existing = await lstat(hookPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      await unlink(hookPath);
    } else {
      return `skippad (befintlig icke-symlänk hook): ${hookPath}`;
    }
  }

  await symlink(HOOK_SOURCE, hookPath);
  return `installerad: ${hookPath}`;
};

const main = async () => {
  const root = resolve(expandHome(process.argv[2] ?? "."));
  const repoRoots = await findRepoRoots(root);

  if (repoRoots.length === 0) {
    console.log(`Inga repon hittades under ${root}`);
    return;
  }

  for (const repoRoot of repoRoots) {
    const result = await installHook(repoRoot);
    console.log(`${repoRoot}: ${result}`);
  }
};

main();
