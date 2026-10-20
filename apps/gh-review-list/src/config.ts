import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG, type Config } from "./types";

export const CONFIG_PATH = join(homedir(), ".config", "c20s", "prs.json");

/**
 * Loads ~/.config/c20s/prs.json, falling back to defaults for any missing field.
 * Missing file -> defaults. Malformed JSON -> throws (so the user notices the typo).
 */
export async function loadConfig(path: string = CONFIG_PATH): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  const asStringArray = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new Error(`${path}: "${field}" must be an array of strings.`);
    }
    return value;
  };

  return {
    teams: asStringArray(obj.teams, "teams"),
    extraSearchQueries: asStringArray(obj.extraSearchQueries, "extraSearchQueries"),
    repos: asStringArray(obj.repos, "repos"),
    extraAuthors: asStringArray(obj.extraAuthors, "extraAuthors"),
    cacheTtlSeconds:
      typeof obj.cacheTtlSeconds === "number" ? obj.cacheTtlSeconds : DEFAULT_CONFIG.cacheTtlSeconds,
  };
}
