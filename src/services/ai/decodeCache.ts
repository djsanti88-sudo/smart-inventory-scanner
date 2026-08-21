// Server-side decode cache. A repeat lookup of the same SUCCESSFULLY decoded code must NOT cost
// another AI/Firecrawl call: successes are cached indefinitely (within the running process). MISSES
// ARE NEVER CACHED (owner ruling 2026-08-20, no-candidate memory abolished everywhere): an unresolved
// code re-runs the full ladder on every scan; only the in-flight map below coalesces CONCURRENT scans
// of the same code. In-memory + per-process: the client catalog/alias layer is the durable cache.

interface Entry {
  value: unknown;
  expiresAt: number | null; // null = never expires (a successful decode)
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 5000; // FIFO cap so a long-running server can't grow unbounded

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
  /** Skip the cache read and recompute (manual "Retry live decode"). */
  forceRefresh?: boolean;
}

// L3 in-flight coalescing (owner-ratified 2026-07-15, Task 12c/AM-6): two concurrent scans of the
// SAME unknown code (e.g. a shop scanning two units back to back before the first decode settles)
// used to both call compute() - both charging a cap slot, both possibly calling GPT. Only Go-UPC
// deduped via its own throttle; this map dedupes at the cache layer for EVERY caller of
// withDecodeCache. Keyed by the already-canonical decodeCacheKey (the pipeline passes canonicalGtin
// today, so two zero-padding encodings of one product already share a key and now also share one
// in-flight compute). A THROWING compute (e.g. DailyCapExceededError) deletes its slot in a `finally`
// so the NEXT call retries fresh - it must never poison the map for future callers, but a burst of
// concurrent callers under an exhausted cap will all share that one rejection (see the cap-exhausted
// burst test: compute runs at most twice for 3 concurrent callers - once for the original slot, and
// at most once more for whichever caller's `await` observes the cleared slot first and starts a new
// one before the others resolve).
const inFlight = new Map<string, Promise<{ value: unknown; cached: boolean }>>();

/** Test-only: clear the in-flight map between tests so one test's pending promise never bleeds into the next. */
export function __clearInFlightForTest(): void {
  inFlight.clear();
}

/**
 * Run compute() only on a cache MISS. A SUCCESS (`isSuccess(value) === true`) is cached indefinitely; a
 * non-success is NEVER stored (owner 2026-08-20: no negative memory) - the same code re-runs the
 * pipeline on its next scan. `forceRefresh` bypasses the cache read AND the in-flight map entirely - a forced
 * refresh (manual "Retry live decode") always computes its OWN fresh answer and never joins, nor
 * registers itself in, another call's in-flight computation (L3/AM-6(a)).
 *
 * Returns `cached: true` for BOTH a real cache hit (L1/L2 replay) and a joined in-flight waiter - the
 * waiter's compute never ran, so from a billing/behavior standpoint it is indistinguishable from a
 * cache hit. This is a telemetry approximation (AM-6(c)): the pipeline's outcome ledger distinguishes
 * the two via the separate `joined` flag below so a joined waiter's ledger append can be suppressed
 * (AM-5 winner-only intent) while a genuine cache replay still logs its own "cached:" row.
 */
export async function withDecodeCache<T>(
  code: string,
  isSuccess: (v: T) => boolean,
  compute: () => Promise<T>,
  opts?: WithDecodeCacheOpts,
): Promise<{ value: T; cached: boolean; joined?: true }> {
  if (opts?.forceRefresh) {
    const value = await compute();
    if (isSuccess(value)) setDecodeCache(code, value);
    return { value, cached: false };
  }

  const hit = getDecodeCache<T>(code);
  if (hit !== undefined) return { value: hit, cached: true };

  const key = decodeCacheKey(code);
  const pending = key ? inFlight.get(key) : undefined;
  if (pending) {
    const shared = await pending;
    return { value: shared.value as T, cached: true, joined: true };
  }

  const p = (async (): Promise<{ value: unknown; cached: boolean }> => {
    try {
      const value = await compute();
      if (isSuccess(value)) setDecodeCache(code, value);
      return { value, cached: false };
    } finally {
      if (key) inFlight.delete(key);
    }
  })();
  if (key) inFlight.set(key, p);
  return (await p) as { value: T; cached: boolean };
}
