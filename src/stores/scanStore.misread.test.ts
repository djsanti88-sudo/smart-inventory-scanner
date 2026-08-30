import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/products/catalog/sanitizeCatalog";
import type { CatalogEntry } from "@/products/catalog/catalogTypes";

// A3/AM-2 (owner-ratified 2026-07-15): a scan of a code whose GS1 check digit fails must NEVER
// dispatch the decode ladder - every GTIN rung is doomed by a bad check digit, so auto-decode would
// only burn time and cap budget. The row must still land as a normal needs_review row (aliasable via
// the existing review flow) with the additive misread reason. A valid unknown GTIN must be
// unaffected - it still dispatches exactly one decode fetch, following the established mock pattern
// in autoDecode.test.ts / scanStore.decodeCap.test.ts.

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

function stubFetch(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    json: async () => resp,
  }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, restore: () => (globalThis.fetch = original) };
}

const VERIFIED = {
  providerNames: ["gpt-5.4-mini"],
  results: [
    {
      productName: "Coca-Cola Classic",
      brand: "Coca-Cola",
      upc: "878106003504",
      sourceUrls: ["https://gs1.org/878106003504"],
      verifiedFacts: [],
      guesses: [],
      aliases: [],
      confidence: 0.97,
    },
  ],
  decision: {
    status: "verified",
    confidence: 0.97,
    reason: "Verified AI Decode",
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "agree" },
  },
};

