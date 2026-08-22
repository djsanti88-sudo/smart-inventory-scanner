import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";

// D3: all three orphan-transfer sites (resolveUnknown merge, runLiveDecodeOnce fast-decode auto-link,
// backgroundVerifyDeep deep-verify merge) must UNION the surviving count's scanEventIds / aliasesSeen /
// appliedIdempotencyKeys so orphan history survives the merge and a replayed event id stays a no-op.

type Store = ReturnType<typeof createTestScanStore>;

function assertMergedLedger(store: Store, targetProductId: string) {
  const merged = store.getState().finalCounts.find((c) => c.productId === targetProductId)!;
  expect(merged, "the merge target still has a count row").toBeDefined();
  const feedIds = store.getState().scanFeed.filter((e) => e.matchedProductId === targetProductId).map((e) => e.id);
  for (const id of feedIds) {
    expect(merged.scanEventIds, `feed event ${id} recorded on the surviving count (union, not overwrite)`).toContain(id);
  }
  const replay = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId)
    .find((c) => c.productId === targetProductId)!;
  expect(replay.quantity, "replay reproduces the merged quantity").toBe(merged.quantity);
  expect(new Set(merged.scanEventIds), "replay reproduces the exact scanEventIds set").toEqual(new Set(replay.scanEventIds));
}

describe("D3 site 3: resolveUnknown merge unions the anti-double-count ledger fields", () => {
  it("merging an orphan into a target unions scanEventIds and preserves total quantity", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });

    // Count two distinct provisional identities (one scan each).
    store.getState().processScan("111111111116");
    store.getState().processScan("222222222229");
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);

    // Resolve the SECOND code by linking it to the FIRST code's provisional product (a merge).
    const target = store.getState().products.find((p) => p.primaryBarcode === "111111111116")!;
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "222222222229" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "link_existing", {
      applyToCount: true, origin: "human", productId: target.id,
    });

    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0), "quantity conserved across the merge").toBe(2);
    expect(store.getState().finalCounts.find((c) => c.productId === target.id)!.quantity).toBe(2);
    assertMergedLedger(store, target.id);
  });
});

describe("D3 site 1: runLiveDecodeOnce fast-decode auto-link merge unions the placeholder's history", () => {
  it("a live VERIFIED decode carrying the same GTIN merges the scan's placeholder into the existing product with the union", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Seed an existing counted product with a GTIN via the human-resolution path (AI off).
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("036000291452");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291452" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Duracell AA 4pk", brand: "Duracell", category: "Battery", primaryBarcode: "036000291452", gtin: "036000291452" },
    });
    const p1 = store.getState().products.find((p) => p.primaryBarcode === "036000291452")!;
    expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(1);

    // Now scan a DIFFERENT code whose LIVE decode returns a VERIFIED identity with the SAME canonical
    // GTIN -> identity-merge auto_link -> the scan's own placeholder (mergeOrphanId) transfers into p1.
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providerNames: ["gpt-5.4-mini"],
        results: [{
          productName: "Duracell AA 4pk", brand: "Duracell", category: "Battery", specsShort: "", specsFull: "",
          primarySku: "", primaryBarcode: "036000291452", gtin: "0036000291452", upc: "", ean: "", aliases: [],
          imageUrl: "", productUrl: "", sourceUrls: ["https://duracell.com/aa"], confidence: 0.92, verifiedFacts: [], guesses: [],
        }],
        decision: { status: "verified", confidence: 0.92, reason: "Verified.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
      }),
    })) as unknown as typeof fetch;
    try {
      store.getState().processScan("VENDOR-SKU-88");
      await vi.waitFor(() => {
        expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(2);
      });
    } finally {
      globalThis.fetch = original;
    }
    assertMergedLedger(store, p1.id);
  });
});

describe("D3 site 2: backgroundVerifyDeep merge unions the placeholder's history", () => {
  it("a deep-verified tire decode carrying the same GTIN merges the scan's own placeholder (ownProvId) with the union", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Seed the existing counted tire (same canonical GTIN the deep decode will report), AI off.
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("715459332915");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "715459332915" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Hankook Dynapro AT2 LT265/70R17 121S", brand: "Hankook", category: "Tire", specsShort: "LT265/70R17 121S", primaryBarcode: "715459332915", gtin: "715459332915" },
    });
    const p1 = store.getState().products.find((p) => p.primaryBarcode === "715459332915")!;

    // Tire context + AI on: scan a DIFFERENT code; the fast decode answers "suggested" (which auto-fires
    // the decode-deep background verify, see backgroundVerifyDeep.store.test.ts's proven modeStub idiom);
    // the deep response is VERIFIED with the SAME GTIN -> backgroundVerifyDeep merges ownProvId into p1.
    // NO SIZE on the deep identity (productName carries no size token, specsShort/specsFull empty): this
    // fails hasCountableTireIdentity (tireOk), so the full auto-count gate (canAutoCount, which routes
    // through resolveUnknown / site 3) does NOT clear, and the decode instead takes the narrower
    // AUTO-SUGGEST-APPLY branch (shouldAutoApplySuggestion: verified + exactCodeEvidenceVerifiedByApp,
    // no tireOk requirement) - the branch that actually contains site 2's ownProvId/mergeTargetId merge.
    // The identity-merge TIRE rule only requires size AGREEMENT when BOTH sides carry a parseable size
    // (identityMerge.ts bothHaveTireSize), so an empty decoded size still auto_links on the matching GTIN.
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
    const identity = {
      productName: "Hankook Dynapro AT2", brand: "Hankook", category: "Tire",
      specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "715459332915",
      gtin: "715459332915", upc: "", ean: "", aliases: [], imageUrl: "",
      productUrl: "https://hankooktire.com/dynapro-at2", sourceUrls: ["https://hankooktire.com/dynapro-at2"],
      confidence: 0.92, verifiedFacts: [], guesses: [],
    };
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.mode === "decode-deep") {
        return { ok: true, json: async () => ({ providerNames: ["gpt-5.4-mini"], results: [identity], decision: { status: "verified", confidence: 0.92, reason: "Verified: exact code on page.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } } }) };
      }
      return { ok: true, json: async () => ({ providerNames: ["gpt-5.4-mini"], results: [{ ...identity, confidence: 0.6, sourceUrls: ["https://www.upcitemdb.com/upc/715459332915"] }], decision: { status: "suggested", confidence: 0.6, reason: "Grounded, not app-verified.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } } }) };
    }) as unknown as typeof fetch;
    try {
      store.getState().processScan("HANKOOK-PN-77");
      await vi.waitFor(() => {
        expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(2);
      });
    } finally {
      globalThis.fetch = original;
    }
    assertMergedLedger(store, p1.id);
  });
});
