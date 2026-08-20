import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { CatalogEntry } from "@/services/catalog/catalogTypes";

// Regression proof for 827e398 (retail/global catalog resolves as Known) under the CORRECTED rule:
//   - A safe catalog-backed match must resolve AUTOMATICALLY (no AI, NOT the old Needs Review bottleneck).
//   - A scan with no catalog hit and no safe evidence must FAIL SAFELY: no wrong count, no fake verified
//     product, no approved wrong alias. (For the unrecoverable case, "open Needs Review" IS the safe-fail.)
// 078742051451 is Sam's / Member's Mark purified water (Open Food Facts). It must resolve as WATER and
// must NEVER auto-become the historical poison "Velvet Torch Womens Lace Strapless Dress".

const WATER_CODE = "078742051451";
const WATER_NAME = "Member's Mark Purified Water";
const NOW = "2026-06-12T10:00:00.000Z";

// A verified retail catalog entry, exactly the shape scanStore.lookupGlobalCatalog returns for a retail hit
// (verificationStatus "verified", by "trusted_source").
function waterEntry(): CatalogEntry {
  return sanitizeCatalogEntry(
    { barcode: WATER_CODE, normalizedBarcode: WATER_CODE, name: WATER_NAME, brand: "Member's Mark", category: "Beverages" },
    { now: NOW, verificationStatus: "verified", verifiedBy: null, by: "trusted_source" },
  );
}

// Injected retail/global catalog lookup: returns the water for WATER_CODE, a miss (null) for anything else.
const retailLookup = (codes: string[]): Promise<CatalogEntry | null> =>
  Promise.resolve(codes.includes(WATER_CODE) ? waterEntry() : null);

function stubFetch(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}
const callCount = (spy: unknown) => (spy as { mock: { calls: unknown[] } }).mock.calls.length;

function storeWithRetail(lookup: (codes: string[]) => Promise<CatalogEntry | null> = retailLookup) {
  const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog: lookup });
  store.setState({ online: true });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

// AI response that would offer the historical WRONG product with NO safe evidence. It must never be trusted.
const DRESS_NO_EVIDENCE = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "Velvet Torch Womens Lace Strapless Dress", brand: "", category: "", sourceUrls: [], verifiedFacts: [], guesses: ["guess"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};
// AI response with no usable product at all.
const NOPRODUCT = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "", brand: "", category: "", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0 }],
  decision: { status: "needs_review", confidence: 0, reason: "No product", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

describe("retail catalog resolution (827e398): recoverable -> Known, unsafe -> safe-fail", () => {
  it("078742051451 resolves as Member's Mark water automatically (no AI, no Needs Review, not the dress)", async () => {
    const store = storeWithRetail();
    // Even if the AI WOULD have guessed the dress, the catalog hit must win first and the AI must never run.
    const { spy, restore } = stubFetch(DRESS_NO_EVIDENCE);
    try {
      store.getState().processScan(WATER_CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.status).toBe("resolved"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.name === WATER_NAME);
    expect(prod, "water product must be created from the catalog hit").toBeDefined();
    expect(prod!.name).not.toMatch(/velvet torch|dress/i);
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(callCount(spy)).toBe(0); // resolved from catalog: NO AI, NOT the old Needs Review bottleneck
    expect(store.getState().scanFeed.some((e) => e.cleanCode === WATER_CODE && e.decodeStatus === "verified")).toBe(true);
    expect(store.getState().needsReviewQueue.some((r) => r.cleanCode === WATER_CODE && r.status === "open")).toBe(false);
  });

  it("a code with NO catalog hit and NO usable AI product provisionally counts as Unidentified item (review stays open)", async () => {
    const store = storeWithRetail(() => Promise.resolve(null));
    const UNKNOWN = "999000111222";
    const { restore } = stubFetch(NOPRODUCT);
    try {
      store.getState().processScan(UNKNOWN);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).not.toBe("decoding"));
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.at(-1)?.status).toBe("open"); // review stays open
    // Provisionally counted as "Unidentified item" — scan 10 = count 10, even with no AI product
    expect(store.getState().products.some((p) => p.primaryBarcode === UNKNOWN && p.provisional === true)).toBe(true);
    expect(store.getState().finalCounts).toHaveLength(1);
  });

  it("an AI-only dress guess with no safe evidence provisionally counts but is NEVER verified/approved", async () => {
    const store = storeWithRetail(() => Promise.resolve(null)); // force the AI path (no catalog hit)
    const { restore } = stubFetch(DRESS_NO_EVIDENCE);
    try {
      store.getState().processScan(WATER_CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    // The dress provisionally counts but is NEVER verified/approved.
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    expect(store.getState().needsReviewQueue.at(-1)?.status).toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === WATER_CODE)?.verificationStatus).not.toBe("verified");
  });
});
