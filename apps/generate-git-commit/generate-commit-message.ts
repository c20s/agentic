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

interface StreamJsonEvent {
  type?: string;
  event?: {
    type?: string;
    delta?: { text?: string };
  };
}

function isStreamJsonEvent(value: unknown): value is StreamJsonEvent {
  return typeof value === "object" && value !== null;
}

/**
 * Reads Claude's `--output-format stream-json` stdout, echoing each text delta to stderr as it
 * arrives (so the user sees live progress) and returns the full assembled message text.
 */
async function consumeStreamJsonText(stdout: ReadableStream<Uint8Array>): Promise<string> {
  let message = "";
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isStreamJsonEvent(event)) continue;
      if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
        const delta = event.event.delta?.text ?? "";
        message += delta;
        process.stderr.write(delta);
      }
    }
  }
  process.stderr.write("\n");
  return message;
}

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
      const answer = await rl.question("Generate commit message with Claude? [Y/n] ");
      rl.close();
      ttyStream.destroy();
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
      "--bare",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--settings",
      join(homedir(), ".claude", "settings.json"),
      "--setting-sources",
      "user"
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  process.stderr.write("Claude is generating a commit message...\n");

  const [message, errOutput, exitCode] = await Promise.all([
    consumeStreamJsonText(claudeProc.stdout),
    new Response(claudeProc.stderr).text(),
    claudeProc.exited,
  ]);

  if (exitCode !== 0 || !message.trim()) {
    console.error(`generate-commit-message: claude failed (${exitCode}): ${errOutput}`);
    process.exit(0);
  }

  const existing = await readFile(msgFile, "utf8");
  await writeFile(msgFile, `${message.trim()}\n${existing}`);
  process.exit(0);
};

main();
