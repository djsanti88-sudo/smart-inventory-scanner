import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Owner rule ("if it is resolved, it does not go to review"): a review whose identity is actually
// settled must never be left status "open"/"suggested" in the Needs Review queue. Both auto-count
// branches (the liveDecode fast path ~scanStore.ts:3042-3090 and the mirrored backgroundVerifyDeep
// path ~scanStore.ts:4015-4076) call resolveUnknown(reviewId, "create_new", ...) to close the review.
// resolveUnknown ALREADY stamps "resolved" on every genuine resolution - the only ways a review is
// still open/suggested afterward are the two DELIBERATE human-required early-returns: the fuzzy
// identity-merge suggest_link path (services/catalog/identityMerge.ts: same brand + name Jaccard >=
// 0.75 routes to a human "link to existing product?" suggestion) and the multi-match dedup-conflict
// path (matchedIds.size > 1). FIX (rung self-poisoning audit, owner-approved 2026-07-22): a still-open
// review after those two auto-count branches must NEVER be force-stamped "resolved" - both deliberate
// holds must stay visible with no fabricated "auto create_new" audit trail.

const CODE_1 = "111222333446";
const CODE_2 = "222333444553";
const CODE_3 = "333444555660";

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

// Every decode reports the identical GTIN "00099988877701" via its own scanned code as `upc` AND the
// SAME shared `gtin`, but with a DIFFERENT product name each time (so identityMerge's fuzzy suggest_link
// name-similarity path never fires - only the deterministic GTIN-identifier dedup can match). Two
// already-counted products both carrying that shared GTIN as their own `gtin` field is engineered below
// by resolving CODE_1/CODE_2 as distinct human "create_new" products that both set gtin to SHARED_GTIN;
// the THIRD AI-verified decode (CODE_3) then hits the deterministic matchedIds.size > 1 conflict guard.
const SHARED_GTIN = "00099988877704"; // valid GS1 check digit (GTIN-14)
function conflictResponseFor(code: string, name: string) {
  return {
    providerNames: ["gemini"],
    results: [
      {
        productName: name,
        brand: "Zenith",
        category: "Electronics",
        specsShort: "",
        specsFull: "",
        primarySku: "",
        primaryBarcode: code,
        gtin: SHARED_GTIN,
        upc: "",
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

// Same shape as stubPerCode but returns the shared-GTIN conflictResponseFor payload, keyed by a
// caller-supplied code -> distinct-name map so each scan can decode to a DIFFERENT product name while
// all sharing the identical GTIN identifier (the dedup guard matches on identifier equality, not name).
function stubConflictPerCode(namesByCode: Record<string, string>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const code: string = body.cleanCode ?? body.rawCode ?? "";
    return { ok: true, json: async () => conflictResponseFor(code, namesByCode[code] ?? "Zenith Widget") };
  }) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("resolved reviews never linger in Needs Review, even when resolveUnknown silently no-ops", () => {
  // FIX (rung self-poisoning audit, owner-approved): the ORIGINAL 092600e stamp force-marked ANY
  // still-open review "resolved" after an evidence-gate pass, INCLUDING the two cases where
  // resolveUnknown deliberately left it open for a human decision (suggest_link fuzzy match, dedup
  // conflict). That produced a fabricated audit trail ("resolvedBy: auto, resolutionAction:
  // create_new") on a row where nothing was actually created, and hid a row that must stay visible.
  // The suggest_link case below now asserts the CORRECTED behavior: the review stays open/visible with
  // NO auto-resolved stamp, and its suggestedLinkProductId is preserved for the human "link?" prompt.
  it("liveDecode: a verified decode that hits the fuzzy suggest_link no-op stays OPEN/visible with NO fabricated auto-resolved stamp", async () => {
    const store = aiOnStore();
    const { restore } = stubPerCode();
    try {
      // First scan mints + auto-counts the "real" product (fast path, evidence gate passes cleanly).
      store.getState().processScan(CODE_1);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_1)!.status).toBe("resolved"));

      // Second scan: a DIFFERENT code decodes to the SAME brand+name (no shared GTIN) -> the evidence
      // gate passes again (independently verified), but resolveUnknown's identity-merge step finds the
      // fuzzy match and takes the suggest_link branch, which returns WITHOUT resolving the review -
      // deliberately, so a human can confirm the link. This must remain visible, not force-stamped.
      store.getState().processScan(CODE_2);
      await vi.waitFor(() => {
        const decoding = store.getState().needsReviewQueue.some((r) => r.status === "open" && r.decodeStatus === "decoding");
        expect(decoding).toBe(false);
      });
    } finally {
      restore();
    }

    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_2)!;
    // THE FIX: a deliberate suggest_link hold must stay visible (open/suggested) and must NEVER be
    // fabricated as an "auto create_new" resolution - nothing was actually created for this review.
    expect(review2.status, "a deliberate suggest_link hold must remain visible, not silently resolved").not.toBe("resolved");
    expect(review2.suggestedLinkProductId, "the fuzzy-match candidate must still be attached for the human link prompt").toBeTruthy();
    expect(review2.resolvedBy, "must never carry a fabricated auto-resolution stamp").not.toBe("auto");
  });

  it("a multi-match dedup conflict (two existing counted products both own the decoded GTIN) stays OPEN with NO fabricated auto-resolved stamp", async () => {
    const store = aiOnStore();
    const { restore } = stubConflictPerCode({ [CODE_3]: "Zenith Gamma Speaker" });
    try {
      // Seed TWO existing, already-counted products that both independently carry the identical GTIN
      // identifier. The normal auto-count flow's own dedup guard prevents this from arising naturally
      // (a second scan of the same identifier merges into the first product rather than creating a
      // second) - this simulates data that pre-existed (e.g. imported before the dedup guard existed),
      // which is exactly the scenario the deterministic multi-match conflict guard exists to catch.
      store.setState((s) => ({
        products: [
          ...s.products,
          { id: "seed-a", businessId: s.businessId, name: "Seed Speaker A", brand: "Zenith", category: "Electronics", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: SHARED_GTIN, upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], verified: true, provisional: false, status: "active", createdAt: "2026-06-12T10:00:00.000Z", updatedAt: "2026-06-12T10:00:00.000Z", source: "human", syncStatus: "synced", idempotencyKey: "seed-a-key" } as never,
          { id: "seed-b", businessId: s.businessId, name: "Seed Speaker B", brand: "Zenith", category: "Electronics", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: SHARED_GTIN, upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], verified: true, provisional: false, status: "active", createdAt: "2026-06-12T10:00:00.000Z", updatedAt: "2026-06-12T10:00:00.000Z", source: "human", syncStatus: "synced", idempotencyKey: "seed-b-key" } as never,
        ],
        finalCounts: [
          ...s.finalCounts,
          { productId: "seed-a", quantity: 1, lastCountedAt: "2026-06-12T10:00:00.000Z", scanEventIds: ["seed-a-evt"] } as never,
          { productId: "seed-b", quantity: 1, lastCountedAt: "2026-06-12T10:00:00.000Z", scanEventIds: ["seed-b-evt"] } as never,
        ],
      }));

      // AI-verified decode of a FRESH code whose decoded identity carries the SAME shared GTIN.
      // Deterministic dedup finds TWO existing counted products owning that identifier
      // (matchedIds.size > 1) -> the conflict guard deliberately keeps this review open for a human to
      // pick the right product via link_existing.
      store.getState().processScan(CODE_3);
      await vi.waitFor(() => {
        const decoding = store.getState().needsReviewQueue.some((r) => r.status === "open" && r.decodeStatus === "decoding");
        expect(decoding).toBe(false);
      });
    } finally {
      restore();
    }

    const review3 = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_3)!;
    expect(review3.status, "a deliberate dedup conflict must remain visible, not silently resolved").not.toBe("resolved");
    expect(review3.resolvedBy, "must never carry a fabricated auto-resolution stamp").not.toBe("auto");
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
