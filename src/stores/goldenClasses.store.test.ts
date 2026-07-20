import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Identity-outcome golden classes (AI OFF, deterministic, $0). Ledger balance is asserted separately
// in ledgerInvariants.store.test.ts; here we lock the IDENTITY each class resolves to. Wrong identity
// is failure; unknown is acceptable (North-star #3).
function aiOff() {
  const s = createTestScanStore({ db: new MockDb() });
  s.getState().updateSettings({ aiLookupEnabled: false });
  return s;
}

describe("golden code classes: identity outcome per class (AI off)", () => {
  it("MISREAD (bad check digit) never mints a verified/known identity - stays provisional/needs_review", () => {
    const store = aiOff();
    store.getState().processScan("036000291453");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "036000291453");
    // It counts (appears + counts) but only as an unverified provisional, never verified.
    expect(prod?.verified ?? false).toBe(false);
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291453");
    expect(review?.status).toBe("open");
  });

  it("EXAMPLE barcode is never a verified identity", () => {
    const store = aiOff();
    store.getState().processScan("4006381333931");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "4006381333931");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("VENDOR label (ASIN/FNSKU shape) is not treated as a GTIN and routes to review", () => {
    const store = aiOff();
    store.getState().processScan("X004DY7YUT");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "X004DY7YUT");
    expect(review, "a vendor-label code opens a review").toBeDefined();
    const prod = store.getState().products.find((p) => p.primaryBarcode === "X004DY7YUT");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("CONFLICT (context-conflict verified match) does not auto-count against the poisoned product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "xp", businessId: s.businessId, name: "Hot Sauce", brand: "", category: "food", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "xa", businessId: s.businessId, productId: "xp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "xa" }],
    }));
    store.getState().processScan("049000006346");
    // The poisoned product must NOT be the counted identity; the count lands on a safe provisional.
    const poisonedCount = store.getState().finalCounts.find((c) => c.productId === "xp");
    expect(poisonedCount, "conflict never counts against the poisoned product").toBeUndefined();
  });
});
