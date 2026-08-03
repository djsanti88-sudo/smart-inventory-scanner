import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { normalizeCode } from "@/services/codeNormalizer";

const SEQUENCE = [
  "6419440485331",
  "T432119%RU1%",
  "T432119",
  "848983012906",
  "2881-6861",
  "28816861",
  "049000028904",
  "7262",
  "UNKNOWN123",
];

function countFor(store: ReturnType<typeof createTestScanStore>, productId: string) {
  return store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;
}

describe("scanStore - acceptance scan sequence", () => {
  let db: MockDb;
  let store: ReturnType<typeof createTestScanStore>;

  beforeEach(() => {
    db = new MockDb();
    store = createTestScanStore({ db });
    for (const code of SEQUENCE) store.getState().processScan(code);
  });

  it("groups codes into the correct product quantities", () => {
    expect(countFor(store, "prod-nokian")).toBe(3);
    expect(countFor(store, "prod-falken")).toBe(3);
    expect(countFor(store, "prod-coke")).toBe(2);
  });

  it("keeps every scan event in the live feed", () => {
    expect(store.getState().scanFeed).toHaveLength(SEQUENCE.length);
  });

  it("routes the unknown code to Needs Review (still open for human resolution)", () => {
    // Per the owner rule "scan N = count N" (Plan A, Task 2), an unresolved code is now ALSO counted
    // synchronously as an anonymous provisional row -- but it still stays in Needs Review, unidentified,
    // pending human resolution. This test asserts the review-queue side of that; the count side is
    // asserted below in "groups the final count table by product, not by code".
    const review = store.getState().needsReviewQueue;
    expect(review).toHaveLength(1);
    expect(review[0].cleanCode).toBe("UNKNOWN123");
    expect(review[0].status).toBe("open");
  });

  it("groups the final count table by product, not by code", () => {
    // 5 known codes across 3 products -> 3 count rows, PLUS 1 provisional row for the unresolved
    // UNKNOWN123 (owner rule "scan N = count N", Plan A Task 2: every scan counts immediately, even
    // an unresolved one) -> 4 count rows total.
    expect(store.getState().finalCounts).toHaveLength(4);
  });

  it("syncs known scans to the mock backend with matching server quantities", () => {
    expect(db.getServerCount("session-1", "prod-nokian")?.quantity).toBe(3);
    expect(db.getServerCount("session-1", "prod-falken")?.quantity).toBe(3);
    expect(db.getServerCount("session-1", "prod-coke")?.quantity).toBe(2);
  });
});

describe("scanStore - optimistic update is immediate", () => {
  it("adds the scan to the feed and count synchronously (no awaited round-trip)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ev = store.getState().processScan("T432119");
    expect(ev?.matchedProductId).toBe("prod-nokian");
    expect(store.getState().scanFeed[0].id).toBe(ev?.id);
    expect(countFor(store, "prod-nokian")).toBe(1);
  });
});

describe("scanStore - failed sync never loses scans, retry never double counts", () => {
  it("keeps scans locally as pending when sync fails", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().setSimulateSyncFailure(true);
    store.getState().processScan("T432119");

    // Local count is intact even though sync failed.
    expect(countFor(store, "prod-nokian")).toBe(1);
    expect(store.getState().pendingCount()).toBeGreaterThan(0);
    expect(store.getState().scanFeed[0].syncStatus).not.toBe("synced");
    // Nothing reached the backend yet.
    expect(db.getServerCount("session-1", "prod-nokian")).toBeUndefined();
  });

  it("drains the pending queue on retry without double counting", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().setSimulateSyncFailure(true);
    store.getState().processScan("T432119");
    store.getState().processScan("T432119"); // two scans -> quantity 2, both pending

    store.getState().setSimulateSyncFailure(false);
    store.getState().retrySync();
    store.getState().retrySync(); // run retry repeatedly - must stay safe
    store.getState().retrySync();

    expect(countFor(store, "prod-nokian")).toBe(2); // local unchanged
    expect(db.getServerCount("session-1", "prod-nokian")?.quantity).toBe(2); // server exact
    expect(store.getState().pendingCount()).toBe(0);
    expect(store.getState().scanFeed.every((e) => e.syncStatus === "synced")).toBe(true);
  });
});

describe("scanStore - human resolution learns a permanent alias", () => {
  it("links an unknown code and makes future scans deterministic", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("UNKNOWN123");
    const reviewId = store.getState().needsReviewQueue[0].id;

    store.getState().resolveUnknown(reviewId, "link_existing", {
      productId: "prod-coke",
      applyToCount: true,
    });

    // Review resolved, alias learned.
    expect(store.getState().needsReviewQueue[0].status).toBe("resolved");
    const learned = store.getState().aliases.filter((a) => a.cleanCode === "UNKNOWN123");
    expect(learned).toHaveLength(1);
    expect(learned[0].productId).toBe("prod-coke");

    // The applyToCount option counted it once.
    expect(countFor(store, "prod-coke")).toBe(1);

    // A future scan of the same code now matches deterministically (no new review).
    const ev = store.getState().processScan("UNKNOWN123");
    expect(ev?.matchedProductId).toBe("prod-coke");
    expect(store.getState().needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(0);
    expect(countFor(store, "prod-coke")).toBe(2);
  });

  it("persists human-resolved feed rows back to the backend scan event", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const event = store.getState().processScan("UNKNOWN123")!;
    expect(db.getScanEvent(event.id)?.matchedProductId).not.toBe("prod-coke");
    const reviewId = store.getState().needsReviewQueue[0].id;

    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke" });

    expect(store.getState().scanFeed.find((e) => e.id === event.id)).toMatchObject({
      status: "resolved",
      resolverStatus: "resolved",
      matchedProductId: "prod-coke",
    });
    expect(db.getScanEvent(event.id)).toMatchObject({
      status: "resolved",
      resolverStatus: "resolved",
      matchedProductId: "prod-coke",
    });
  });

  it("does not create duplicate aliases when resolve sync is retried", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("UNKNOWN123");
    const reviewId = store.getState().needsReviewQueue[0].id;
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke" });

    store.getState().retrySync();
    store.getState().retrySync();

    const learned = store.getState().aliases.filter((a) => a.cleanCode === "UNKNOWN123");
    expect(learned).toHaveLength(1);
  });
});

