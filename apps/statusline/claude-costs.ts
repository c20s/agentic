#!/usr/bin/env bun

import { homedir } from "os";
import { join } from "path";
import {
  addUsage,
  emptyUsage,
  findAllTranscripts,
  formatTokens,
  formatUsd,
  sumUsageByModelPerDay,
  totalCost,
  totalTokens,
  type Usage,
  type UsageByModel,
} from "./claude-usage";

const mergeDayMaps = (
  a: ReadonlyMap<string, UsageByModel>,
  b: ReadonlyMap<string, UsageByModel>,
): ReadonlyMap<string, UsageByModel> =>
  Array.from(b.entries()).reduce((acc, [day, usageByModel]) => {
    const next = new Map(acc);
    const merged = Array.from(usageByModel.entries()).reduce((m, [model, usage]) => {
      const nm = new Map(m);
      nm.set(model, addUsage(m.get(model) ?? emptyUsage(), usage));
      return nm;
    }, next.get(day) ?? (new Map() as UsageByModel));
    next.set(day, merged);
    return next;
  }, a);

const sumUsage = (map: UsageByModel): Usage =>
  Array.from(map.values()).reduce(addUsage, emptyUsage());

const costForDay = (map: UsageByModel): number => totalCost(map);

const printDay = (day: string, map: UsageByModel): void => {
  const u = sumUsage(map);
  const cost = costForDay(map);
  console.log(day);
  console.log(`  input       ${formatTokens(u.input)}`);
  console.log(`  cache write ${formatTokens(u.cacheWrite5m + u.cacheWrite1h)}`);
  console.log(`  cache read  ${formatTokens(u.cacheRead)}`);
  console.log(`  output      ${formatTokens(u.output)}`);
  console.log(`  total       ${formatTokens(totalTokens(u))}`);
  console.log(`  cost        ${formatUsd(cost)}`);
  console.log("");
};

async function main() {
  const projectsDir = join(homedir(), ".claude", "projects");

  const byDay = findAllTranscripts(projectsDir)
    .map(sumUsageByModelPerDay)
    .reduce(mergeDayMaps, new Map<string, UsageByModel>());

  const days = Array.from(byDay.keys()).sort();

  for (const day of days) {
    printDay(day, byDay.get(day)!);
  }
}

main();