describe("A3 misread gate: scanStore skips auto-decode for a bad-check-digit code", () => {
  it("a misread code (bad check digit) produces a needs_review row with ZERO decode fetch dispatches", async () => {
    const store = aggressiveStore();
    const { spy, restore } = stubFetch(VERIFIED);
    try {
      // 049000006345: GTIN-shaped, invalid GS1 check digit (verified against gtin.ts logic).
      const event = store.getState().processScan("049000006345");
      // give any accidental async dispatch a chance to fire before asserting zero calls
      await new Promise((r) => setTimeout(r, 20));

      expect(event).not.toBeNull();
      expect(event!.status).toBe("needs_review");
      const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "049000006345" && r.status === "open");
      expect(review).toBeTruthy();
      expect(review!.decodeStatus).toBe("needs_review");
      expect(review!.reason).toContain("Barcode check digit fails");
      expect(review!.reason).toContain("scanner misread");

      const decodeCalls = spy.mock.calls.filter((c) => String(c[0]).includes("/api/ai-lookup"));
      expect(decodeCalls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("a valid unknown GTIN still dispatches exactly one decode fetch (unaffected by the misread gate)", async () => {
    const store = aggressiveStore();
    const { spy, restore } = stubFetch(VERIFIED);
    try {
      // 878106003504: valid GS1 check digit, unknown code (not in seed).
      store.getState().processScan("878106003504");
      await vi.waitFor(() => {
        const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "878106003504");
        expect(review?.decodeStatus).toBe("verified");
      });

      const decodeCalls = spy.mock.calls.filter((c) => String(c[0]).includes("/api/ai-lookup"));
      expect(decodeCalls.length).toBe(1);
    } finally {
      restore();
    }
  });
});

// QA HARDENING FIX #6+#7 (live-proven, 2026-07-16): the deterministic catalog-first seam
// (decideLookup/findEntry in localCatalogProvider.ts) matches on codeSet.has(entry.normalizedBarcode)
// with NO check-digit validation - it runs BEFORE the misread gate has any effect on it. A misread
// (bad-check-digit) code that happens to string-match a seeded catalog entry's normalizedBarcode
// (a coincidental collision - e.g. the same value the corpus/retail zero-pad variant machinery would
// also try) previously minted a FABRICATED named product via resolveUnknown("create_new",
// {origin:"catalog"}), even though the row was independently flagged "check digit fails - may be a
// scanner misread". Wrong identity is FAILURE; unknown is ACCEPTABLE - the misread code must still
// appear + count (top-level law: scan10=count10) but attach NO identity. Fix #7: with no fabricated
// name attached, review.suggestedProductName/hasSuggestion agrees with Counts (both show "Unidentified
// item"), so Needs Review's "No suggestion" and the Counts placeholder are no longer contradictory.
describe("QA fix #6+#7: misread code never attaches a catalog identity (three surfaces agree)", () => {
  const NOW = "2026-07-16T00:00:00.000Z";
  // 012345678900: GTIN-shaped (12 digits), GS1 check digit FAILS (live-proven root cause code).
  const MISREAD_CODE = "012345678900";

  function verifiedEntry(code: string, name: string): CatalogEntry {
    return sanitizeCatalogEntry(
      { barcode: code, normalizedBarcode: code, name, brand: "Healthyholics", confidence: 0.9 },
      { now: NOW, verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
    );
  }

  it("a misread code that coincidentally matches a seeded catalog entry mints NO identity - stays Unidentified, still counts, and resolveUnknown('create_new', origin:'catalog') is never invoked", () => {
    const store = aggressiveStore();
    // Seed a verified catalog entry keyed to the EXACT misread code (simulates a coincidental
    // zero-pad/collision hit against decideLookup's codeSet.has(entry.normalizedBarcode)). The brand
    // is deliberately plain (not a known GS1-prefix-floor brand like "Healthyholics") so the ONLY
    // possible source of a name on this row is the catalog seam this fix gates - a clean signal.
    store.setState({ catalog: [verifiedEntry(MISREAD_CODE, "Definitely Real Product Name Inc")] });

    const resolveUnknownSpy = vi.spyOn(store.getState(), "resolveUnknown");

    const event = store.getState().processScan(MISREAD_CODE);

    expect(event).not.toBeNull();
    expect(event!.status).toBe("needs_review");

    // No "create_new"/origin:"catalog" resolution ever fired for the misread code (behavioral proof
    // the catalog seam was skipped, not just that its outcome happens to look right).
    const catalogCreateCalls = resolveUnknownSpy.mock.calls.filter(
      ([, action, payload]) => action === "create_new" && payload?.origin === "catalog",
    );
    expect(catalogCreateCalls.length).toBe(0);

    // The review stays open with the honest misread reason - no fabricated brand/name anywhere.
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === MISREAD_CODE && r.status === "open");
    expect(review).toBeTruthy();
    expect(review!.reason).toContain("scanner misread");
    // Fix #7: suggestedProductName is never populated with the catalog's REAL product name (only the
    // safe "Unidentified item" / prefix-floor "unconfirmed" placeholder text, if anything) and
    // hasSuggestion stays false - Needs Review's "No suggestion" rendering (gated on hasSuggestion,
    // see NeedsReviewTable.tsx) agrees with Counts.
    expect(review!.hasSuggestion).toBe(false);
    expect(review!.suggestedProductName).not.toMatch(/definitely real product name/i);

    // TOP-LEVEL LAW: still appears + counts (scan10=count10) - just with no fabricated identity. The
    // product minted for this code is the safe provisional placeholder (a bare "Unidentified item" or,
    // for a code whose GS1 prefix happens to map to a known brand, an honest "<brand> / product
    // unconfirmed" naming aid - see prefixFloorName, never marked verified) - never the catalog's real
    // fabricated name.
    expect(store.getState().finalCounts).toHaveLength(1);
    expect(store.getState().finalCounts[0].quantity).toBe(1);
    const countedProduct = store.getState().products.find((p) => p.id === store.getState().finalCounts[0].productId);
    expect(countedProduct).toBeTruthy();
    expect(countedProduct!.name).not.toMatch(/definitely real product name/i);
    expect(countedProduct!.verified).toBe(false);
    expect(store.getState().products.some((p) => p.name === "Definitely Real Product Name Inc")).toBe(false);
  });

  it("REGRESSION: a VALID GTIN with a seeded verified catalog entry still resolves known + counts (catalog-first path unaffected)", () => {
    const store = aggressiveStore();
    const VALID_CODE = "878106003504"; // valid GS1 check digit (reused from the suite above)
    store.setState({ catalog: [verifiedEntry(VALID_CODE, "Catalog Cola")] });
    const { spy, restore } = stubFetch(VERIFIED);
    try {
      store.getState().processScan(VALID_CODE);
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled(); // AI never consulted - catalog-first resolved it
    const prod = store.getState().products.find((p) => p.name === "Catalog Cola");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
  });

  it("REGRESSION: a non-GTIN alpha SKU with an approved alias still resolves known (case-fold path unaffected by the misread gate)", () => {
    const store = createTestScanStore({ db: new MockDb() }); // AI off; deterministic alias path only
    const businessId = store.getState().businessId;
    // ZQ998877 (not the T432119 seed fixture used elsewhere in the suite - a genuinely unused alpha
    // SKU) so this product/alias is the ONLY match and the resolver never sees a conflict.
    const shopProduct = {
      id: "shop-prod-alpha", name: "Alpha SKU Tire", brand: "ShopBrand", verified: true, status: "active" as const,
      businessId, category: "", imageUrl: "", primaryBarcode: "", primarySku: "ZQ998877",
      specsShort: "", specsFull: "", productUrl: "", location: "", notes: "", gtin: "", upc: "", ean: "",
      vendorCodes: [], aliases: ["ZQ998877"], source: "manual" as const, confidence: 1,
      createdAt: NOW, updatedAt: NOW, createdBy: "human", updatedBy: "human",
    };
    const shopAlias = {
      id: "alias-alpha", productId: "shop-prod-alpha", businessId,
      rawCodeExample: "ZQ998877", cleanCode: "ZQ998877", normalizedCode: "ZQ998877",
      aliasType: "sku" as const, source: "manual" as const, confidence: 1,
      approved: true, createdAt: NOW, updatedAt: NOW, createdBy: "human",
      lastSeenAt: NOW, syncStatus: "synced" as const, idempotencyKey: "k-alpha",
    };
    store.setState((s) => ({ products: [...s.products, shopProduct], aliases: [...s.aliases, shopAlias] }));

    // Lowercase scan of the alpha SKU (case-fold path, fix #1) - never GTIN-shaped, so
    // isLikelyMisreadGtin is always false for it and the alias resolver is never touched by this fix.
    store.getState().processScan("zq998877");

    expect(store.getState().finalCounts.find((c) => c.productId === "shop-prod-alpha")?.quantity).toBe(1);
    expect(store.getState().needsReviewQueue.filter((r) => r.cleanCode === "zq998877")).toHaveLength(0);
  });
});