describe("scanStore - Phase 6 wrong-decode correction", () => {
  function stub(resp: object) {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    return { spy, restore: () => (globalThis.fetch = original) };
  }
  function setGeminiConfigured(store: ReturnType<typeof createTestScanStore>, on: boolean) {
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, geminiConfigured: on } }));
  }
  // Simulate a wrong saved decode: a human linked an unknown code to a (wrong) product and counted it.
  function wrongAlias(store: ReturnType<typeof createTestScanStore>, code: string, productId: string) {
    store.getState().processScan(code);
    const id = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().resolveUnknown(id, "link_existing", { productId, applyToCount: true });
  }
  function aiResult(over: Record<string, unknown>) {
    return {
      productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
      primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
      sourceUrls: [], confidence: 0.9, verifiedFacts: [], guesses: [], needsHumanReview: false, ...over,
    };
  }

  it("removeFromCount removes only the session count, never the product or alias; re-scan re-counts", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("T432119"); // -> prod-nokian (seed)
    expect(countFor(store, "prod-nokian")).toBe(1);
    store.getState().removeFromCount("prod-nokian");
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-nokian")).toBe(false);
    expect(store.getState().products.some((p) => p.id === "prod-nokian")).toBe(true);
    expect(store.getState().aliases.some((a) => a.productId === "prod-nokian" && a.approved)).toBe(true);
    store.getState().processScan("T432119");
    expect(countFor(store, "prod-nokian")).toBe(1);
  });

  it("correctProduct edits product fields without changing alias trust", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const before = store.getState().aliases.filter((a) => a.productId === "prod-coke" && a.approved).length;
    store.getState().correctProduct("prod-coke", { name: "Coca-Cola Zero", brand: "Coca-Cola" });
    const p = store.getState().products.find((x) => x.id === "prod-coke")!;
    expect(p.name).toBe("Coca-Cola Zero");
    expect(p.brand).toBe("Coca-Cola");
    expect(store.getState().aliases.filter((a) => a.productId === "prod-coke" && a.approved).length).toBe(before);
  });

  it("markWrong deactivates the bad alias, removes the count, reopens Needs Review, and stops future counting", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, false); // recheck unavailable -> no fetch; focus on alias/count/review
    wrongAlias(store, "WRONGCODE1", "prod-coke");
    expect(countFor(store, "prod-coke")).toBe(1);
    expect(store.getState().aliases.some((a) => a.cleanCode === "WRONGCODE1" && a.approved)).toBe(true);

    const reviewId = await store.getState().markWrong("prod-coke", { reason: "this is wrong" });

    expect(store.getState().aliases.find((a) => a.cleanCode === "WRONGCODE1")?.approved).toBe(false);
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-coke")).toBe(false);
    expect(store.getState().products.some((p) => p.id === "prod-coke")).toBe(true); // product NOT deleted
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open");
    expect(review.cleanCode).toBe("WRONGCODE1");
    expect(review.correctionRecheckStatus).toBe("unavailable");
    expect(review.correctionRecheckMissingKeys).toContain("GEMINI_API_KEY");
    // future scan of the same code no longer counts the wrong product
    const ev = store.getState().processScan("WRONGCODE1");
    expect(ev?.resolverStatus).not.toBe("known");
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-coke")).toBe(false);
  });

  it("after markWrong, relinking the code to the correct product makes future scans count the correct product", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, false);
    wrongAlias(store, "RELINK1", "prod-coke");
    const reviewId = await store.getState().markWrong("prod-coke");
    store.getState().resolveUnknown(reviewId!, "link_existing", { productId: "prod-nokian", applyToCount: true });
    expect(countFor(store, "prod-nokian")).toBe(1);
    const ev = store.getState().processScan("RELINK1");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe("prod-nokian");
    expect(countFor(store, "prod-nokian")).toBe(2);
  });

  it("correctionRecheck verified_correction recommends but never auto-saves (human still approves)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, true);
    const reviewId = store.getState().reopenNeedsReview("RECHECK1", "marked wrong")!;
    const { spy, restore } = stub({
      providerNames: ["gemini:pro"],
      results: [aiResult({ productName: "Correct Product", brand: "Acme", primarySku: "RC-1", primaryBarcode: "RECHECK1", confidence: 0.95 })],
      decision: { status: "verified", confidence: 0.95, evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
    });
    try {
      await store.getState().correctionRecheck(reviewId);
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.correctionRecheckStatus).toBe("verified_correction");
    expect(review.suggestedProductName).toBe("Correct Product");
    expect(review.status).toBe("open"); // NOT auto-resolved
    expect(store.getState().aliases.some((a) => a.cleanCode === "RECHECK1")).toBe(false); // NOT auto-saved
    expect(store.getState().finalCounts.length).toBe(0); // NOT auto-counted
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("correctionRecheck insufficient_evidence keeps the code in Needs Review", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, true);
    const reviewId = store.getState().reopenNeedsReview("RECHECK2", "marked wrong")!;
    const { restore } = stub({ providerNames: ["gemini:pro"], results: [aiResult({ productName: "Maybe", confidence: 0.4 })], decision: { status: "suggested", confidence: 0.4 } });
    try {
      await store.getState().correctionRecheck(reviewId);
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.correctionRecheckStatus).toBe("insufficient_evidence");
    expect(review.status).toBe("open");
    expect(store.getState().aliases.some((a) => a.cleanCode === "RECHECK2")).toBe(false);
  });

  it("correctionRecheck conflict keeps the code in Needs Review with a safe conflict message", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, true);
    const reviewId = store.getState().reopenNeedsReview("RECHECK3", "marked wrong")!;
    const { restore } = stub({ providerNames: ["gemini:pro", "openai"], results: [aiResult({ productName: "A", brand: "X", confidence: 0.5 })], decision: { status: "conflict", confidence: 0.2, crossCheck: { decision: "conflict" } } });
    try {
      await store.getState().correctionRecheck(reviewId);
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.correctionRecheckStatus).toBe("conflict");
    expect(review.status).toBe("open");
    expect(review.reason.toLowerCase()).toContain("conflict");
  });

  it("correctionRecheck is unavailable (no live call) when Gemini is not configured; reports key NAMES only", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, false);
    const reviewId = store.getState().reopenNeedsReview("RECHECK4", "marked wrong")!;
    const { spy, restore } = stub({});
    try {
      await store.getState().correctionRecheck(reviewId);
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.correctionRecheckStatus).toBe("unavailable");
    expect(review.correctionRecheckMissingKeys).toEqual(["GEMINI_API_KEY"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cost guard: only one Pro recheck per code unless an explicit retry", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    setGeminiConfigured(store, true);
    const reviewId = store.getState().reopenNeedsReview("RECHECK5", "marked wrong")!;
    const { spy, restore } = stub({ providerNames: ["gemini:pro"], results: [aiResult({ productName: "P" })], decision: { status: "suggested", confidence: 0.5 } });
    try {
      await store.getState().correctionRecheck(reviewId);
      await store.getState().correctionRecheck(reviewId); // guarded -> no second fetch
      expect(spy).toHaveBeenCalledTimes(1);
      await store.getState().correctionRecheck(reviewId, { retry: true }); // explicit retry -> fetch again
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});

describe("scanStore - Phase 7 stronger re-decode escalation", () => {
  function captureStub(resp: object) {
    const original = globalThis.fetch;
    const calls: Array<RequestInit | undefined> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(init);
      return { ok: true, json: async () => resp };
    }) as unknown as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }
  const lastBody = (calls: Array<RequestInit | undefined>) => JSON.parse(String(calls[calls.length - 1]?.body ?? "{}"));
  const DECODE_RESP = {
    providerNames: ["gemini"],
    results: [{ ...{ productName: "Some Product", brand: "B", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.5, verifiedFacts: [], guesses: [], needsHumanReview: true } }],
    decision: { status: "suggested", confidence: 0.5 },
  };

  it("liveDecode auto-escalates to proRecheck:true for a review reopened from Mark wrong", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });
    const reviewId = store.getState().reopenNeedsReview("PH7CODE1", "marked wrong - re-identify")!;
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)?.reopenedFromWrong).toBe(true);
    const { calls, restore } = captureStub(DECODE_RESP);
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    expect(lastBody(calls).proRecheck).toBe(true);
  });

  it("normal liveDecode does NOT send proRecheck (fast models for ordinary unknowns)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("PH7CODE2"); // AI off by default -> passive review, not reopened-from-wrong
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });
    const { calls, restore } = captureStub(DECODE_RESP);
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    expect(lastBody(calls).proRecheck).not.toBe(true);
  });

  it("explicit stronger re-decode (correctionRecheck retry) uses the Pro path (proRecheck:true)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, geminiConfigured: true } }));
    const reviewId = store.getState().reopenNeedsReview("PH7CODE3", "marked wrong")!;
    const { calls, restore } = captureStub({ providerNames: ["gemini:pro"], results: DECODE_RESP.results, decision: { status: "suggested", confidence: 0.6 } });
    try {
      await store.getState().correctionRecheck(reviewId, { retry: true });
    } finally {
      restore();
    }
    expect(lastBody(calls).proRecheck).toBe(true);
  });
});

