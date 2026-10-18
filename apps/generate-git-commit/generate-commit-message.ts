#!/usr/bin/env bun
import { readFile, writeFile, open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SKIP_SOURCES = new Set(["message", "template", "merge", "squash"]);

const CONFIG_PATH = join(homedir(), ".config", "c20s", "pre-commit-message.json");

type Mode = "always" | "manual" | "ask";

const readMode = async (): Promise<Mode> => {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.mode === "always" || parsed.mode === "manual" || parsed.mode === "ask") {
      return parsed.mode;
    }
    return "ask";
  } catch {
    return "ask";
  }
};

const buildPrompt = (filePaths: string, diff: string): string =>
  `Generate a git commit message in Conventional Commits format (type(scope): summary).
Infer the type (feat, fix, chore, refactor, docs, test, style, perf, build, ci) and scope from the changed file paths and the diff content below.
Output ONLY the commit message, no explanation, no markdown fences.

Subject line: max 72 characters.
Body: wrap every line at 72 characters. Use short bullet points (one line each, starting with "- "), not long prose paragraphs. 2-4 bullets max, only the most relevant changes.

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

  const mode = await readMode();

  if (mode === "manual") {
    process.exit(0);
  }

  if (mode === "ask") {
    const tty = await open("/dev/tty", "r+").catch(() => null);
    if (tty) {
      const ttyStream = tty.createReadStream();
      const rl = createInterface({ input: ttyStream, output: tty.createWriteStream() });
      const answer = await rl.question("Generera commit-meddelande med Claude? [Y/n] ");
      rl.close();
      ttyStream.destroy();
      await tty.close();
      if (answer.trim().toLowerCase().startsWith("n")) {
        process.exit(0);
      }
    }
  }

  const claudeProc = Bun.spawn(
    [
      "claude",
      "-p",
      buildPrompt(filePaths, diff),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--restricted",
      "--disable-slash-commands",
      "--strict-mcp-config",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  process.stderr.write("Claude genererar commit-meddelande...\n");

  const consumeStdout = async (): Promise<string> => {
    let message = "";
    let buffer = "";
    for await (const chunk of claudeProc.stdout) {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
          const delta = event.event.delta?.text ?? "";
          message += delta;
          process.stderr.write(delta);
        }
      }
    }
    process.stderr.write("\n");
    return message;
  };

  const [message, errOutput, exitCode] = await Promise.all([
    consumeStdout(),
    new Response(claudeProc.stderr).text(),
    claudeProc.exited,
  ]);

  if (exitCode !== 0 || !message.trim()) {
    console.error(`generate-commit-message: claude misslyckades (${exitCode}): ${errOutput}`);
    process.exit(0);
  }

  const existing = await readFile(msgFile, "utf8");
  await writeFile(msgFile, `${message.trim()}\n${existing}`);
};

main();
