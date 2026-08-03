import { describe, expect, it, vi } from "vitest";

import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

const EXACT_BOSS_TIRE = {
  providerNames: ["tire-corpus"],
  results: [{
    productName: "Blackhawk Road-H LT 33X12.50R20 114Q",
    brand: "Blackhawk",
    category: "Tire",
    specsShort: "33X12.50R20 114Q",
    specsFull: "",
    primarySku: "BH1600462",
    primaryBarcode: "003220017209",
    gtin: "003220017209",
    upc: "003220017209",
    ean: "",
    aliases: [],
    imageUrl: "",
    productUrl: "",
    sourceUrls: ["https://example.test/tire-corpus"],
    confidence: 1,
    verifiedFacts: [],
    guesses: [],
  }],
  decision: {
    status: "verified",
    confidence: 1,
    reason: "Verified exact tire corpus match.",
    evidenceStrength: "fetched_source",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "agree" },
  },
};

describe("approved Boss alias re-scan", () => {
  it("still counts an existing provisional re-scan without requesting a decode when AI is disabled", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    store.getState().processScan("3220017209");

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      store.getState().processScan("3220017209");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(2);
    expect(store.getState().needsReviewQueue.find((review) => review.cleanCode === "3220017209")?.status).toBe("open");
  });

  it("re-decodes an existing provisional row and heals it without losing either physical count", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    store.getState().processScan("3220017209");

    const initialReview = store.getState().needsReviewQueue.find((review) => review.cleanCode === "3220017209")!;
    expect(initialReview.status).toBe("open");
    expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(1);

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => EXACT_BOSS_TIRE })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
      store.getState().updateSettings({ aiLookupEnabled: true });
      store.getState().processScan("3220017209");

      await vi.waitFor(() => expect(store.getState().needsReviewQueue.find((review) => review.id === initialReview.id)?.status).toBe("resolved"));
    } finally {
      globalThis.fetch = originalFetch;
    }

    const decodeCalls = (fetchSpy as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
      .filter(([, init]) => typeof init?.body === "string" && JSON.parse(init.body).mode === "decode");
    expect(decodeCalls).toHaveLength(1);
    expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(2);
    const healed = store.getState().products.find((product) => product.brand === "Blackhawk");
    expect(healed?.verified).toBe(true);
    expect(store.getState().aliases.some((alias) => alias.cleanCode === "3220017209" && alias.approved)).toBe(true);
  });
});
