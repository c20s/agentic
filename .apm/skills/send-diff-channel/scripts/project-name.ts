import { basename } from "node:path";

export async function projectName(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  const root = code === 0 ? output.trim() : cwd;
  return basename(root);
}