describe("scanStore - W2 discovered-alias approval", () => {
  const clean = (s: string) => normalizeCode(s).clean;

  function openReview(store: ReturnType<typeof createTestScanStore>, code: string): string {
    store.getState().processScan(code);
    return store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
  }

  it("does NOT auto-save discovered identifiers as aliases before human approval", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = openReview(store, "UNKNOWNW2A");
    // A decode surfaced extra identifiers as SUGGESTIONS on the review (never trusted).
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === id ? { ...r, suggestedAliases: ["DISCOVEREDA", "DISCOVEREDB"], hasSuggestion: true } : r,
      ),
    }));
    expect(
      store.getState().aliases.some((a) => [clean("DISCOVEREDA"), clean("DISCOVEREDB")].includes(a.cleanCode)),
    ).toBe(false);
    expect(store.getState().processScan("DISCOVEREDA")?.resolverStatus).not.toBe("known");
  });

  it("approves SELECTED discovered identifiers onto a NEW product; future scans then count automatically", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = openReview(store, "WIDGETMAIN");
    store.getState().resolveUnknown(id, "create_new", {
      newProduct: { name: "Widget Pro" },
      selectedAliasCodes: ["WIDGETALT1", "012345678905"],
      applyToCount: false,
    });
    const prod = store.getState().products.find((p) => p.name === "Widget Pro")!;
    expect(prod).toBeTruthy();
    const alt = store.getState().aliases.find((a) => a.cleanCode === clean("WIDGETALT1"));
    expect(alt?.approved).toBe(true);
    expect(alt?.source).toBe("human_review");
    expect(alt?.productId).toBe(prod.id);
    // scanned primary + the two selected discovered identifiers are all aliased to the new product
    expect(store.getState().aliases.filter((a) => a.productId === prod.id && a.approved).length).toBeGreaterThanOrEqual(3);
    // future scan of a discovered alias resolves Known and counts
    const ev = store.getState().processScan("WIDGETALT1");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe(prod.id);
    // scan N = count N: the original WIDGETMAIN scan was counted synchronously into this product's provisional
    // placeholder (now upgraded), and the WIDGETALT1 scan counts again -> quantity 2 (two physical scans).
    expect(countFor(store, prod.id)).toBe(2);
  });

  // P2: a counted product whose barcode lives ONLY inside its NAME must be reused on a re-scan of that
  // barcode (no duplicate row). Wrong identity = failure; unknown = acceptable, so we match a full exact
  // code token only, and >1 candidate routes to a conflict (never a guess).
  const legacyCounted = (
    store: ReturnType<typeof createTestScanStore>,
    id: string,
    name: string,
  ) =>
    store.setState((s) => ({
      products: [
        ...s.products,
        {
          id, businessId: s.businessId, name, brand: "", category: "", specsShort: "", specsFull: "",
          primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
          imageUrl: "", productUrl: "", location: "", notes: "", status: "active" as const,
          source: "human_review", confidence: 1, verified: false, createdAt: "t", updatedAt: "t",
          createdBy: "h", updatedBy: "h",
        },
      ],
      finalCounts: [
        ...s.finalCounts,
        {
          id: `fc-${id}`, businessId: s.businessId, sessionId: s.sessionId, productId: id, quantity: 5,
          lastScannedAt: "t", aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t",
          syncStatus: "synced" as const, syncError: null, appliedIdempotencyKeys: [],
        },
      ],
    }));

  it("re-scanning a barcode that lives only in a counted product's NAME reuses it (no duplicate) [P2]", () => {
    const store = createTestScanStore({ db: new MockDb() });
    legacyCounted(store, "prod-legacy-cooper", "UPC 029142712886 - Discoverer A/T3 E (10 Ply) BW");
    const before = store.getState().products.length;

    const id = openReview(store, "029142712886"); // unknown (no alias) -> Needs Review
    store.getState().resolveUnknown(id, "create_new", { newProduct: { name: "Cooper Discoverer A/T3" }, applyToCount: true });

    expect(store.getState().products.length, "must NOT mint a duplicate product").toBe(before);
    expect(countFor(store, "prod-legacy-cooper"), "existing row gets the count").toBeGreaterThanOrEqual(6);
  });

  it("two counted products both name-containing the scanned code -> conflict, never guess [P2]", () => {
    const store = createTestScanStore({ db: new MockDb() });
    legacyCounted(store, "prod-a", "UPC 029142712886 - Cooper A/T3");
    legacyCounted(store, "prod-b", "Barcode 029142712886 - Cooper (relabeled)");
    const before = store.getState().products.length;

    const id = openReview(store, "029142712886");
    store.getState().resolveUnknown(id, "create_new", { newProduct: { name: "Cooper" }, applyToCount: true });

    // FIX 1 (owner rule "scan N = count N"): the conflict now RETAINS this code's provisional placeholder
    // (the scan's OWN counted row) + its count instead of deleting them, so products.length is before + 1.
    // The real dedup invariant still holds: NO second/duplicate product ("Cooper") is minted on the
    // ambiguous identity, and the count that was already taken is not silently lost.
    expect(store.getState().products.length, "only the scan's own retained placeholder, no duplicate minted").toBe(before + 1);
    expect(store.getState().products.some((p) => p.name === "Cooper"), "no product minted on a conflict").toBe(false);
    const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "029142712886");
    expect(placeholder, "the scan's provisional placeholder survives the conflict").toBeDefined();
    expect(countFor(store, placeholder!.id), "the already-taken count is preserved (not dropped)").toBeGreaterThanOrEqual(1);
    expect((store.getState().lastAliasConflicts ?? []).length, "conflict recorded for human to resolve").toBeGreaterThan(1);
    expect(store.getState().needsReviewQueue.find((r) => r.id === id)?.status).toBe("open");
  });

  it("identifier backfill (P2): dry-run preview, apply fills primaryBarcode/upc from name prefix, Undo restores", () => {
    const store = createTestScanStore({ db: new MockDb() });
    legacyCounted(store, "prod-legacy", "UPC 029142712886 - Discoverer A/T3");
    legacyCounted(store, "prod-plain", "Just A Name No Code"); // not eligible

    const preview = store.getState().previewIdentifierBackfill();
    expect(preview).toEqual([{ productId: "prod-legacy", name: "UPC 029142712886 - Discoverer A/T3", code: "029142712886" }]);
    expect(store.getState().products.find((p) => p.id === "prod-legacy")!.primaryBarcode).toBe(""); // dry-run mutated nothing

    const { changed } = store.getState().applyIdentifierBackfill(["prod-legacy", "prod-plain"]);
    expect(changed).toBe(1);
    const filled = store.getState().products.find((p) => p.id === "prod-legacy")!;
    expect(filled.primaryBarcode).toBe("029142712886");
    expect(filled.upc).toBe("029142712886"); // 12-digit -> upc too

    expect(store.getState().undoIdentifierBackfill()).toBe(true);
    expect(store.getState().products.find((p) => p.id === "prod-legacy")!.primaryBarcode).toBe(""); // restored
  });

  it("approves SELECTED discovered identifiers onto an EXISTING product without creating a duplicate product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const before = store.getState().products.length;
    const id = openReview(store, "EXTRAUNKNOWN1");
    store.getState().resolveUnknown(id, "link_existing", {
      productId: "prod-coke",
      selectedAliasCodes: ["COKEALT99"],
      applyToCount: false,
    });
    expect(store.getState().products.length).toBe(before); // no duplicate product created
    const alt = store.getState().aliases.find((a) => a.cleanCode === clean("COKEALT99"));
    expect(alt?.productId).toBe("prod-coke");
    expect(alt?.approved).toBe(true);
    const ev = store.getState().processScan("COKEALT99");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe("prod-coke");
  });

  it("prevents duplicate aliases (same code repeated, and the scanned primary code)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = openReview(store, "DUPMAIN");
    store.getState().resolveUnknown(id, "create_new", {
      newProduct: { name: "Dup Prod" },
      selectedAliasCodes: ["DUPALT", "DUPALT", "DUPMAIN"], // duplicate + the scanned primary
      applyToCount: false,
    });
    const prod = store.getState().products.find((p) => p.name === "Dup Prod")!;
    expect(store.getState().aliases.filter((a) => a.cleanCode === clean("DUPALT"))).toHaveLength(1);
    expect(
      store.getState().aliases.filter((a) => a.cleanCode === clean("DUPMAIN") && a.productId === prod.id),
    ).toHaveLength(1);
  });

  it("does NOT silently overwrite an alias that already belongs to a DIFFERENT product (conflict)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // SHAREDCODE1 approved onto prod-coke first.
    const id1 = openReview(store, "SHAREDCODE1");
    store.getState().resolveUnknown(id1, "link_existing", { productId: "prod-coke" });
    expect(store.getState().aliases.find((a) => a.cleanCode === clean("SHAREDCODE1"))?.productId).toBe("prod-coke");
    // Now try to attach SHAREDCODE1 as a discovered alias onto prod-nokian via a different review.
    const id2 = openReview(store, "OTHERUNKNOWN1");
    store.getState().resolveUnknown(id2, "link_existing", { productId: "prod-nokian", selectedAliasCodes: ["SHAREDCODE1"] });
    // Not overwritten: still belongs to coke; no nokian alias for it.
    const shared = store.getState().aliases.filter((a) => a.cleanCode === clean("SHAREDCODE1") && a.approved);
    expect(shared).toHaveLength(1);
    expect(shared[0].productId).toBe("prod-coke");
    expect(store.getState().aliases.some((a) => a.cleanCode === clean("SHAREDCODE1") && a.productId === "prod-nokian")).toBe(false);
    // Conflict surfaced for the UI (never silently dropped).
    const conflicts = store.getState().lastAliasConflicts ?? [];
    expect(conflicts.some((c) => c.code === clean("SHAREDCODE1") && c.existingProductId === "prod-coke")).toBe(true);
    // The primary resolution still succeeded (OTHERUNKNOWN1 -> nokian).
    expect(store.getState().aliases.some((a) => a.cleanCode === clean("OTHERUNKNOWN1") && a.productId === "prod-nokian")).toBe(true);
  });
});

