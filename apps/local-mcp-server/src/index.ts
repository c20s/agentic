#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { Sandbox } from "./sandbox";
import { allTools } from "./tools";
import { logger } from "./logger";
import { closeBrowser } from "./browser";

/**
 * Sandbox root: where the agent is allowed to read/write.
 * Priority: first CLI argument > MCP_SANDBOX_ROOT env var > cwd.
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
    async (args: Record<string, unknown>) => {
      const start = performance.now();
      logger.toolCall(tool.name, args);
      try {
        // `allTools` is a heterogeneous array of `ToolDefinition<Schema>` for different per-tool
        // Zod schemas, so there's no single precise static type for `args` here — the MCP SDK has
        // already validated `args` against `tool.inputSchema` before invoking this callback, so
        // this cast reflects a runtime guarantee the SDK itself provides, not an unchecked escape
        // hatch like a bare `any` would be.
        const result = await tool.handler(args as never, sandbox);
        logger.toolResult(tool.name, args, Math.round(performance.now() - start), result);
        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.toolError(tool.name, args, Math.round(performance.now() - start), message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`Started. Sandbox root: ${sandbox.root}. PID: ${process.pid}. Session: ${logger.sessionId}.`);
  if (logger.summaryPath) {
    logger.info(`Summary log: ${logger.summaryPath}`);
  }
  if (logger.path) {
    logger.info(`Detail log: ${logger.path}`);
  }
  if (logger.summaryPath || logger.path) {
    logger.info(
      `To follow just this session: tail -f ${logger.summaryPath ?? logger.path} | grep ${logger.sessionId}`
    );
  }
}

main().catch((err) => {
  logger.info(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Make sure a lazily-launched headless Chromium (for web_fetch rendering) never lingers
// as an orphaned process after the MCP server itself shuts down.
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down.`);
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
