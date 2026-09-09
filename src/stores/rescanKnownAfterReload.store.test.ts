import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import type { Product } from "@/types";

// LIVE-PROOF repro (2026-07-22 Playwright run against the deployed build): re-scanning 338 KNOWN
// (already-verified) codes in the SAME session made 0 /api/ai-lookup calls (in-memory deterministic
// matching works). After a page.reload(), re-scanning 30 of those SAME codes made 27 API calls, even
// though the persisted store held 340/340 products WITH primaryBarcode/gtin/upc/ean intact.
//
// Root cause: matchProductByIdentifiers (src/products/match/aliasMatcher.ts:104-111) is the deterministic
// trust gate for a KNOWN identifier match - it filters `products` to `p.verified === true` BEFORE
// checking primaryBarcode/gtin/upc/ean/primarySku. CUSTOMER_SAFE_PRODUCT_FIELDS
// (src/shared/privacy/sensitiveFields.ts), the allowlist buildPersistedScanState's "business"
// branch uses to shape every product before writing to localStorage, does NOT include `verified`.
// So a customer-level reload rehydrates every product with its identifiers intact but `verified`
// silently defaulted to `undefined` (falsy) - matchProductByIdentifiers's `.filter(p => p.verified
// === true)` then excludes EVERY product, resolveScan returns "unknown" for codes that were "known"
// moments earlier, and processScan's auto-decode gate (src/stores/scanStore.ts ~2794) fires
// liveDecode for a code the app already fully knows. Fix: add `verified` to
// CUSTOMER_SAFE_PRODUCT_FIELDS - it is a LOCAL trust-state boolean (not a barcode, not reusable
// alias/catalog data, not sensitive), mirroring the `provisional` fix in 6cd1d93.

function rehydrateAsCustomer(store: ReturnType<typeof createTestScanStore>) {
  const s = store.getState();
  const persisted = buildPersistedScanState(s as unknown as PersistableScanState, "business");
  const rehydrated = JSON.parse(JSON.stringify(persisted));
  store.setState((prev) => ({ ...prev, ...rehydrated }));
}

function verifiedProduct(businessId: string, over: Partial<Product> & { id: string }): Product {
  return {
    businessId, name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "",
    productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
    createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed", ...over,
  };
}

describe("scanStore - re-scan of a KNOWN (verified) code after a customer reload stays deterministic (no live decode)", () => {
  it("known product persists verified:true through the customer reload split and re-scan matches KNOWN with zero review-queue entries", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "777000111226"; // valid UPC-A check digit
    const product = verifiedProduct(store.getState().businessId, {
      id: "p-known-1", name: "Michelin Defender T+H", brand: "Michelin", category: "Tire", primaryBarcode: code,
    });
    store.setState((s) => ({ products: [...s.products, product] }));

    // First scan: deterministic known match, no review queue entry.
    store.getState().processScan(code);
    expect(store.getState().needsReviewQueue.length, "first scan matches known deterministically").toBe(0);
    expect(store.getState().scanFeed.at(-1)?.status).toBe("known");

    // Real full reload: round-trip through the customer ("business") persist split.
    rehydrateAsCustomer(store);

    const rehydratedProduct = store.getState().products.find((p) => p.id === "p-known-1");
    expect(rehydratedProduct?.primaryBarcode, "identifier survives the reload").toBe(code);
    expect(rehydratedProduct?.verified, "verified must survive the reload for the identifier match to stay trusted").toBe(true);

    // Re-scan of the SAME known code after reload: must still resolve deterministically as known,
    // never fall through to the unknown/decode path (which would queue a live AI lookup).
    store.getState().processScan(code);

    expect(store.getState().needsReviewQueue.length, "re-scan after reload must NOT queue for review/decode").toBe(0);
    expect(store.getState().scanFeed.at(-1)?.status, "re-scan after reload resolves known").toBe("known");
    expect(store.getState().finalCounts.find((c) => c.productId === "p-known-1")?.quantity).toBe(2);
  });
});
