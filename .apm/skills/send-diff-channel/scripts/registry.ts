import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_PATH = join(homedir(), ".config", "c20s", "channels.json");

export type ChannelEntry = {
  port: number;
  cwd: string;
  pid: number;
  startedAt: string;
};

export type Registry = Record<string, ChannelEntry>;

export async function readRegistry(): Promise<Registry> {
  const file = Bun.file(REGISTRY_PATH);
  if (!(await file.exists())) {
    return {};
  }
  return (await file.json()) as Registry;
}

export async function writeRegistry(registry: Registry): Promise<void> {
  await Bun.write(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pruneDead(registry: Registry): Promise<Registry> {
  const pruned: Registry = {};
  for (const [name, entry] of Object.entries(registry)) {
    if (isAlive(entry.pid)) {
      pruned[name] = entry;
    }
  }
  return pruned;
}
