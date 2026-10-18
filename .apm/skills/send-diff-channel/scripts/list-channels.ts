import { readRegistry, pruneDead, writeRegistry } from "./registry.ts";

async function main(): Promise<void> {
  const registry = await pruneDead(await readRegistry());
  await writeRegistry(registry);
  console.log(JSON.stringify(registry, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
