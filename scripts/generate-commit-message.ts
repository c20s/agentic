#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";

const SKIP_SOURCES = new Set(["message", "template", "merge", "squash"]);

const buildPrompt = (filePaths: string, diff: string): string =>
  `Generate a git commit message in Conventional Commits format (type(scope): summary).
Infer the type (feat, fix, chore, refactor, docs, test, style, perf, build, ci) and scope from the changed file paths and the diff content below.
Output ONLY the commit message, no explanation, no markdown fences.

Changed files:
${filePaths}

Diff:
${diff}`;

const main = async () => {
  const [msgFile, source] = process.argv.slice(2);

  if (!msgFile) {
    console.error("Usage: generate-commit-message.ts <msg-file> [source]");
    process.exit(1);
  }

  if (source && SKIP_SOURCES.has(source)) {
    process.exit(0);
  }

  const [diff, filePaths] = await Promise.all([
    new Response(Bun.spawn(["git", "diff", "--cached"], { stdout: "pipe" }).stdout).text(),
    new Response(
      Bun.spawn(["git", "diff", "--cached", "--name-status"], { stdout: "pipe" }).stdout,
    ).text(),
  ]);

  if (!diff.trim()) {
    process.exit(0);
  }

  const claudeProc = Bun.spawn(["claude", "-p", buildPrompt(filePaths, diff)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [message, errOutput] = await Promise.all([
    new Response(claudeProc.stdout).text(),
    new Response(claudeProc.stderr).text(),
  ]);
  const exitCode = await claudeProc.exited;

  if (exitCode !== 0 || !message.trim()) {
    console.error(`generate-commit-message: claude misslyckades (${exitCode}): ${errOutput}`);
    process.exit(0);
  }

  const existing = await readFile(msgFile, "utf8");
  await writeFile(msgFile, `${message.trim()}\n${existing}`);
};

main();
