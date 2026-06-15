import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

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

  it("routes the unknown code to Needs Review (not counted)", () => {
    const review = store.getState().needsReviewQueue;
    expect(review).toHaveLength(1);
    expect(review[0].cleanCode).toBe("UNKNOWN123");
    expect(review[0].status).toBe("open");
  });

  it("groups the final count table by product, not by code", () => {
    // 5 known codes across 3 products -> exactly 3 count rows
    expect(store.getState().finalCounts).toHaveLength(3);
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

    // The suggestion is recorded on the review, but nothing was trusted/saved/counted.
    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.status).toBe("open"); // still needs human review
    expect(review.suggestedProductName).toBe("Laird Superfood Creamer"); // shown as a suggestion
    expect(store.getState().products.some((p) => p.name === "Laird Superfood Creamer")).toBe(false);
    expect(store.getState().aliases.some((a) => a.cleanCode === "855724007602")).toBe(false);
    expect(store.getState().finalCounts).toHaveLength(0);
  });

  it("a re-scan after an AI suggestion still routes to Needs Review, never Known", async () => {
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
    expect(ev?.matchedProductId).toBeNull();
    expect(ev?.resolverStatus).toBe("needs_review");
  });

  it("only a HUMAN approval creates the alias + makes future scans deterministic Known", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().processScan("855724007602");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.status === "open")!.id;

    // Human links it to a real (verified) product.
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke", applyToCount: true });

    const alias = store.getState().aliases.find((a) => a.cleanCode === "855724007602");
    expect(alias?.approved).toBe(true);
    const ev = store.getState().processScan("855724007602");
    expect(ev?.resolverStatus).toBe("known");
    expect(ev?.matchedProductId).toBe("prod-coke");
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

  it("trusts the AI: a suggested (usable-name) decode auto-adds + counts", async () => {
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
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)!.status).toBe("resolved");
    const product = store.getState().products.find((p) => p.name === "Camel Crush Box");
    expect(product).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);
  });

  it("does NOT auto-add a CONFLICT (providers disagree) - that stays in Needs Review", async () => {
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
    expect(store.getState().finalCounts).toHaveLength(0);
  });

  it("respects autoAddDecodedProducts=false (then a verified decode just shows, no auto-count)", async () => {
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
    expect(store.getState().finalCounts).toHaveLength(0);
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
