#!/usr/bin/env bun
import { readFile, writeFile, open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const SKIP_SOURCES = new Set(["message", "template", "merge", "squash"]);

const buildPrompt = (filePaths: string, diff: string): string =>
  `Generate a git commit message in Conventional Commits format (type(scope): summary).
Infer the type (feat, fix, chore, refactor, docs, test, style, perf, build, ci) and scope from the changed file paths and the diff content below.
Output ONLY the commit message, no explanation, no markdown fences. Always write a body row with a summary of the changes.

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
