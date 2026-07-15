import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Task 9b (owner-ratified 2026-07-14): a decode that yields a SUGGESTION (any confidence) no longer
// creates/keeps an OPEN Needs Review item. The scan still counts immediately (count-decouple,
// unchanged); the suggestion moves to the feed row as a PENDING inline suggestion with approve/
// decline controls. Approve routes through the EXISTING human-approval core (resolveUnknown
// "create_new" via batchApprove - idempotency keys, poison guard, dedup all inherited). Decline
// renames the row to the prefix floor / "Unidentified item" and ONLY THEN creates the open review
// (decline is the only suggestion path that creates one). Conflicts and genuinely-empty decodes
// still create reviews (unchanged).
//
// Scaffolding mirrors scanStore.decodeCap.test.ts (mocked fetch, no live providers ever).

const CODE = "0792080004312"; // non-tire EAN-13 (the hot-sauce class); no tire escalation fires

function suggestedDecode(overrides: { confidence?: number; productName?: string; brand?: string; sourceUrls?: string[] } = {}) {
  const confidence = overrides.confidence ?? 0.3;
  const productName = overrides.productName ?? "Original Anchor Bar Hot Sauce";
  const brand = overrides.brand ?? "Anchor Bar";
  const sourceUrls = overrides.sourceUrls ?? ["https://go-upc.com/search?q=" + CODE];
  return {
    providerNames: ["gpt-5.5-ladder"],
    results: [
      {
        productName, brand, category: "food", specsShort: "", specsFull: "", primarySku: "",
        primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [] as string[], imageUrl: "",
        productUrl: "", sourceUrls, confidence, verifiedFacts: [] as string[], guesses: ["g"],
        needsHumanReview: true,
      },
    ],
    decision: {
      status: "suggested", confidence, reason: "Suggested", evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  };
}

function newStore() {
  return createTestScanStore({ db: new MockDb() });
}
type Store = ReturnType<typeof newStore>;

/** Scan CODE (AI off -> passive review), then drive liveDecode against a mocked fetch response. */
async function scanWithMockedDecode(store: Store, resp: object, code = CODE) {
  store.getState().processScan(code); // AI off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true });
  const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp }));
  globalThis.fetch = spy as unknown as typeof fetch;
  try {
    await store.getState().liveDecode(review.id);
  } finally {
    globalThis.fetch = original;
  }
  return { reviewId: review.id, spy };
}

function openReviews(store: Store) {
  return store.getState().needsReviewQueue.filter((r) => r.status === "open");
}

