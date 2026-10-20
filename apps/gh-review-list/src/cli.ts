#!/usr/bin/env bun
import { getReviewList } from "./core";
import { renderReviewList } from "./render";

function parseArgs(argv: string[]) {
  return {
    json: argv.includes("--json"),
    refresh: argv.includes("--refresh") || argv.includes("--no-cache"),
  };
}

async function main() {
  const { json, refresh } = parseArgs(process.argv.slice(2));
  const result = await getReviewList({ refresh });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderReviewList(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
