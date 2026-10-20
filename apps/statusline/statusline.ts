#!/usr/bin/env bun

import { homedir } from "os";
import { basename, join } from "path";
import {
  findAllTranscripts,
  formatTokens,
  formatUsd,
  lastUsageByModel,
  mergeUsageByModel,
  startOfToday,
  totalCost,
  totalTokensAcross,
  type Usage,
  type UsageByModel,
} from "./claude-usage";

async function main() {
  const input = parseStatuslineInput(await readStdin());
  const projectsDir = join(homedir(), ".claude", "projects");

  const sessionUsage = input.transcript_path
    ? lastUsageByModel(input.transcript_path)
    : new Map<string, Usage>();

  const todaySince = startOfToday();
  const todayUsage = findAllTranscripts(projectsDir)
    .map((path) => lastUsageByModel(path, todaySince))
    .reduce(mergeUsageByModel, new Map<string, Usage>() as UsageByModel);

  const modelLabel = input.model?.display_name ?? input.model?.id ?? "claude";
  const project = await projectName(input.cwd);

  const line = [
    ...(project ? [project] : []),
    modelLabel,
    `session ${formatTokens(totalTokensAcross(sessionUsage))} (${formatUsd(totalCost(sessionUsage))})`,
    `today ${formatTokens(totalTokensAcross(todayUsage))} (${formatUsd(totalCost(todayUsage))})`,
  ].join(" | ");

  console.log(line);
  console.log("-");
}

const projectName = async (cwd?: string): Promise<string | null> => {
  if (!cwd) return null;

  const gitRoot = await gitTopLevel(cwd);
  return basename(gitRoot ?? cwd);
};

const gitTopLevel = async (cwd: string): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const parseStatuslineInput = (raw: string): StatuslineInput => {
  try {
    return JSON.parse(raw) as StatuslineInput;
  } catch {
    return {};
  }
};

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  cwd?: string;
}

main();
