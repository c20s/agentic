import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { projectName } from "./project-name.ts";

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverScript = join(skillDir, "scripts", "channel-server.ts");

async function main(): Promise<void> {
  const cwd = process.cwd();
  const name = await projectName(cwd);

  const configDir = await mkdtemp(join(tmpdir(), "c20s-channel-"));
  const configPath = join(configDir, ".mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          [name]: { command: "bun", args: [serverScript] },
        },
      },
      null,
      2
    )
  );

  console.log(`Starting Claude Code with channel "${name}" for ${cwd}`);
  const proc = Bun.spawn(
    [
      "claude",
      "--mcp-config",
      configPath,
      "--dangerously-load-development-channels",
      `server:${name}`,
    ],
    { cwd, stdio: ["inherit", "inherit", "inherit"] }
  );
  await proc.exited;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
