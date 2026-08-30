// countedByUid.ts (reconcile Task 7) - the wiring bridge between a reconcile match's corpus
// candidate (keyed by canonical_product_uid) and the scan session's finalCounts (keyed by
// scanStore productId). PURE service: no React/next imports, no store access - callers pass
// products/aliases/finalCounts in.
//
// Trust rule: the bridge is DETERMINISTIC and trust-gated. A corpus candidate maps to a local
// product ONLY through the existing resolver (resolveRawScan: approved alias or verified product
// identifier). No fuzzy matching, no unverified suggestions. A matched row the resolver cannot
// bridge simply stays absent from countedByUid, and buildReconcileReport honestly buckets it
// expected_not_counted (AM-R8) instead of inventing a counted quantity.

import { resolveRawScan } from "@/products/match/resolver";
import type { MatchResult } from "@/reconcile/match/identityMatcher";
import type { Product, Alias, InventoryCount } from "@/types";

/**
 * Map candidate.uid -> counted quantity THIS session, for every matched result whose corpus
 * candidate deterministically resolves (via barcode first, then part number) to a product that
 * has a finalCounts row. Everything else is left out (absent key = not counted, per AM-R8).
 */
export function deriveCountedByUid(
  matches: MatchResult[],
  products: Product[],
  aliases: Alias[],
  finalCounts: InventoryCount[],
  businessId: string,
): Record<string, number> {
  const qtyByProductId = new Map<string, number>();
  for (const c of finalCounts) qtyByProductId.set(c.productId, c.quantity);

  const out: Record<string, number> = {};
  for (const m of matches) {
    if (m.status !== "matched" || !m.candidate) continue;
    const codes = [m.candidate.barcode, m.candidate.partNumber].filter(
      (c): c is string => !!c && c.trim().length > 0,
    );
    let productId: string | null = null;
    for (const code of codes) {
      const res = resolveRawScan(code, products, aliases, businessId);
      if (res.resolverStatus === "known" && res.productId) {
        productId = res.productId;
        break;
      }
    }
    if (!productId) continue;
    const qty = qtyByProductId.get(productId);
    if (qty === undefined) continue;
    out[m.candidate.uid] = qty;
  }
  return out;
}
