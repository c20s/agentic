import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const CACHE_DIR = join(homedir(), ".cache", "c20s", "prs");

interface CacheEntry<T> {
  cachedAt: number;
  value: T;
}

function cacheKeyToPath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${hash}.json`);
}

/**
 * Reads a cached value for `key` if it exists and is younger than `ttlSeconds`.
 * ttlSeconds <= 0 always misses (caching disabled).
 */
export async function readCache<T>(key: string, ttlSeconds: number): Promise<T | null> {
  if (ttlSeconds <= 0) return null;
  const path = cacheKeyToPath(key);
  try {
    const raw = await readFile(path, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    const ageSeconds = (Date.now() - entry.cachedAt) / 1000;
    if (ageSeconds > ttlSeconds) return null;
    return entry.value;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  const path = cacheKeyToPath(key);
  await mkdir(dirname(path), { recursive: true });
  const entry: CacheEntry<T> = { cachedAt: Date.now(), value };
  await writeFile(path, JSON.stringify(entry), "utf-8");
}

/**
 * Runs `fn` and caches the result under `key`, unless a fresh cached value already exists.
 * Set `refresh: true` to bypass the cache read (still writes a fresh entry).
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: { refresh?: boolean } = {}
): Promise<{ value: T; fromCache: boolean }> {
  if (!opts.refresh) {
    const cached = await readCache<T>(key, ttlSeconds);
    if (cached !== null) return { value: cached, fromCache: true };
  }
  const value = await fn();
  if (ttlSeconds > 0) await writeCache(key, value);
  return { value, fromCache: false };
}
