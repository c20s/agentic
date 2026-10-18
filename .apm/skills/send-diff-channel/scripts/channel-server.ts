import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readRegistry, writeRegistry, pruneDead, type ChannelEntry } from "./registry.ts";
import { projectName } from "./project-name.ts";

const cwd = process.cwd();
const name = await projectName(cwd);

const server = new Server(
  { name, version: "1.0.0" },
  { capabilities: { experimental: { "claude/channel": {} } } }
);

const transport = new StdioServerTransport();
await server.connect(transport);

const httpServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("expected POST", { status: 405 });
    }
    const content = await req.text();
    if (!content.trim()) {
      return new Response("empty body", { status: 400 });
    }
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta: { project: name } },
    });
    return new Response("ok");
  },
});

const entry: ChannelEntry = {
  port: httpServer.port,
  cwd,
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

const registry = await pruneDead(await readRegistry());
registry[name] = entry;
await writeRegistry(registry);

process.on("exit", () => {
  httpServer.stop();
});
