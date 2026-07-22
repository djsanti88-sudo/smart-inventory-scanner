import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Owner rule ("if it is resolved, it does not go to review"): a review whose identity is actually
// settled must never be left status "open"/"suggested" in the Needs Review queue. Both auto-count
// branches (the liveDecode fast path ~scanStore.ts:3042-3090 and the mirrored backgroundVerifyDeep
// path ~scanStore.ts:4015-4076) call resolveUnknown(reviewId, "create_new", ...) to close the review,
// but resolveUnknown can silently no-op - most commonly the fuzzy identity-merge suggest_link path
// (services/catalog/identityMerge.ts: same brand + name Jaccard >= 0.75 routes to a human "link to
// existing product?" suggestion and returns WITHOUT resolving). When that happens the evidence gate
// already passed (this decode WAS independently app-verified), so the row must still be stamped
// resolved even though resolveUnknown itself left it open.

const CODE_1 = "111222333446";
const CODE_2 = "222333444553";

// Same brand + EXACT same product name (no GTIN overlap) => identityMerge.findIdentityMerge returns
// suggest_link on the SECOND decode, which is exactly the no-op condition under test.
function verifiedResponseFor(code: string) {
  return {
    providerNames: ["gemini"],
    results: [
      {
        productName: "Aurora Max Wireless Earbuds",
        brand: "Aurora",
        category: "Electronics",
        specsShort: "",
        specsFull: "",
        primarySku: "",
        primaryBarcode: code,
        gtin: "",
        upc: code,
        ean: "",
        aliases: [],
        imageUrl: "",
        productUrl: "",
        sourceUrls: ["https://www.example.com/product/" + code],
        confidence: 0.95,
        verifiedFacts: [],
        guesses: [],
      },
    ],
    decision: {
      status: "verified",
      confidence: 0.95,
      reason: "Verified: exact code confirmed in strong evidence.",
      evidenceStrength: "fetched_source",
      exactCodeEvidenceVerifiedByApp: true,
      crossCheck: { decision: "single_provider" },
    },
  };
}

function stubPerCode() {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const code: string = body.cleanCode ?? body.rawCode ?? "";
    return { ok: true, json: async () => verifiedResponseFor(code) };
  }) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("resolved reviews never linger in Needs Review, even when resolveUnknown silently no-ops", () => {
  it("liveDecode: a verified decode that hits the fuzzy suggest_link no-op still ends the review status 'resolved'", async () => {
    const store = aiOnStore();
    const { restore } = stubPerCode();
    try {
      // First scan mints + auto-counts the "real" product (fast path, evidence gate passes cleanly).
      store.getState().processScan(CODE_1);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_1)!.status).toBe("resolved"));

      // Second scan: a DIFFERENT code decodes to the SAME brand+name (no shared GTIN) -> the evidence
      // gate passes again (independently verified), but resolveUnknown's identity-merge step finds the
      // fuzzy match and takes the suggest_link branch, which returns WITHOUT resolving the review. Before
      // the fix this left review 2 stuck open forever despite the decode being genuinely settled.
      store.getState().processScan(CODE_2);
      await vi.waitFor(() => {
        const decoding = store.getState().needsReviewQueue.some((r) => r.status === "open" && r.decodeStatus === "decoding");
        expect(decoding).toBe(false);
      });
    } finally {
      restore();
    }

    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_2)!;
    // THE FIX: even though resolveUnknown no-opped internally (suggest_link), the settled identity must
    // still be reflected: the review must not be left "open" (or "suggested") in the queue.
    expect(review2.status, "resolved settled identity must not linger as open/suggested").toBe("resolved");
    expect(review2.resolvedBy).toBe("auto");
    expect(review2.resolutionAction).toBe("create_new");
  });

  it("guard: the feed row for the no-op'd code still exists and the count is unchanged by the resolution stamping (scan N = count N)", async () => {
    const store = aiOnStore();
    const { restore } = stubPerCode();
    try {
      store.getState().processScan(CODE_1);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_1)!.status).toBe("resolved"));

      store.getState().processScan(CODE_2);
      await vi.waitFor(() => {
        const decoding = store.getState().needsReviewQueue.some((r) => r.status === "open" && r.decodeStatus === "decoding");
        expect(decoding).toBe(false);
      });
    } finally {
      restore();
    }

    // Feed row for CODE_2 must still exist (stamping review status must never touch scanFeed).
    const feedRows = store.getState().scanFeed.filter((e) => e.cleanCode === CODE_2);
    expect(feedRows.length, "the scanned code's feed row survives").toBeGreaterThanOrEqual(1);

    // finalCounts total across both scans must equal 2 (scan 2 codes = count 2), unaffected by whether
    // resolveUnknown internally merged/no-opped - the review-status stamp must never add/remove a count.
    const totalQty = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalQty, "scan N = count N, unchanged by the review-status stamping fix").toBe(2);
  });

  it("human path (resolveUnknown directly): create_new on an open review resolves it normally (baseline, should already pass)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("333444555669");
    const review = store.getState().needsReviewQueue.at(-1)!;
    expect(review.status).toBe("open");

    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Human Resolved Widget", brand: "Acme", primaryBarcode: "333444555669" },
    });

    const after = store.getState().needsReviewQueue.find((r) => r.id === review.id)!;
    expect(after.status).toBe("resolved");
  });
});
