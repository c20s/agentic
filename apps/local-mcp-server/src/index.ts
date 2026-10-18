#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { Sandbox } from "./sandbox";
import { allTools } from "./tools";
import { logger } from "./logger";

/**
 * Sandbox-root: var agenten får läsa/skriva.
 * Prioritet: första CLI-argumentet > MCP_SANDBOX_ROOT env var > cwd.
 */
const rootArg = process.argv[2] ?? process.env.MCP_SANDBOX_ROOT ?? process.cwd();
const sandbox = new Sandbox(resolve(rootArg));

const server = new McpServer({
  name: "local-fs-mcp",
  version: "0.1.0",
});

for (const tool of allTools) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema.shape,
    },
    async (args: any) => {
      const start = performance.now();
      logger.toolCall(tool.name, args);
      try {
        const result = await tool.handler(args, sandbox);
        logger.toolResult(tool.name, Math.round(performance.now() - start), result);
        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.toolError(tool.name, Math.round(performance.now() - start), message);
        return {
          content: [{ type: "text" as const, text: `Fel: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`Startad. Sandbox root: ${sandbox.root}. PID: ${process.pid}.`);
  if (logger.path) {
    logger.info(`Loggar till: ${logger.path} (tail -f för att följa live).`);
  }
}

main().catch((err) => {
  logger.info(`Misslyckades att starta: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
