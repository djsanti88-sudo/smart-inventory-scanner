import type { InventoryCount, Product } from "@/types";
import { isUsableProductName } from "@/services/ai/decode";

// Identify junk inventory rows: counts whose product name is NOT a usable product name (a website
// title, hedge, placeholder, blank, or an orphaned count whose product is gone). Pre-firewall junk
// can still be sitting in a user's inventory; this finds it so it can be backed up and removed.
//
// SAFETY: a product/alias is only marked for removal if NO surviving (non-junk) count references it,
// so a good row can never lose its product. Pure module (no React/next), unit-testable.

export interface JunkCleanupPlan {
  junkCountIds: string[];
  junkProductIds: string[];
  junkPreview: Array<{ productId: string; name: string; quantity: number }>;
}

export function findJunkCounts(counts: InventoryCount[], products: Product[]): JunkCleanupPlan {
  const byId = new Map(products.map((p) => [p.id, p] as const));

  const junkCounts = counts.filter((c) => !isUsableProductName(byId.get(c.productId)?.name ?? ""));
  const junkCountIds = junkCounts.map((c) => c.id);
  const junkCountIdSet = new Set(junkCountIds);

  // Products still referenced by a SURVIVING (non-junk) count must not be removed.
  const survivingProductIds = new Set(
    counts.filter((c) => !junkCountIdSet.has(c.id)).map((c) => c.productId),
  );
  const junkProductIds = [...new Set(junkCounts.map((c) => c.productId))].filter(
    (pid) => !survivingProductIds.has(pid),
  );

  const junkPreview = junkCounts.map((c) => ({
    productId: c.productId,
    name: byId.get(c.productId)?.name ?? "",
    quantity: c.quantity,
  }));

  return { junkCountIds, junkProductIds, junkPreview };
}
