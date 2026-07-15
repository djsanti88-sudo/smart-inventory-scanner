import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// A3/AM-2 (owner-ratified 2026-07-15): a scan of a code whose GS1 check digit fails must NEVER
// dispatch the decode ladder - every GTIN rung is doomed by a bad check digit, so auto-decode would
// only burn time and cap budget. The row must still land as a normal needs_review row (aliasable via
// the existing review flow) with the additive misread reason. A valid unknown GTIN must be
// unaffected - it still dispatches exactly one decode fetch, following the established mock pattern
// in autoDecode.test.ts / scanStore.decodeCap.test.ts.

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
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
  providerNames: ["gemini", "openai"],
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
