import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Phase-2 REVIEW-FLOW POISON GUARD.
// The live poison: 078742051451 (Sam's / Member's Mark water) became a VERIFIED product + APPROVED alias
// for "Velvet Torch Womens Lace Strapless Dress" by one-click approving a weak AI suggestion in Needs
// Review. Guard rule: accepting an AI suggestion the app could NOT back with real evidence (no brand,
// no gtin/upc/ean, no source) must NOT create a verified product, an approved alias, a verified catalog
// entry, or a count - so a future scan never resolves deterministically to a wrong product. A human
// typing their OWN product (not the AI's guess) is unaffected.

const WATER_CODE = "078742051451";
const DRESS = "Velvet Torch Womens Lace Strapless Dress";

// AI returns the plausible-but-wrong product with NO evidence (the historical poison shape).
const DRESS_SUGGESTION = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: DRESS, brand: "", category: "", gtin: "", upc: "", ean: "", sourceUrls: [], verifiedFacts: [], guesses: ["guess"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return () => (globalThis.fetch = original);
}
function aiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}
async function seedDressSuggestion() {
  const store = aiStore();
  const restore = stub(DRESS_SUGGESTION);
  try {
    store.getState().processScan(WATER_CODE);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.suggestedProductName).toBe(DRESS));
  } finally {
    restore();
  }
  return store;
}
// The exact payload the "Approve suggestion" button sends (NeedsReviewTable).
function approveSuggestionPayload(review: { suggestedProductName: string; suggestedBrand: string; suggestedCategory: string; suggestedGtin: string; suggestedUpc: string; suggestedEan: string; suggestedPrimaryBarcode: string; suggestedProductUrl: string; cleanCode: string }) {
  return {
    applyToCount: true,
    newProduct: {
      name: review.suggestedProductName,
      brand: review.suggestedBrand,
      category: review.suggestedCategory,
      gtin: review.suggestedGtin,
      upc: review.suggestedUpc,
      ean: review.suggestedEan,
      primaryBarcode: review.suggestedPrimaryBarcode || review.cleanCode,
      productUrl: review.suggestedProductUrl,
    },
  };
}

describe("Phase-2 review-flow poison guard (078742051451 -> dress)", () => {
  it("approving the weak dress suggestion creates NO verified product, NO approved alias, but provisionally counts", async () => {
    const store = await seedDressSuggestion();
    const review = store.getState().needsReviewQueue.at(-1)!;
    store.getState().resolveUnknown(review.id, "create_new", approveSuggestionPayload(review));

    const dressProduct = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    if (dressProduct) expect(dressProduct.verified, "dress product must not be verified").toBe(false);
    const dressAlias = store.getState().aliases.find((a) => a.cleanCode === WATER_CODE);
    if (dressAlias) expect(dressAlias.approved, "078742051451 alias must not be approved").toBe(false);
    expect(store.getState().finalCounts, "the dress provisionally counts").toHaveLength(1);
    const prov = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === WATER_CODE)?.verificationStatus).not.toBe("verified");
  });

  it("ROBUSTNESS: accepting the weak suggestion via a CASE + hedge-phrase name variant is STILL caught (no verified product / approved alias, but provisionally counts)", async () => {
    const store = await seedDressSuggestion();
    const review = store.getState().needsReviewQueue.at(-1)!;
    // Same evidence-less suggestion, but the saved name differs from the suggestion only by CASE and a
    // hedge phrase that cleanProductName strips. The old exact-string match would miss this and wrongly
    // mint a verified product; the normalized guard must still catch it.
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      newProduct: {
        name: DRESS.toUpperCase() + " (likely wholesale)",
        brand: "", category: "", gtin: "", upc: "", ean: "",
        primaryBarcode: review.cleanCode, productUrl: "",
      },
    });
    const dressProduct = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    if (dressProduct) expect(dressProduct.verified, "case/hedge variant must not be verified").toBe(false);
    const dressAlias = store.getState().aliases.find((a) => a.cleanCode === WATER_CODE);
    if (dressAlias) expect(dressAlias.approved, "case/hedge variant alias must not be approved").toBe(false);
    expect(store.getState().finalCounts, "case/hedge variant provisionally counts").toHaveLength(1);
    const prov = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("after approving the weak dress, a re-scan of 078742051451 increments the provisional product (no verified/approved)", async () => {
    const store = await seedDressSuggestion();
    const review = store.getState().needsReviewQueue.at(-1)!;
    store.getState().resolveUnknown(review.id, "create_new", approveSuggestionPayload(review));
    const restore = stub(DRESS_SUGGESTION);
    try {
      store.getState().processScan(WATER_CODE); // re-scan: increments the provisional product
    } finally {
      restore();
    }
    const dressProduct = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    expect(dressProduct).toBeDefined();
    expect(dressProduct!.provisional).toBe(true);
    expect(dressProduct!.verified).toBe(false);
    expect(store.getState().finalCounts).toHaveLength(1);
    // The dress is still NOT an approved alias - the poison guard prevents that.
    const dressAlias = store.getState().aliases.find((a) => a.cleanCode === WATER_CODE);
    if (dressAlias) expect(dressAlias.approved, "alias must not be approved").toBe(false);
  });

  it("SURGICAL: a human typing their OWN product (not the AI's guess) is still verified + counted", async () => {
    const store = await seedDressSuggestion();
    const review = store.getState().needsReviewQueue.at(-1)!;
    // Human ignores the dress and creates a real product they know (name != the suggested dress).
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Member's Mark Purified Water", brand: "Member's Mark" },
    });
    const prod = store.getState().products.find((p) => p.name === "Member's Mark Purified Water");
    expect(prod?.verified, "a deliberate human product stays verified").toBe(true);
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().aliases.find((a) => a.cleanCode === WATER_CODE)?.approved).toBe(true);
  });
});