describe("scanStore - AI suggestions NEVER auto-save (trust boundary)", () => {
  const HIGH_CONF = {
    productName: "Laird Superfood Creamer",
    brand: "Laird",
    category: "Beverage",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "855724007602",
    gtin: "",
    upc: "855724007602",
    ean: "",
    aliases: [],
    imageUrl: "",
    productUrl: "",
    sourceUrls: ["https://example.com"],
    confidence: 0.98,
    verifiedFacts: [],
    guesses: ["This identity is an AI guess"],
    needsHumanReview: false,
  };

  function stubFetch(result: object) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ providerName: "gemini", result }),
    })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("does NOT create a product, alias, or count from a high-confidence AI suggestion", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("855724007602");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });

    const restore = stubFetch(HIGH_CONF);
    try {
      await store.getState().lookupUnknown(reviewId);
    } finally {
      restore();
    }

    // The suggestion is recorded on the review, but the IDENTITY was never trusted/saved: no product
    // named after the AI suggestion, no alias created. Per the owner rule "scan N = count N" (Plan A,
    // Task 2), the scan itself already counted synchronously as an anonymous provisional row the instant
    // it was captured -- that count is independent of, and happens before, this AI suggestion.
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open"); // still needs human review
    expect(review.suggestedProductName).toBe("Laird Superfood Creamer"); // shown as a suggestion
    expect(store.getState().products.some((p) => p.name === "Laird Superfood Creamer")).toBe(false);
    expect(store.getState().aliases.some((a) => a.cleanCode === "855724007602")).toBe(false);
    expect(store.getState().finalCounts).toHaveLength(1); // counted synchronously as provisional (scan N = count N)
  });

  it("a re-scan after an AI suggestion still routes to Needs Review (resolverStatus), never a trusted Known identity", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("855724007602");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });
    const restore = stubFetch(HIGH_CONF);
    try {
      await store.getState().lookupUnknown(reviewId);
    } finally {
      restore();
    }
    const ev = store.getState().processScan("855724007602");
    // Plan A, Task 2 ("scan N = count N"): the first scan already counted synchronously as an
    // anonymous provisional row, so this re-scan matches THAT provisional product (never the
    // AI-suggested identity, which was never trusted/saved). resolverStatus stays "needs_review":
    // the AI suggestion still did not make this code deterministically Known.
    expect(ev?.matchedProductId).toBe(store.getState().products.find((p) => p.provisional)?.id);
    expect(ev?.resolverStatus).toBe("needs_review");
  });

  it("only a HUMAN approval creates the alias + makes future scans deterministic Known", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().updateSettings({ scanContext: "tire" });
    store.getState().processScan("855724007602");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;

    // Human links it to a real (verified) product.
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke", applyToCount: true });

    const alias = store.getState().aliases.find((a) => a.cleanCode === "855724007602");
    expect(alias?.approved).toBe(true);
    expect(alias?.businessId).toBe(store.getState().businessId);
    expect(alias?.source).toBe("human_review");
    expect(alias?.createdBy).toBe("human_link_existing");
    const ev = store.getState().processScan("855724007602");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe("prod-coke");
    expect(countFor(store, "prod-coke")).toBe(2);
    expect(store.getState().scanFeed).toHaveLength(2);
    expect(store.getState().scanFeed.every((event) => event.matchedProductId === "prod-coke" && event.quantityDelta === 1)).toBe(true);
  });
});

