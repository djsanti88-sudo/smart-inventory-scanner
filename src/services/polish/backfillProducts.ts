// Build 2 / Task 4: pure backfill transform reused by scripts/polish-backfill.mts (offline JSON
// snapshots) and the scanStore persist migration (real users' browser-local data - see scanStore.ts
// `migrate` v5 -> v6). Pure, no React/next/fs imports so it is unit-testable and safe on both sides.

// NOTE: relative + explicit ".ts" extensions - see structuredFields.ts for why (this module is also
// imported directly, standalone, by scripts/polish-backfill.mts under plain `node`).
import { safeStructuredFieldsFor } from "./structuredFields.ts";
import type { Product } from "../../types.ts";

export interface BackfillResult {
  products: Product[];
  changedIds: string[];
  skippedHumanIds: string[];
}

/**
 * Applies deterministic structuring to every product NOT already marked `structuredBy: "human"`.
 * Idempotent: structureProduct is a pure function of (name, brand), so running this twice on the
 * same input yields the same output and an empty `changedIds` the second time.
 */
export function backfillProducts(products: Product[]): BackfillResult {
  const changedIds: string[] = [];
  const skippedHumanIds: string[] = [];

  const updated = products.map((p) => {
    if (p.structuredBy === "human") {
      skippedHumanIds.push(p.id);
      return p;
    }
    // safeStructuredFieldsFor (not structuredFieldsFor): a structurer throw on one bad row must
    // never brick the whole backfill (persist hydration on real users' data, or this CLI's run).
    const patch = safeStructuredFieldsFor(p.name, p.brand, p.structuredBy);
    const next: Product = { ...p, ...patch };
    const changed =
      next.structuredBrand !== p.structuredBrand ||
      next.structuredModel !== p.structuredModel ||
      next.structuredDescription !== p.structuredDescription ||
      next.sizeTag !== p.sizeTag ||
      next.structuredBy !== p.structuredBy;
    if (changed) changedIds.push(p.id);
    return next;
  });

  return { products: updated, changedIds, skippedHumanIds };
}