describe("Task 9b: inline suggestion approve/decline (suggestions bypass Needs Review)", () => {
  it("a low-confidence suggestion counts, tags the row, and does NOT create a review", async () => {
    const store = newStore();
    await scanWithMockedDecode(store, suggestedDecode({ confidence: 0.3, productName: "Anchor Bar Hot Sauce" }));
    const st = store.getState();
    expect(st.finalCounts.length).toBe(1); // counted (count-decouple unchanged)
    const row = st.scanFeed.find((e) => e.cleanCode === CODE)!;
    expect(row.suggestion?.status).toBe("pending");
    expect(row.suggestion?.confidence).toBe(0.3);
    expect(openReviews(store)).toHaveLength(0); // THE change: no open Needs Review item
    // Audit trail: the review record is PARKED at status "suggested", never deleted.
    const parked = st.needsReviewQueue.find((r) => r.cleanCode === CODE);
    expect(parked?.status).toBe("suggested");
    expect(parked?.suggestedProductName).toBe("Anchor Bar Hot Sauce");
  });

  it("approve saves a permanent alias and next scan of the code is deterministic-known", async () => {
    const store = newStore();
    await scanWithMockedDecode(store, suggestedDecode({ confidence: 0.3 }));
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    store.getState().approveSuggestion(row.id);

    // The alias went through the existing human-approval core: approved + idempotency-keyed.
    const alias = store.getState().aliases.find((a) => a.cleanCode === CODE);
    expect(alias).toBeDefined();
    expect(alias!.approved).toBe(true);
    expect(alias!.idempotencyKey).toBeTruthy();
    expect(store.getState().scanFeed.find((e) => e.id === row.id)?.suggestion?.status).toBe("approved");

    // Next scan: deterministic-known via the approved alias - NO decode call.
    const original = globalThis.fetch;
    const spy2 = vi.fn(async () => ({ ok: true, json: async () => suggestedDecode() }));
    globalThis.fetch = spy2 as unknown as typeof fetch;
    try {
      store.getState().processScan(CODE);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy2).not.toHaveBeenCalled();
    expect(store.getState().scanFeed[0].matchType).not.toBe("unknown"); // alias hit
    const prodId = store.getState().scanFeed[0].matchedProductId!;
    expect(store.getState().finalCounts.find((c) => c.productId === prodId)?.quantity).toBe(2); // no double-count on approve, +1 on rescan
  });

  it("decline renames to the prefix floor / Unidentified and creates the review", async () => {
    const store = newStore();
    await scanWithMockedDecode(store, suggestedDecode({ confidence: 0.3 }));
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    store.getState().declineSuggestion(row.id);

    const st = store.getState();
    expect(st.needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(1); // decline is the ONLY suggestion path that creates one
    expect(st.needsReviewQueue.find((r) => r.status === "open")?.reason).toContain("Suggestion declined");
    expect(st.scanFeed.find((e) => e.id === row.id)?.suggestion?.status).toBe("declined");
    // The counted row keeps counting but never keeps the declined identity - floor / placeholder name.
    const prod = st.products.find((p) => p.id === row.matchedProductId)!;
    expect(prod.name).not.toContain("Anchor Bar");
    expect(prod.verified).toBe(false); // a floor name is a naming aid, NEVER a verified identity
    expect(st.finalCounts.length).toBe(1); // the count survives the decline
    // No alias was ever learned from the declined suggestion.
    expect(st.aliases.find((a) => a.cleanCode === CODE)).toBeUndefined();
  });

  it("approve/decline are idempotent (double-tap safe)", async () => {
    // Double-tap APPROVE: one alias, one count.
    const store = newStore();
    await scanWithMockedDecode(store, suggestedDecode({ confidence: 0.3 }));
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    store.getState().approveSuggestion(row.id);
    store.getState().approveSuggestion(row.id); // double-tap
    expect(store.getState().aliases.filter((a) => a.cleanCode === CODE)).toHaveLength(1);
    const prodId = store.getState().scanFeed.find((e) => e.id === row.id)!.matchedProductId!;
    expect(store.getState().finalCounts.find((c) => c.productId === prodId)?.quantity).toBe(1);
    // Decline AFTER approve is a no-op (the suggestion is no longer pending).
    store.getState().declineSuggestion(row.id);
    expect(store.getState().scanFeed.find((e) => e.id === row.id)?.suggestion?.status).toBe("approved");
    expect(openReviews(store)).toHaveLength(0);

    // Double-tap DECLINE: exactly one open review; approve after decline is a no-op.
    const store2 = newStore();
    await scanWithMockedDecode(store2, suggestedDecode({ confidence: 0.3 }));
    const row2 = store2.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    store2.getState().declineSuggestion(row2.id);
    store2.getState().declineSuggestion(row2.id); // double-tap
    expect(store2.getState().needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(1);
    store2.getState().approveSuggestion(row2.id); // approve after decline: no-op
    expect(store2.getState().aliases.find((a) => a.cleanCode === CODE)).toBeUndefined();
  });

  it("approve of an EVIDENCE-LESS suggestion inherits the Phase-2 poison guard (no approved alias, product unverified)", async () => {
    const store = newStore();
    // No brand, no identifiers, no sources -> isWeakGuess. Approve must NOT mint trust.
    await scanWithMockedDecode(store, suggestedDecode({ confidence: 0.5, productName: "Velvet Torch Dress", brand: "", sourceUrls: [] }));
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE)!;
    expect(row.suggestion?.status).toBe("pending");
    store.getState().approveSuggestion(row.id);
    const alias = store.getState().aliases.find((a) => a.cleanCode === CODE);
    if (alias) expect(alias.approved).toBe(false); // poison guard: never an approved alias from an evidence-less guess
    const prod = store.getState().products.find((p) => p.primaryBarcode === CODE);
    if (prod) expect(prod.verified).toBe(false);
  });

  it("a CONFLICT decode still creates/keeps the open review (unchanged)", async () => {
    const store = newStore();
    const conflictResp = {
      providerNames: ["gemini", "openai"],
      results: [
        { productName: "Product A", brand: "A", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.5, verifiedFacts: [], guesses: [], needsHumanReview: true },
      ],
      decision: {
        status: "conflict", confidence: 0.2, reason: "Providers disagree.", evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "conflict", confidence: 0.2, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: ["brand"] },
      },
    };
    await scanWithMockedDecode(store, conflictResp, "0792080004329");
    expect(store.getState().needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(1);
    expect(store.getState().scanFeed.find((e) => e.cleanCode === "0792080004329")?.suggestion).toBeUndefined();
  });

  it("a genuinely EMPTY decode still creates/keeps the open review (unchanged)", async () => {
    const store = newStore();
    const emptyResp = {
      providerNames: ["mock"],
      results: [],
      decision: {
        status: "needs_review", confidence: 0, reason: "", evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "single_provider", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
      },
    };
    await scanWithMockedDecode(store, emptyResp, "0792080004336");
    expect(store.getState().needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(1);
    expect(store.getState().scanFeed.find((e) => e.cleanCode === "0792080004336")?.suggestion).toBeUndefined();
  });
});
