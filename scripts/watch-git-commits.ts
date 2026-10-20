import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

const IGNORED_DIRS = new Set(["node_modules", "apm_modules"]);

const findGitDirs = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[][] = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) return [];
      const fullPath = join(root, entry.name);
      if (entry.name === ".git") return [fullPath];
      return findGitDirs(fullPath);
    }),
  );
  return results.flat();
};

const readHeadRef = async (gitDir: string): Promise<string> =>
  (await readFile(join(gitDir, "HEAD"), "utf8")).trim();

const lastLogLine = async (gitDir: string, headRef: string): Promise<string | null> => {
  const refMatch = headRef.match(/^ref:\s*(.+)$/);
  const logPath = refMatch
    ? join(gitDir, "logs", refMatch[1])
    : join(gitDir, "logs", "HEAD");
  try {
    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n");
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
};

const formatLogLine = (repoPath: string, line: string): string => {
  const parts = line.split("\t");
  const message = parts.at(-1) ?? line;
  const [, newSha] = parts[0]?.split(" ") ?? [];
  const shortSha = newSha?.slice(0, 7) ?? "";
  return `[${new Date().toISOString()}] ${repoPath} ${shortSha} ${message}`;
};

const watchRepo = async (gitDir: string, repoLabel: string): Promise<FSWatcher | null> => {
  const headRef = await readHeadRef(gitDir);
  let lastSeen = await lastLogLine(gitDir, headRef);

  const check = async () => {
    const headRef = await readHeadRef(gitDir);
    const line = await lastLogLine(gitDir, headRef);
    if (line && line !== lastSeen) {
      lastSeen = line;
      console.log(formatLogLine(repoLabel, line));
    }
  };

  const logsDir = join(gitDir, "logs");
  try {
    return watch(logsDir, { recursive: true }, () => {
      check();
    });
  } catch {
    console.log(`Warning: could not watch ${logsDir} (no commits yet?)`);
    return null;
  }
};

const main = async () => {
  const root = resolve(expandHome(process.argv[2] ?? "."));
  const gitDirs = await findGitDirs(root);

  if (gitDirs.length === 0) {
    console.log(`No .git directories found under ${root}`);
    return;
  }

  console.log(`Watching ${gitDirs.length} repo(s) under ${root}:`);
  for (const dir of gitDirs) console.log(`  - ${dir}`);

  const watchers = (
    await Promise.all(
      gitDirs.map((dir) => watchRepo(dir, dir.replace(`${root}/`, "").replace(/\/\.git$/, ""))),
    )
  ).filter((w): w is FSWatcher => w !== null);

  process.on("SIGINT", () => {
    watchers.forEach((w) => w.close());
    process.exit(0);
  });
};

main();
