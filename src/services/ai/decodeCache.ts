// Server-side decode cache. A repeat lookup of the same code must NOT cost another AI/Firecrawl call.
// SUCCESSES are cached indefinitely (within the running process). MISSES are cached for a SHORT TTL so
// the same unresolved code stops re-running the whole pipeline on every scan (owner: the "money bleed"
// of looping the same junk sites), while a genuine retry still works once the TTL lapses or via
// forceRefresh. In-memory + per-process: the client catalog/alias layer is the durable cache.

interface Entry {
  value: unknown;
  expiresAt: number | null; // null = never expires (a successful decode)
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 5000; // FIFO cap so a long-running server can't grow unbounded
// How long a MISS (no usable product) is remembered before the next scan is allowed to re-run it.
const DEFAULT_MISS_TTL_MS = Number(process.env.DECODE_MISS_TTL_MS || 600_000); // 10 min

export function decodeCacheKey(code: string): string {
  return (code ?? "").trim();
}

export function getDecodeCache<T = unknown>(code: string): T | undefined {
  const k = decodeCacheKey(code);
  if (!k) return undefined;
  const e = store.get(k);
  if (!e) return undefined;
  if (e.expiresAt !== null && Date.now() > e.expiresAt) {
    store.delete(k); // lazy eviction of an expired miss
    return undefined;
  }
  return e.value as T;
}

/** Store a value. Pass ttlMs to make it expire (used for misses); omit for an indefinite (success) entry. */
export function setDecodeCache(code: string, value: unknown, ttlMs?: number): void {
  const k = decodeCacheKey(code);
  if (!k) return;
  if (!store.has(k) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(k, { value, expiresAt: typeof ttlMs === "number" ? Date.now() + ttlMs : null });
}

export function clearDecodeCache(): void {
  store.clear();
}

export function decodeCacheSize(): number {
  return store.size;
}

export interface WithDecodeCacheOpts {
  /** TTL for a MISS (no usable product). Defaults to DECODE_MISS_TTL_MS (10 min). */
  missTtlMs?: number;
  /** Skip the cache read and recompute (manual "Retry live decode"). */
  forceRefresh?: boolean;
}

/**
 * Run compute() only on a cache MISS. A SUCCESS (`isSuccess(value) === true`) is cached indefinitely; a
 * non-success is cached for a SHORT TTL so the same code stops re-running every scan, yet stays
 * retryable later. `forceRefresh` bypasses the cache read. Returns whether the value came from cache.
 */
export async function withDecodeCache<T>(
  code: string,
  isSuccess: (v: T) => boolean,
  compute: () => Promise<T>,
  opts?: WithDecodeCacheOpts,
): Promise<{ value: T; cached: boolean }> {
  if (!opts?.forceRefresh) {
    const hit = getDecodeCache<T>(code);
    if (hit !== undefined) return { value: hit, cached: true };
  }
  const value = await compute();
  setDecodeCache(code, value, isSuccess(value) ? undefined : (opts?.missTtlMs ?? DEFAULT_MISS_TTL_MS));
  return { value, cached: false };
}
