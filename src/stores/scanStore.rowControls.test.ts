import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Best-guess identity (owner decision 2026-08-19): a NON-verified decode that produced a usable name
// carries that name on the counted row as a PENDING inline suggestion with confirm controls, whatever
// its decision status - "suggested" or the weaker "needs_review". Confirming (approve, or a human-typed
// identity) teaches a TENANT alias through the existing human-approval core; it never writes anything
// platform-wide. A code that already shows a pending suggestion is never re-decoded on the next scan.
//
// All decode responses are mocked - no live provider is ever called.

const CODE = "0792080004312";

/** A WEAK decode: honest status "needs_review" (not "suggested"), but with a usable product name. */
const WEAK_NEEDS_REVIEW = {
  providerNames: ["gpt-5.5-ladder"],
  results: [
    {
      productName: "Original Anchor Bar Hot Sauce", brand: "Anchor Bar", category: "food",
      specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "",
      aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.35,
      verifiedFacts: [], guesses: ["g"], needsHumanReview: true,
    },
  ],
  decision: {
    status: "needs_review", confidence: 0.35, reason: "Weak evidence.", evidenceStrength: "url_only",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: 0.35, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return { ok: false, json: async () => ({}) } as Response;
    return { ok: true, json: async () => resp } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "any" });
  return store;
}

function decodeCalls(spy: unknown): number {
  const calls = (spy as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls;
  return calls.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "POST").length;
}

function pendingRow(store: ReturnType<typeof aggressiveStore>) {
  return store.getState().scanFeed.find((e) => e.cleanCode === CODE && e.suggestion?.status === "pending");
}

describe("feed row identity controls (best-guess display)", () => {
  it("a WEAK (needs_review) decode with a usable name still gets a pending inline suggestion, banded, on the counted row", async () => {
    const store = aggressiveStore();
    const { restore } = stub(WEAK_NEEDS_REVIEW);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(pendingRow(store)).toBeTruthy());
      const row = pendingRow(store)!;
      expect(row.suggestion?.productName).toContain("Anchor Bar");
      // Raw confidence stays in the data for audit; the band is what the UI renders.
      expect(row.suggestion?.confidence).toBeCloseTo(0.35);
      expect(row.suggestion?.band).toBe("low");
      // The scan counted exactly once (TOP-LEVEL LAW untouched).
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
    } finally {
      restore();
    }
  });

  it("confirmRowIdentity teaches a TENANT approved alias for the typed identity; the next scan resolves known", async () => {
    const store = aggressiveStore();
    const { spy, restore } = stub(WEAK_NEEDS_REVIEW);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(pendingRow(store)).toBeTruthy());
      const row = pendingRow(store)!;
      const callsBefore = decodeCalls(spy);

      store.getState().confirmRowIdentity(row.id, { name: "Buffalo Wing Sauce 12oz", brand: "Anchor Bar" });

      const alias = store.getState().aliases.find((a) => a.cleanCode === CODE);
      expect(alias?.approved).toBe(true);
      const product = store.getState().products.find((p) => p.id === alias?.productId)!;
      expect(product.name).toBe("Buffalo Wing Sauce 12oz");
      expect(product.brand).toBe("Anchor Bar");
      // Tenant-only: confirming never calls out to any server (no learned tier, no shared cache write).
      expect(decodeCalls(spy)).toBe(callsBefore);
      // Idempotent double-tap: a second confirm never counts the item twice.
      store.getState().confirmRowIdentity(row.id, { name: "Buffalo Wing Sauce 12oz" });
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);

      store.getState().processScan(CODE);
      expect(store.getState().scanFeed[0].status).toBe("known");
      expect(store.getState().scanFeed[0].matchedProductId).toBe(product.id);
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);
    } finally {
      restore();
    }
  });

  it("approving the pending suggestion teaches the tenant alias and leaves the count unchanged", async () => {
    const store = aggressiveStore();
    const { restore } = stub(WEAK_NEEDS_REVIEW);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(pendingRow(store)).toBeTruthy());
      const row = pendingRow(store)!;

      store.getState().approveSuggestion(row.id);

      expect(store.getState().aliases.find((a) => a.cleanCode === CODE)?.approved).toBe(true);
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
    } finally {
      restore();
    }
  });

  it("a second scan of a code that already shows a pending suggestion re-uses it and never pays for decode again", async () => {
    const store = aggressiveStore();
    const { spy, restore } = stub(WEAK_NEEDS_REVIEW);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(pendingRow(store)).toBeTruthy());
      const callsAfterFirst = decodeCalls(spy);
      expect(callsAfterFirst).toBe(1);

      store.getState().processScan(CODE);
      await vi.waitFor(() =>
        expect(store.getState().scanFeed.filter((e) => e.suggestion?.status === "pending")).toHaveLength(2),
      );

      // No new decode request, and no duplicate review for the same code.
      expect(decodeCalls(spy)).toBe(callsAfterFirst);
      expect(store.getState().needsReviewQueue.filter((r) => r.cleanCode === CODE)).toHaveLength(1);
      // Both physical scans counted.
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);
    } finally {
      restore();
    }
  });
});
