import { createInterface } from "node:readline/promises";
import { commentableLinesByFile, isLineCommentable } from "./diff-lines.ts";

type Finding = {
  label: string;
  decoration?: "blocking" | "non-blocking" | "if-minor";
  file: string;
  line: number;
  subject: string;
  discussion?: string | null;
};

type FindingsFile = {
  pr?: string;
  findings: Finding[];
};

function usageError(message: string): never {
  console.error(message);
  console.error("Usage: bun scripts/send-review.ts <findings-file>");
  process.exit(1);
}

function formatComment(f: Finding): string {
  const decoration = f.decoration ? ` (${f.decoration})` : "";
  const body = f.discussion ? `${f.subject}\n\n${f.discussion}` : f.subject;
  return `${f.label}${decoration}: ${body}`;
}

async function run(cmd: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { stdin: input ? "pipe" : undefined, stdout: "pipe", stderr: "pipe" });
  if (input && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(input);
    proc.stdin.end();
  }
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

async function selectFindings(findings: Finding[], ask: (q: string) => Promise<string>): Promise<Finding[]> {
  const selected: Finding[] = [];
  console.log(`${findings.length} finding(s) to go through. For each: y = include, n = skip, e = edit subject, q = stop and use what's selected so far.\n`);

  for (const [i, finding] of findings.entries()) {
    console.log(`[${i + 1}/${findings.length}] ${finding.file}:${finding.line}`);
    console.log(formatComment(finding));
    const answer = (await ask("Include? [y/n/e/q] ")).trim().toLowerCase();

    if (answer === "q") {
      break;
    }
    if (answer === "e") {
      const newSubject = await ask("New subject: ");
      selected.push({ ...finding, subject: newSubject.trim() || finding.subject });
      continue;
    }
    if (answer === "y" || answer === "") {
      selected.push(finding);
    }
    console.log("");
  }

  return selected;
}

async function writeMarkdown(findings: Finding[], pr: string | undefined): Promise<string> {
  const lines: string[] = [];
  if (pr) {
    lines.push(`Review for ${pr}`, "");
  }
  for (const f of findings) {
    lines.push(`**${f.file}:${f.line}**`, "", formatComment(f), "");
  }
  const outPath = "review-output.md";
  await Bun.write(outPath, lines.join("\n"));
  return outPath;
}

function parsePrUrl(pr: string): { owner: string; repo: string; number: string } {
  const match = pr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Not a GitHub PR URL: ${pr}`);
  }
  const [, owner, repo, number] = match;
  return { owner, repo, number };
}

async function fetchDiff(owner: string, repo: string, number: string): Promise<string> {
  const proc = Bun.spawn(
    ["gh", "api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`fetching diff failed:\n${stderr}`);
  }
  return stdout;
}

async function sendToGithub(findings: Finding[], pr: string): Promise<void> {
  const { owner, repo, number } = parsePrUrl(pr);
  const [commitId, diff] = await Promise.all([
    run(["gh", "api", `repos/${owner}/${repo}/pulls/${number}`, "--jq", ".head.sha"]),
    fetchDiff(owner, repo, number),
  ]);
  const commentable = commentableLinesByFile(diff);

  const postable: Finding[] = [];
  const rejected: Finding[] = [];
  for (const f of findings) {
    if (isLineCommentable(commentable, f.file, f.line)) {
      postable.push(f);
    } else {
      rejected.push(f);
    }
  }

  for (const f of rejected) {
    console.log(`Skipping ${f.file}:${f.line} — that line isn't part of the PR's diff, GitHub would reject it.`);
  }

  if (postable.length === 0) {
    console.log("Nothing left to post.");
    return;
  }

  const body = {
    commit_id: commitId,
    event: "COMMENT",
    body: "",
    comments: postable.map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body: formatComment(f),
    })),
  };

  console.log(`Posting ${postable.length} comment(s) to ${pr}`);
  await run(
    ["gh", "api", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"],
    JSON.stringify(body),
  );
  console.log("Posted.");
}

async function main(): Promise<void> {
  const [findingsPath] = process.argv.slice(2);
  if (!findingsPath) {
    usageError("Missing <findings-file>.");
  }

  const file = Bun.file(findingsPath);
  if (!(await file.exists())) {
    usageError(`File not found: ${findingsPath}`);
  }
  const data = (await file.json()) as FindingsFile;
  if (!data.findings?.length) {
    console.log("No findings in file. Nothing to do.");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q);

  const selected = await selectFindings(data.findings, ask);

  if (selected.length === 0) {
    console.log("Nothing selected. Nothing sent.");
    rl.close();
    return;
  }

  console.log(`\n${selected.length} finding(s) selected.`);

  if (!data.pr) {
    console.log("No PR for this review, writing a markdown file.");
    const outPath = await writeMarkdown(selected, data.pr);
    console.log(`Written to ${outPath}`);
    rl.close();
    return;
  }

  const mode = (await ask("Send where? [1] GitHub PR comments  [2] Markdown file  ")).trim();

  if (mode === "1") {
    await sendToGithub(selected, data.pr);
  } else {
    const outPath = await writeMarkdown(selected, data.pr);
    console.log(`Written to ${outPath}`);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
