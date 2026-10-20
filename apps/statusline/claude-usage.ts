import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export const PRICING: Record<string, Pricing> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-mythos-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
};

const FALLBACK_PRICING = PRICING["claude-sonnet-5"];

export const pricingFor = (model: string): Pricing => PRICING[model] ?? FALLBACK_PRICING;

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  cacheRead: a.cacheRead + b.cacheRead,
});

export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;

export const costOf = (u: Usage, model: string): number => {
  const p = pricingFor(model);
  const raw =
    u.input * p.input +
    u.output * p.output +
    u.cacheWrite5m * p.cacheWrite5m +
    u.cacheWrite1h * p.cacheWrite1h +
    u.cacheRead * p.cacheRead;
  return raw / 1_000_000;
};

export const addToModel = (map: UsageByModel, model: string, u: Usage): UsageByModel => {
  const next = new Map(map);
  next.set(model, addUsage(map.get(model) ?? emptyUsage(), u));
  return next;
};

export const totalCost = (map: UsageByModel): number =>
  Array.from(map.entries()).reduce((sum, [model, u]) => sum + costOf(u, model), 0);

export const totalTokensAcross = (map: UsageByModel): number =>
  Array.from(map.values()).reduce((sum, u) => sum + totalTokens(u), 0);

export const mergeUsageByModel = (a: UsageByModel, b: UsageByModel): UsageByModel =>
  Array.from(b.entries()).reduce((acc, [model, usage]) => addToModel(acc, model, usage), a);

const usageFromRecord = (rec: AssistantRecord): { model: string; usage: Usage } | null => {
  if (rec.type !== "assistant") return null;
  const model = rec.message?.model;
  const u = rec.message?.usage;
  if (!model || !u || model === "<synthetic>") return null;
  return {
    model,
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
  };
};

const readLinesSafe = (path: string): readonly string[] => {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
};

const isAfter = (sinceMs: number | null, rec: AssistantRecord): boolean => {
  if (sinceMs === null) return true;
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  return !Number.isNaN(ts) && ts >= sinceMs;
};

const parseLine = (line: string): AssistantRecord | null => {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as AssistantRecord;
  } catch {
    return null;
  }
};

export const lastUsageByModel = (path: string, sinceMs: number | null = null): UsageByModel =>
  readLinesSafe(path)
    .map(parseLine)
    .filter((rec): rec is AssistantRecord => rec !== null && isAfter(sinceMs, rec))
    .map(usageFromRecord)
    .filter((parsed): parsed is { model: string; usage: Usage } => parsed !== null)
    .reduce((acc, { model, usage }) => new Map(acc).set(model, usage), new Map<string, Usage>());

export const sumUsageByModelPerDay = (path: string): ReadonlyMap<string, UsageByModel> =>
  readLinesSafe(path)
    .map(parseLine)
    .filter((rec): rec is AssistantRecord => rec !== null)
    .flatMap((rec) => {
      const parsed = usageFromRecord(rec);
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!parsed || Number.isNaN(ts)) return [];
      return [{ day: dayKey(ts), model: parsed.model, usage: parsed.usage }];
    })
    .reduce((acc, { day, model, usage }) => {
      const next = new Map(acc);
      next.set(day, addToModel(next.get(day) ?? new Map(), model, usage));
      return next;
    }, new Map<string, UsageByModel>());

const listDirSafe = (path: string): readonly string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const isDirectorySafe = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const walkJsonl = (dir: string): readonly string[] =>
  listDirSafe(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (isDirectorySafe(full)) return walkJsonl(full);
    return full.endsWith(".jsonl") ? [full] : [];
  });

export const findAllTranscripts = (projectsDir: string): readonly string[] => walkJsonl(projectsDir);

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

export const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

export const startOfToday = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

export const dayKey = (epochMs: number): string => {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export interface Pricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export type UsageByModel = ReadonlyMap<string, Usage>;

export interface AssistantRecord {
  type: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}
