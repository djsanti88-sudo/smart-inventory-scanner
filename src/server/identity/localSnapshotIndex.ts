import type { IdentityCandidate } from "@/services/identity/types";

/**
 * Immutable, locally injected candidate indexes for identity preview. The adapter deliberately
 * holds every exact-key collision; decisions, not retrieval, decide whether a collision is safe.
 */
export interface LocalIdentitySnapshot {
  catalogVersion: string;
  catalogSnapshotHash: string;
  barcodeCandidates: ReadonlyMap<string, readonly IdentityCandidate[]>;
  partNumberCandidates: ReadonlyMap<string, readonly IdentityCandidate[]>;
}

function lookupAll(
  index: ReadonlyMap<string, readonly IdentityCandidate[]>,
  keys: readonly string[],
): IdentityCandidate[] {
  const candidates: IdentityCandidate[] = [];
  for (const key of new Set(keys)) {
    const hits = index.get(key);
    if (hits) candidates.push(...hits);
  }
  return candidates;
}

/** Returns every local exact-barcode hit, including collisions. */
export function lookupAllLocalBarcodes(snapshot: LocalIdentitySnapshot, keys: readonly string[]): IdentityCandidate[] {
  return lookupAll(snapshot.barcodeCandidates, keys);
}

/** Returns every local exact-manufacturer-part-number hit, including collisions. */
export function lookupAllLocalPartNumbers(snapshot: LocalIdentitySnapshot, keys: readonly string[]): IdentityCandidate[] {
  return lookupAll(snapshot.partNumberCandidates, keys);
}
