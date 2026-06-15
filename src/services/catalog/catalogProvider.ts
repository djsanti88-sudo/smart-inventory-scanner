import type { CatalogCandidate, CatalogEntry, LookupDecision, ShopOverride } from "./catalogTypes";

// The seam a future cloud database implements. The app only ever talks to this interface, so swapping
// LocalCatalogProvider for a Firebase implementation later requires no caller changes.
//
// Lookup precedence (the deterministic local alias/product check happens BEFORE the catalog, in the
// resolver): shop override -> verified catalog -> weak catalog -> none. AI is the caller's fallback.
export interface CatalogProvider {
  /** Decide what an unknown (resolver = needs_review) code resolves to from override/catalog data. */
  decide(codes: string[], businessId: string): LookupDecision;
  /** Owner/admin/trusted verified write. Creates or strengthens a verified entry. */
  upsertVerified(candidate: CatalogCandidate, by: string): void;
  /** AI suggestion write. NEVER overwrites a verified entry's identity or status (only observes it). */
  submitPending(candidate: CatalogCandidate): void;
  /** A confirmed resolution from the catalog itself: bump usage stats, do not change identity. */
  observe(codes: string[]): void;
  /** Private, shop-scoped override (never merged into the global catalog). */
  setOverride(override: ShopOverride): void;
  snapshot(): { catalog: CatalogEntry[]; overrides: ShopOverride[] };
}
