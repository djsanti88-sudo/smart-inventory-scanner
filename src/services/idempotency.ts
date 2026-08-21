import type { SyncOperation } from "@/types";

// Idempotency key construction. A key is built ONCE at scan/resolution time and reused on every
// retry. Never regenerate a key inside a retry loop - that would defeat dedupe and double-count.
// Pure and deterministic: same inputs -> same key, always.

export function buildIdempotencyKey(
  businessId: string,
  sessionId: string,
  scanEventId: string,
  operation: SyncOperation,
): string {
  return [businessId, sessionId, scanEventId, operation].join(":");
}

function canonicalIdempotencyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "number:-0";
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value !== "object") return `${typeof value}:${JSON.stringify(value)}`;
  if (Array.isArray(value)) return `[${value.map(canonicalIdempotencyValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalIdempotencyValue(record[key])}`)
    .join(",")}}`;
}

/**
 * Exact, key-order-independent content identity for versioning a queued write.
 * It is intentionally lossless instead of using a short non-cryptographic hash:
 * FirebaseSyncTarget already maps oversized/unsafe logical keys to SHA-256 document
 * IDs, while retaining the original key on the queue for exact retry replay.
 */
export function stableIdempotencyFingerprint(value: unknown): string {
  return `v1-${canonicalIdempotencyValue(value)}`;
}

/**
 * Generate a fresh unique id. crypto.randomUUID is available in Node 24 and in browsers on a
 * secure context (localhost counts). An optional factory is accepted so tests can be deterministic.
 */
export function newId(idFactory?: () => string): string {
  if (idFactory) return idFactory();
  return crypto.randomUUID();
}
