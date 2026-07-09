import "server-only";

// Provenance purge / revalidate. ONE-COMMAND QUARANTINE for corpus rows learned from a paid
// decode source (Go-UPC, GPT, Fetch V2).
//
// SAFETY CONTRACT (owner-locked):
//  - Operates ONLY on the passed-in store (the persisted product/alias store). It NEVER imports
//    the filesystem and NEVER touches the raw paid-response evidence store -- that store is
//    purge-proof and survives every corpus purge. Enforced statically by corpusPurge.test.ts.
//  - Origin, not target, decides. A row is purged/flagged ONLY when its OWN `source` equals the
//    quarantined source. A human-approved alias that happens to point at a purged product is kept:
//    human links are fully trusted.
//  - dry-run:   counts matches, mutates nothing.
//  - purge:     deletes matching product rows AND matching alias rows. Human rows untouched.
//  - revalidate: sets `needsRevalidation: true` on matching rows for re-decode on next scan. Deletes
//               nothing.
//
// The persisted store this runs against is the MockDb product/alias store (src/services/mockDb.ts):
// `products: Record<id, Product>` + `aliases: Record<key, Alias>`, each row carrying a `source`
// provenance token. The decode pipeline persists decoded products/aliases there (SAVE_PRODUCT /
// RESOLVE_ALIAS). `MockDbLike` is the minimal structural view this operation needs, so the same code
// works against the real MockDb and against a seeded in-memory test store.

/** The provenance tokens that identify a paid-decode rung as the origin of a corpus row. */
export type PurgeSource = "go-upc" | "gpt" | "fetchv2";

export type PurgeMode = "dry-run" | "purge" | "revalidate";

/** A stored product row: only the provenance token + the revalidation flag matter here. */
export interface PurgeableProduct {
  id: string;
  source: string;
  needsRevalidation?: boolean;
  [key: string]: unknown;
}

/** A stored alias row: only its own provenance token + the revalidation flag matter here. */
export interface PurgeableAlias {
  productId: string;
  source: string;
  needsRevalidation?: boolean;
  [key: string]: unknown;
}

/**
 * Minimal structural view of the persisted product/alias store (MockDbState in
 * src/services/mockDb.ts). Both maps are keyed exactly as the real store keys them; this operation
 * mutates them in place (delete keys on purge, set flags on revalidate).
 */
export interface MockDbLike {
  products: Record<string, PurgeableProduct>;
  aliases: Record<string, PurgeableAlias>;
}

export interface PurgeResult {
  /** How many rows (products + aliases) carry the target provenance. */
  matched: number;
  /** How many rows were deleted (purge mode only; 0 otherwise). */
  removed: number;
  /** How many rows were flagged for re-decode (revalidate mode only; 0 otherwise). */
  requeued: number;
}

/**
 * Purge, dry-run, or revalidate every corpus row whose OWN provenance is `opts.source`.
 * Mutates `opts.store` in place. Returns the counts.
 */
export function purgeBySource(opts: {
  source: PurgeSource;
  mode: PurgeMode;
  store: MockDbLike;
}): PurgeResult {
  const { source, mode, store } = opts;

  const productKeys = Object.keys(store.products).filter((k) => store.products[k].source === source);
  const aliasKeys = Object.keys(store.aliases).filter((k) => store.aliases[k].source === source);
  const matched = productKeys.length + aliasKeys.length;

  if (mode === "dry-run") {
    return { matched, removed: 0, requeued: 0 };
  }

  if (mode === "revalidate") {
    for (const k of productKeys) store.products[k].needsRevalidation = true;
    for (const k of aliasKeys) store.aliases[k].needsRevalidation = true;
    return { matched, removed: 0, requeued: aliasKeys.length + productKeys.length };
  }

  // mode === "purge"
  for (const k of productKeys) delete store.products[k];
  for (const k of aliasKeys) delete store.aliases[k];
  return { matched, removed: matched, requeued: 0 };
}
