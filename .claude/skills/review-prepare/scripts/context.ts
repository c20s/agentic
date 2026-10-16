import { homedir } from "node:os";
import { join } from "node:path";

export const CONTEXT_PATH = join(homedir(), ".config", "c20s", "context.json");

export type Context = {
  default?: string;
  orgs?: Record<string, string>;
  repos?: Record<string, string>;
};

export async function readContext(): Promise<Context> {
  const file = Bun.file(CONTEXT_PATH);
  if (!(await file.exists())) {
    return {};
  }
  return (await file.json()) as Context;
}

export async function writeContext(context: Context): Promise<void> {
  await Bun.write(CONTEXT_PATH, JSON.stringify(context, null, 2) + "\n");
}

export function resolveBaseDir(context: Context, org: string, repo: string): string | undefined {
  const repoMatch = Object.entries(context.repos ?? {}).find(([prefix]) => repo.startsWith(prefix));
  if (repoMatch) {
    return repoMatch[1];
  }
  if (context.orgs?.[org]) {
    return context.orgs[org];
  }
  return context.default;
}