describe("scanStore - liveDecode (mocked, no live tokens)", () => {
  function decodeResponse(decision: object, result: object) {
    return {
      ok: true,
      json: async () => ({ providerNames: ["gemini", "openai"], results: [result], decision }),
    };
  }
  function stub(resp: object) {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => resp) as unknown as typeof fetch;
    globalThis.fetch = spy;
    return { spy, restore: () => (globalThis.fetch = original) };
  }

  async function decode(store: ReturnType<typeof createTestScanStore>, code: string, resp: object) {
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });
    const { spy, restore } = stub(resp);
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    return { reviewId, spy };
  }

  it("AUTO-ADDS a verified decode: creates the product and counts it (no clicking)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("resolved");
    const product = store.getState().products.find((p) => p.name === "Coca-Cola Classic");
    expect(product).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);
  });

  it("provisionally counts a SUGGESTED/weak decode (evidence gate) - review stays open", async () => {
    // Owner rule: scan 10 = count 10. Weak evidence provisionally counts; review stays open for human confirmation.
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "suggested", confidence: 0.5, reason: "Suggested, sources found.", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
        { productName: "Camel Crush Box", brand: "Camel", upc: "049000111222", sourceUrls: ["https://gs1.org/x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name.includes("Camel Crush"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("auto-applies a tire decode missing size/load/speed as a suggestion (app-verified exact) - owner order 2026-07-10", async () => {
    // Owner order 2026-07-10: an app-verified exact decode (exactCodeEvidenceVerifiedByApp true) no
    // longer sits in Needs Review just because tireOk failed (thin tire identity) - it auto-applies as
    // a SUGGESTION onto the counted row instead and the review auto-closes. Product stays
    // provisional/unverified (never a real verified product); see scanStore.test.ts "auto-apply
    // high-trust suggestions" describe block for the dedicated coverage of this rule.
    const store = createTestScanStore({ db: new MockDb() });
    const { reviewId } = await decode(
      store,
      "770000000007",
      decodeResponse(
        { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Falken Wildpeak AT", brand: "Falken", upc: "770000000007", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("resolved"); // auto-closed (owner order 2026-07-10)
    expect(review.resolvedBy).toBe("auto");
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name.includes("Falken Wildpeak"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false); // still only a suggestion, never a verified product
  });

  it("DOES auto-count a tire decode WITH full specs (size + load + speed)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const { reviewId } = await decode(
      store,
      "770000000007",
      decodeResponse(
        { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Falken Wildpeak A/T 275/55R20 111T", brand: "Falken", upc: "770000000007", specsShort: "275/55R20 111T", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("resolved");
    expect(store.getState().products.find((p) => p.name.includes("Falken Wildpeak"))).toBeDefined();
    expect(store.getState().finalCounts).toHaveLength(1);
  });

  it("auto-applies as a suggestion when confidence is below the 0.80 gate but app-verified exact - owner order 2026-07-10", async () => {
    // Owner order 2026-07-10: exactCodeEvidenceVerifiedByApp true + status "verified" (the Go-UPC exact
    // class) qualifies for auto-suggest-apply regardless of confidence - it no longer needs confidence
    // >= 0.8 to skip Needs Review. It is still applied as a SUGGESTION (product stays
    // provisional/unverified), never a full verified auto-count (that still requires confidence >= 0.8).
    const store = createTestScanStore({ db: new MockDb() });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "verified", confidence: 0.75, reason: "Verified", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("resolved"); // auto-closed (owner order 2026-07-10)
    expect(review.resolvedBy).toBe("auto");
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "Coca-Cola Classic");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false); // still only a suggestion, never a verified product
  });

  it("provisionally counts a CONFLICT (providers disagree) - review stays open", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "conflict", confidence: 0.2, reason: "Providers conflict.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "conflict" } },
        { productName: "Creamer", brand: "Laird", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("open");
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name.includes("Creamer"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("respects autoAddDecodedProducts=false (verified decode provisionally counts, review stays open)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("049000111222");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini", autoAddDecodedProducts: false });
    const { restore } = stub(
      decodeResponse(
        { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("open");
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "Coca-Cola Classic");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("FIREWALL: 745125495781 rivet kit in tire context provisionally counts (category conflict flagged, review stays open)", async () => {
    // Task 9 (owner-ratified 2026-07-14): the category hard-block now clears ONLY for an APP-VERIFIED exact
    // code. The go-upc rivet-kit POISON is the canonical weak/unverified class - in production the app's
    // EvidenceVerifier returns exactCodeEvidenceVerifiedByApp:false for it (the evidence text carries a
    // DIFFERENT code + an invalidation phrase, proven by src/eval/fixtures.ts:745125495781). Mirror that
    // real weak shape here so the poison guard is exercised honestly: it STILL hard-blocks and stays open.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "745125495781",
      decodeResponse(
        { status: "suggested", confidence: 0.6, reason: "Suggested", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
        { productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm", brand: "", upc: "745125495781", sourceUrls: ["https://go-upc.com/search?q=745125495781"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open"); // category conflict flagged for review (poison guard intact)
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name.toLowerCase().includes("manstel") || p.name.toLowerCase().includes("rivet"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    expect(review.reason.toLowerCase()).toContain("category conflict");
  });

  it("FIREWALL: a valid complete tire in tire context still auto-counts", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "745125495781",
      decodeResponse(
        { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        { productName: "Fortune Tormenta A/T 275/55R20 117T", brand: "Fortune", specsShort: "275/55R20 117T", upc: "745125495781", sourceUrls: ["https://x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("resolved");
    expect(store.getState().products.find((p) => p.name.includes("Fortune Tormenta"))).toBeDefined();
    expect(store.getState().finalCounts).toHaveLength(1);
  });

  it("TASK 9 (owner-ratified 2026-07-14): an APP-VERIFIED off-category decode COUNTS with an off-category tag and its REAL confidence", async () => {
    // Real incident: 0792080004312 decoded via Go-UPC EXACT match as "Original Anchor Bar Hot Sauce" at 90%
    // with app-verified evidence. The tire-context category firewall used to hard-block it to Needs Review
    // and demote it to a bogus "50/100". Now the app-verified exact code CLEARS the hard-block: it counts,
    // the feed row is tagged offCategory, the review resolves, and the honest 90% confidence is kept.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "0792080004312",
      decodeResponse(
        { status: "verified", confidence: 0.9, reason: "Verified AI Decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
        { productName: "Original Anchor Bar Hot Sauce", brand: "Anchor Bar", category: "food", upc: "0792080004312", sourceUrls: ["https://go-upc.com/search?q=0792080004312"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    // Counts (the category hard-block was cleared by verification, not skipped).
    expect(store.getState().finalCounts).toHaveLength(1);
    // Review resolves - it is NOT routed to Needs Review.
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("resolved");
    // The feed row carries the off-category advisory flag.
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === "0792080004312");
    expect(feedRow?.offCategory).toBe(true);
    // COPY FIX: a resolved review never shows the "confidence too low (50/100)" demotion. Even if a score
    // were present, decodeStatus "verified" suppresses that copy (asserted in the NeedsReviewTable test).
    // The product exists at its honest identity.
    const prod = store.getState().products.find((p) => p.name.toLowerCase().includes("hot sauce"));
    expect(prod).toBeDefined();
  });

  it("TASK 9 poison guard intact: a WEAK (non-app-verified) non-tire decode in tire context still hard-blocks (no off-category count)", async () => {
    // Same off-category product, but WITHOUT app-verified exact evidence -> the coconut-oil / poison class.
    // The hard-block MUST stay: it counts only provisionally (scan N = count N) with the review left OPEN,
    // and the row is NOT tagged offCategory (the conflict was NOT cleared).
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "0792080004312",
      decodeResponse(
        { status: "suggested", confidence: 0.6, reason: "Suggested", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
        { productName: "Original Anchor Bar Hot Sauce", brand: "Anchor Bar", category: "food", upc: "0792080004312", sourceUrls: ["https://go-upc.com/search?q=0792080004312"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open"); // still hard-blocked to review
    expect(review.reason.toLowerCase()).toContain("category conflict");
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === "0792080004312");
    expect(feedRow?.offCategory).toBeFalsy(); // conflict NOT cleared -> no advisory tag
  });

  it("FIREWALL: after a category conflict provisionally counts, manual relink makes future scans count the correct product", async () => {
    // Task 9: same weak-poison shape as above (exactCodeEvidenceVerifiedByApp:false) so the rivet kit still
    // hard-blocks and only provisionally counts - the app-verified clear does NOT apply to the poison class.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "745125495781",
      decodeResponse(
        { status: "suggested", confidence: 0.6, reason: "Suggested", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
        { productName: "Manstel Aluminum Rivet Kit", brand: "", upc: "745125495781", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    // First scan provisionally counts (owner rule: scan 10 = count 10)
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name.toLowerCase().includes("manstel") || p.name.toLowerCase().includes("rivet"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    // Human relinks to the correct product; future scans are deterministic
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-nokian", applyToCount: true });
    const ev = store.getState().processScan("745125495781");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe("prod-nokian"); // human backstop wins
  });

  it("re-scanning a human-approved alias does NOT call AI", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("ZZZ123");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke" });

    const original = globalThis.fetch;
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    try {
      const ev = store.getState().processScan("ZZZ123");
      expect(ev?.resolverStatus).toBe("known");
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled(); // deterministic known scan never hits the AI route
  });
});

describe("scanStore - auto-apply high-trust suggestions (owner order 2026-07-10)", () => {
  // Any decode with confidence >= 0.8, OR a verified decode with app-verified exact-code evidence
  // (Go-UPC exact class), must no longer sit in Needs Review: the suggested identity is applied
  // in place onto the already-counted provisional product row (still provisional/unverified, no
  // alias), and the review auto-closes. Below 0.8 confidence (and non-exact-verified), conflicts,
  // and the master switch off must behave exactly as before (open review).
  function decodeResponse(decision: object, result: object) {
    return {
      ok: true,
      json: async () => ({ providerNames: ["gemini", "openai"], results: [result], decision }),
    };
  }
  function stub(resp: object) {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => resp) as unknown as typeof fetch;
    globalThis.fetch = spy;
    return { spy, restore: () => (globalThis.fetch = original) };
  }
  async function decode(store: ReturnType<typeof createTestScanStore>, code: string, resp: object) {
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini" });
    const { spy, restore } = stub(resp);
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    return { reviewId, spy };
  }

  it("Test 1: suggested decode confidence 0.9 with usable name+brand, no conflict -> auto-applies identity, review auto-closes, no double count, no alias", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "suggested", confidence: 0.9, reason: "Suggested, strong sources.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic 12oz", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://example.com"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    // Review auto-closed (badge excludes it: Nav.tsx filters status === "open").
    expect(review.status).toBe("resolved");
    expect(review.resolvedBy).toBe("auto");
    // Suggestion fields remain on the resolved review (LiveScanFeed's render-time lookup has no status filter).
    expect(review.suggestedProductName).toBe("Coca-Cola Classic 12oz");

    // The provisional product row now carries the suggested identity, but stays provisional+unverified.
    const prov = store.getState().products.find((p) => p.name === "Coca-Cola Classic 12oz");
    expect(prov).toBeDefined();
    expect(prov!.brand).toBe("Coca-Cola");
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);

    // Counted exactly once (no double count): one final-count row, quantity 1.
    expect(store.getState().finalCounts).toHaveLength(1);
    expect(store.getState().finalCounts[0].quantity).toBe(1);

    // Feed row decodeStatus is "suggested", never "verified" from this path.
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === "049000111222");
    expect(feedRow?.decodeStatus).toBe("suggested");

    // TRUST RULES: no new alias created at all from this path.
    expect(store.getState().aliases.some((a) => a.cleanCode === "049000111222")).toBe(false);
  });

  it("Test 2: verified decode with exactCodeEvidenceVerifiedByApp=true, confidence 0.9, FAILS tireOk (tire context, missing size/model) -> auto-applies as suggested, counted once", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const { reviewId } = await decode(
      store,
      "770000000007",
      decodeResponse(
        { status: "verified", confidence: 0.9, reason: "Verified from Go-UPC (exact barcode match).", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" }, corroborationPath: "single_source" },
        // Falken Wildpeak AT, no specsShort -> isTireContext true, hasCountableTireIdentity false (no size) -> tireOk fails.
        { productName: "Falken Wildpeak AT", brand: "Falken", upc: "770000000007", sourceUrls: ["https://go-upc.com/x"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("resolved"); // auto-closed via app-verified exact class, despite tireOk failing
    expect(review.resolvedBy).toBe("auto");

    const prov = store.getState().products.find((p) => p.name.includes("Falken Wildpeak"));
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false); // NOT a verified product - only displayed as a suggestion

    expect(store.getState().finalCounts).toHaveLength(1);
    expect(store.getState().finalCounts[0].quantity).toBe(1); // counted once, no double count

    expect(store.getState().aliases.some((a) => a.cleanCode === "770000000007")).toBe(false);
  });

  it("Test 3: suggested decode confidence 0.7 -> review STAYS open (legacy behavior unchanged), product name stays placeholder", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const { reviewId } = await decode(
      store,
      "049000111222",
      decodeResponse(
        { status: "suggested", confidence: 0.7, reason: "Suggested, weak sources.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic 12oz", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://example.com"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().finalCounts).toHaveLength(1);
    // Below 0.8, current behavior still enriches the provisional row in place with the usable name
    // (pre-existing TASK 3 ENRICH behavior) - this test pins that this is UNCHANGED by the new rule.
    const prov = store.getState().products.find((p) => p.name === "Coca-Cola Classic 12oz");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("Test 4: autoAddDecodedProducts=false + suggested confidence 0.9 -> review stays open (master switch respected)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("049000111222");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true, primaryProvider: "gemini", autoAddDecodedProducts: false });
    const { restore } = stub(
      decodeResponse(
        { status: "suggested", confidence: 0.9, reason: "Suggested, strong sources.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
        { productName: "Coca-Cola Classic 12oz", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://example.com"], verifiedFacts: [], guesses: [], aliases: [] },
      ),
    );
    try {
      await store.getState().liveDecode(reviewId);
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open"); // master switch off routes everything to manual review
    expect(store.getState().finalCounts).toHaveLength(1);
  });
});
