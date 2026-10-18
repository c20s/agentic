import { isAbsolute, relative } from "node:path";
import { readRegistry, pruneDead, writeRegistry, type Registry } from "./registry.ts";

function usageError(message: string): never {
  console.error(message);
  console.error("Usage: bun scripts/send-diff.ts <file-path> [--project <name>]");
  process.exit(1);
}

function parseArgs(argv: string[]): { filePath: string; project?: string } {
  const [filePath, flag, value] = argv;
  if (!filePath) {
    usageError("Missing <file-path>.");
  }
  if (flag && (flag !== "--project" || !value)) {
    usageError(`Unknown arguments: ${argv.slice(1).join(" ")}`);
  }
  return { filePath, project: flag === "--project" ? value : undefined };
}

function isUnder(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function matchingProjects(registry: Registry, filePath: string): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => isUnder(filePath, entry.cwd))
    .map(([name]) => name);
}

async function sendDiff(registry: Registry, project: string, filePath: string): Promise<void> {
  const entry = registry[project];
  if (!entry) {
    console.error(`No running channel for project "${project}". Start one with: bun scripts/start-channel.ts`);
    process.exit(1);
  }

  const proc = Bun.spawn(["git", "diff", "--", filePath], {
    cwd: entry.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const diff = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    console.error(`git diff failed: ${err}`);
    process.exit(1);
  }
  if (!diff.trim()) {
    console.error(`No unstaged changes for ${filePath}.`);
    process.exit(1);
  }

  const res = await fetch(`http://127.0.0.1:${entry.port}`, {
    method: "POST",
    body: diff,
  });
  if (!res.ok) {
    console.error(`Channel server rejected the diff: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Sent diff for ${filePath} to "${project}".`);
}

async function main(): Promise<void> {
  const { filePath, project } = parseArgs(process.argv.slice(2));
  const absolutePath = isAbsolute(filePath) ? filePath : `${process.cwd()}/${filePath}`;

  const registry = await pruneDead(await readRegistry());
  await writeRegistry(registry);

  if (project) {
    await sendDiff(registry, project, absolutePath);
    return;
  }

  const candidates = matchingProjects(registry, absolutePath);
  if (candidates.length === 0) {
    console.error(`No running channel covers ${absolutePath}. Start one with: bun scripts/start-channel.ts`);
    process.exit(1);
  }
  if (candidates.length === 1) {
    await sendDiff(registry, candidates[0], absolutePath);
    return;
  }

  console.log(JSON.stringify({ needsSelection: true, candidates }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
