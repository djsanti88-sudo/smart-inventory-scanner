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

  // AUTO-APPLIED (>= 0.8) path, e.g. a retail-corpus exact hit at 0.85: the identity is applied onto the
  // provisional row and the review auto-closes, so there is NO pending inline suggestion. The row's
  // one-tap Approve must still confirm through the same human-approval core, and it must do so on the
  // ORIGINAL review record - never by reopening a blank one that wipes the decode's confidence and
  // evidence fields (the audit trail of what the app actually saw) and falsely stamps reopenedFromWrong.
  it("confirmRowIdentity on an AUTO-APPLIED (0.85, review auto-resolved) row teaches the alias on the original review, keeping its decode fields", async () => {
    const store = aggressiveStore();
    const { restore } = stub({
      ...WEAK_NEEDS_REVIEW,
      providerNames: ["retail-corpus"],
      results: [{ ...WEAK_NEEDS_REVIEW.results[0], productName: "Chandelle Sabor Chocolate", brand: "Nestle", confidence: 0.85 }],
      decision: { ...WEAK_NEEDS_REVIEW.decision, status: "suggested", confidence: 0.85, evidenceStrength: "none" },
    });
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE)?.status).toBe("resolved"),
      );
      const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE)!;
      expect(review.resolvedBy).toBe("auto");
      const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
      expect(row.suggestion, "auto-applied rows carry no pending inline suggestion").toBeUndefined();
      const product = store.getState().products.find((p) => p.id === review.provisionalProductId)!;
      expect(product.verified, "auto-apply never verifies").toBe(false);

      store.getState().confirmRowIdentity(row.id, { name: review.suggestedProductName, brand: review.suggestedBrand });

      expect(store.getState().aliases.find((a) => a.cleanCode === CODE)?.approved).toBe(true);
      const confirmed = store.getState().products.find((p) => p.id === product.id)!;
      expect(confirmed.verified).toBe(true);
      expect(confirmed.name).toBe("Chandelle Sabor Chocolate");
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
      // Same review record, human-resolved, decode audit fields intact.
      const after = store.getState().needsReviewQueue.filter((r) => r.cleanCode === CODE);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(review.id);
      expect(after[0].resolvedBy).toBe("human");
      expect(after[0].confidence).toBeCloseTo(0.85);
      expect(after[0].decodeStatus).toBe("suggested");
      expect(after[0].reopenedFromWrong).not.toBe(true);
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

  // F5 (trust): the prefix floor's "<Brand> / product unconfirmed" is a NAMING AID derived from the GS1
  // company prefix, never an identity claim - it names no product at all. Widening the inline suggestion
  // to weak "needs_review" decodes must never put a one-tap Approve on one, because approving it would
  // teach an approved alias for a product nobody ever identified.
  it("a floor-only name ('<Brand> / product unconfirmed') never becomes a pending inline suggestion, and the scan still counts", async () => {
    const store = aggressiveStore();
    const floorOnly = {
      ...WEAK_NEEDS_REVIEW,
      results: [{ ...WEAK_NEEDS_REVIEW.results[0], productName: "Acme / product unconfirmed", brand: "Acme" }],
    };
    const { restore } = stub(floorOnly);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.some((r) => r.cleanCode === CODE)).toBe(true));
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE)?.hasSuggestion).toBe(true),
      );

      expect(store.getState().scanFeed.some((e) => e.suggestion?.status === "pending"), "no Approve on a floor guess").toBe(false);
      // TOP-LEVEL LAW: the scan appears and counts regardless.
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
      // The floor text itself is still available to the row (it is honest, just not approvable).
      expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE)?.suggestedProductName)
        .toBe("Acme / product unconfirmed");
    } finally {
      restore();
    }
  });

  // F6: a counted row whose review record is gone (already settled, or stripped by a persist) must still
  // confirm through the approve-the-provisional path. Without the row's own provisionalProductId on the
  // reopened review, resolveUnknown cannot find the provisional it already counted and re-counts the scan.
  it("confirmRowIdentity on a counted row with NO review record never counts the physical scan twice", async () => {
    const store = aggressiveStore();
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan(CODE);
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
    // Drop the review entirely, and shape the counted provisional the way a CUSTOMER PERSIST rehydrates
    // it: the customer-safe persist strips a product's `provisional` flag and its identifier fields, and
    // the prefix-floor naming aid replaces the code-specific placeholder name. That defeats every legacy
    // fallback resolveUnknown has for finding the row's own provisional - only the row's
    // provisionalProductId can, and reopenNeedsReview mints a review without one.
    store.setState({
      needsReviewQueue: [],
      products: store.getState().products.map((p) =>
        p.id === row.matchedProductId
          ? { ...p, name: "Acme / product unconfirmed", provisional: undefined, primaryBarcode: "", gtin: "", upc: "", ean: "", primarySku: "" }
          : p,
      ),
    });
    const feedLength = store.getState().scanFeed.length;

    store.getState().confirmRowIdentity(row.id, { name: "Buffalo Wing Sauce 12oz", brand: "Anchor Bar" });

    const st = store.getState();
    expect(st.finalCounts.reduce((n, c) => n + c.quantity, 0), "one physical scan, one unit").toBe(1);
    expect(st.aliases.find((a) => a.cleanCode === CODE)?.approved).toBe(true);
    expect(st.scanFeed.length, "confirming never replays the scan").toBe(feedLength);
  });

  // F9: the repeat-scan attach puts the SAME pending suggestion on every row of that code, so declining
  // one identity must settle them all - otherwise live Approve controls stay on an identity the operator
  // just rejected.
  it("declining one row settles the pending suggestion on every row of that code", async () => {
    const store = aggressiveStore();
    const { restore } = stub(WEAK_NEEDS_REVIEW);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(pendingRow(store)).toBeTruthy());
      store.getState().processScan(CODE);
      await vi.waitFor(() =>
        expect(store.getState().scanFeed.filter((e) => e.suggestion?.status === "pending")).toHaveLength(2),
      );

      store.getState().declineSuggestion(store.getState().scanFeed[0].id);

      expect(store.getState().scanFeed.filter((e) => e.suggestion?.status === "pending")).toHaveLength(0);
      // Both physical scans still count (TOP-LEVEL LAW).
      expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);
    } finally {
      restore();
    }
  });
});
