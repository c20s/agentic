import { readContext, writeContext, CONTEXT_PATH } from "./context.ts";

function usageError(message: string): never {
  console.error(message);
  console.error("Usage: bun scripts/save-context.ts <path> [--org <org> | --repo-prefix <prefix>]");
  process.exit(1);
}

async function main(): Promise<void> {
  const [path, flag, value] = process.argv.slice(2);
  if (!path) {
    usageError("Missing <path>.");
  }

  const context = await readContext();

  if (flag === "--org" && value) {
    context.orgs = { ...context.orgs, [value]: path };
  } else if (flag === "--repo-prefix" && value) {
    context.repos = { ...context.repos, [value]: path };
  } else if (!flag) {
    context.default = path;
  } else {
    usageError(`Unknown flag: ${flag}`);
  }

  await writeContext(context);
  console.log(`Saved to ${CONTEXT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
