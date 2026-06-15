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

/**
 * Generate a fresh unique id. crypto.randomUUID is available in Node 24 and in browsers on a
 * secure context (localhost counts). An optional factory is accepted so tests can be deterministic.
 */
export function newId(idFactory?: () => string): string {
  if (idFactory) return idFactory();
  return crypto.randomUUID();
}
