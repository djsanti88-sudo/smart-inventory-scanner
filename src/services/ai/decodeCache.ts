// Server-side decode cache. Once a barcode has been decoded to a real product, a repeat lookup of the
// same code must NOT cost another AI/Firecrawl call (owner rule 4). In-memory + per-process: the
// client catalog/alias layer is the durable cache; this just stops repeat spend within a running
// server. Only SUCCESSFUL decodes are cached - a transient failure stays retryable.

const store = new Map<string, unknown>();
const MAX_ENTRIES = 5000; // FIFO cap so a long-running server can't grow unbounded

export function decodeCacheKey(code: string): string {
  return (code ?? "").trim();
}

export function getDecodeCache<T = unknown>(code: string): T | undefined {
  const k = decodeCacheKey(code);
  if (!k) return undefined;
  return store.get(k) as T | undefined;
}

export function setDecodeCache(code: string, value: unknown): void {
  const k = decodeCacheKey(code);
  if (!k) return;
  if (!store.has(k) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(k, value);
}

export function clearDecodeCache(): void {
  store.clear();
}

export function decodeCacheSize(): number {
  return store.size;
}

/**
 * Run compute() only on a cache MISS. The computed value is cached only when `isSuccess(value)` is
 * true, so failed decodes are never cached (the next scan retries). Returns whether it was a hit.
 */
export async function withDecodeCache<T>(
  code: string,
  isSuccess: (v: T) => boolean,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const hit = getDecodeCache<T>(code);
  if (hit !== undefined) return { value: hit, cached: true };
  const value = await compute();
  if (isSuccess(value)) setDecodeCache(code, value);
  return { value, cached: false };
}
