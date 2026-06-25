import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Tasks 5+6: client-orchestrated background verify. A tire scan whose FAST decode lands "suggested"
// must auto-fire ONE mode:"decode-deep" request WITH scanContext:"tire"; on a "verified" deep response
// the row upgrades to counted (finalCounts +1, removed from needsReviewQueue, alias learned). A late /
// duplicate deep response must NEVER double-count. The decode RESPONSES are mocked (no live AI/tokens).

const HANKOOK_CODE = "715459332915";

// FAST hot path (mode:"decode"): grounded but NOT app-strong -> suggested (matches the proven live shape).
const HANKOOK_FAST_SUGGESTED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Hankook Dynapro AT2 LT265/70R17 121S", brand: "Hankook", category: "Tire",
    specsShort: "LT265/70R17 121S", specsFull: "", primarySku: "", primaryBarcode: HANKOOK_CODE, gtin: "",
    upc: HANKOOK_CODE, ean: "", aliases: [], imageUrl: "", productUrl: "https://hankooktire.com/dynapro-at2",
    sourceUrls: ["https://www.upcitemdb.com/upc/715459332915"], confidence: 0.6, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "suggested", confidence: 0.6, reason: "Grounded, not app-verified.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

// DEEP path (mode:"decode-deep" + scanContext:"tire"): page-fetched + app-verified exact code -> verified.
const HANKOOK_DEEP_VERIFIED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Hankook Dynapro AT2 LT265/70R17 121S", brand: "Hankook", category: "Tire",
    specsShort: "LT265/70R17 121S", specsFull: "", primarySku: "", primaryBarcode: HANKOOK_CODE, gtin: "",
    upc: HANKOOK_CODE, ean: "", aliases: [], imageUrl: "", productUrl: "https://hankooktire.com/dynapro-at2",
    sourceUrls: ["https://hankooktire.com/dynapro-at2"], confidence: 0.92, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "verified", confidence: 0.92, reason: "Verified: exact UPC confirmed on the product page (fetched_source).", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
};

/**
 * Mode-aware fetch stub: mode:"decode" -> fast suggested; mode:"decode-deep" -> deep verified. Records
 * how many decode-deep calls were made so the test can assert a late/duplicate response is idempotent.
 */
function modeStub(opts?: { deepDelayMs?: number }) {
  const original = globalThis.fetch;
  const calls = { decode: 0, decodeDeep: 0 };
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.mode === "decode-deep") {
      calls.decodeDeep++;
      if (opts?.deepDelayMs) await new Promise((r) => setTimeout(r, opts.deepDelayMs));
      return { ok: true, json: async () => HANKOOK_DEEP_VERIFIED };
    }
    calls.decode++;
    return { ok: true, json: async () => HANKOOK_FAST_SUGGESTED };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function tireAiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
  return store;
}

// SIZE + MODEL ONLY (no load index, no speed rating). Cooper prefix 029142...; identity "Cooper Discoverer
// AT3 245/75R16". This is a COUNTABLE tire identity (brand + size + model) but does NOT have full specs, so
// the old store gate (hasRequiredTireSpecs) routed a genuinely verified tire to review = the dead-end.
const COOPER_CODE = "029142753568";

const COOPER_FAST_SUGGESTED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper", category: "Tire",
    specsShort: "245/75R16", specsFull: "", primarySku: "", primaryBarcode: COOPER_CODE, gtin: "",
    upc: COOPER_CODE, ean: "", aliases: [], imageUrl: "", productUrl: "https://coopertire.com/discoverer-at3",
    sourceUrls: ["https://www.upcitemdb.com/upc/029142753568"], confidence: 0.6, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "suggested", confidence: 0.6, reason: "Grounded, not app-verified.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

const COOPER_DEEP_VERIFIED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper", category: "Tire",
    specsShort: "245/75R16", specsFull: "", primarySku: "", primaryBarcode: COOPER_CODE, gtin: "",
    upc: COOPER_CODE, ean: "", aliases: [], imageUrl: "", productUrl: "https://coopertire.com/discoverer-at3",
    sourceUrls: ["https://coopertire.com/discoverer-at3"], confidence: 0.92, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "verified", confidence: 0.92, reason: "Verified: exact UPC confirmed on the product page (fetched_source).", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
};

function cooperModeStub() {
  const original = globalThis.fetch;
  const calls = { decode: 0, decodeDeep: 0 };
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.mode === "decode-deep") {
      calls.decodeDeep++;
      return { ok: true, json: async () => COOPER_DEEP_VERIFIED };
    }
    calls.decode++;
    return { ok: true, json: async () => COOPER_FAST_SUGGESTED };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("client-orchestrated background verify (suggested tire -> verified -> counted)", () => {
  it("a suggested tire fires decode-deep WITH scanContext:'tire' and upgrades to counted + alias learned", async () => {
    const store = tireAiStore();
    const { calls, restore } = modeStub();
    try {
      store.getState().processScan(HANKOOK_CODE);
      // Wait until the background deep pass has resolved the review (counted).
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }

    // The fast pass ran, then exactly ONE background decode-deep request fired.
    expect(calls.decode).toBeGreaterThanOrEqual(1);
    expect(calls.decodeDeep).toBe(1);

    // The deep request carried scanContext:"tire" (mandatory) and mode:"decode-deep".
    const fetchMock = globalThis.fetch as unknown as { mock?: { calls: [unknown, { body: string }][] } };
    // (fetch was restored; assert via the recorded call count above + the body shape on a fresh capture)

    // Counted: the tire product exists, is in finalCounts with quantity 1, and removed from the open queue.
    const prod = store.getState().products.find((p) => p.brand === "Hankook");
    expect(prod, "Hankook tire product must be created + counted").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().needsReviewQueue.some((r) => r.status === "open")).toBe(false);

    // Alias learned: the scanned code is now a deterministic APPROVED alias (re-scan counts with no AI).
    expect(store.getState().aliases.some((a) => a.cleanCode === HANKOOK_CODE && a.approved)).toBe(true);
    void fetchMock;
  });

  it("the background decode-deep request body sends mode:'decode-deep' and scanContext:'tire'", async () => {
    const store = tireAiStore();
    const original = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      bodies.push(body);
      if (body.mode === "decode-deep") return { ok: true, json: async () => HANKOOK_DEEP_VERIFIED };
      return { ok: true, json: async () => HANKOOK_FAST_SUGGESTED };
    }) as unknown as typeof fetch;
    try {
      store.getState().processScan(HANKOOK_CODE);
      await vi.waitFor(() => expect(store.getState().finalCounts).toHaveLength(1));
    } finally {
      globalThis.fetch = original;
    }
    const deep = bodies.find((b) => b.mode === "decode-deep");
    expect(deep, "a decode-deep request must have been sent").toBeDefined();
    expect(deep!.scanContext).toBe("tire");
  });

  it("a late / DUPLICATE deep verified response does NOT double-count (idempotent via open-status guard)", async () => {
    const store = tireAiStore();
    const { restore } = modeStub();
    try {
      store.getState().processScan(HANKOOK_CODE);
      const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
      await vi.waitFor(() => expect(store.getState().finalCounts).toHaveLength(1));

      // Simulate a LATE/duplicate background response arriving after the row already counted.
      await store.getState().backgroundVerifyDeep(reviewId);
      await store.getState().backgroundVerifyDeep(reviewId);
    } finally {
      restore();
    }

    const prod = store.getState().products.find((p) => p.brand === "Hankook");
    // Still exactly one count and one product row - the duplicate responses were no-ops.
    expect(store.getState().finalCounts.filter((c) => c.productId === prod!.id)).toHaveLength(1);
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().products.filter((p) => p.brand === "Hankook")).toHaveLength(1);
    // And the alias was not duplicated.
    expect(store.getState().aliases.filter((a) => a.cleanCode === HANKOOK_CODE && a.approved)).toHaveLength(1);
  });

  it("a NON-verified deep result never counts (stays open, finalCounts empty)", async () => {
    const store = tireAiStore();
    const original = globalThis.fetch;
    // Both passes return suggested -> the deep pass must NOT count.
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => HANKOOK_FAST_SUGGESTED })) as unknown as typeof fetch;
    try {
      store.getState().processScan(HANKOOK_CODE);
      const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
      // Drive the background pass explicitly and confirm it does not count a suggested result.
      await store.getState().backgroundVerifyDeep(reviewId);
    } finally {
      globalThis.fetch = original;
    }
    expect(store.getState().finalCounts).toHaveLength(0);
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open");
    expect(store.getState().aliases.some((a) => a.cleanCode === HANKOOK_CODE && a.approved)).toBe(false);
  });

  // FIX 1 (the dead-end): a verified size+model tire with NO load/speed must COUNT, matching the route's
  // verify gate (hasCountableTireIdentity). Before the fix the store required FULL specs, so this exact
  // identity (which the route already returns "verified") was wrongly routed to review = the feature dead-end.
  it("a verified tire with size + model but NO load/speed (countable identity) ends up COUNTED, not in review", async () => {
    const store = tireAiStore();
    const { calls, restore } = cooperModeStub();
    try {
      store.getState().processScan(COOPER_CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }

    // The deep pass ran exactly once.
    expect(calls.decode).toBeGreaterThanOrEqual(1);
    expect(calls.decodeDeep).toBe(1);

    // COUNTED: the Cooper tire exists, is in finalCounts qty 1, and is OUT of the open needs-review queue.
    const prod = store.getState().products.find((p) => p.brand === "Cooper");
    expect(prod, "Cooper tire product must be created + counted").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().needsReviewQueue.some((r) => r.status === "open")).toBe(false);

    // Alias learned: the scanned code is now a deterministic APPROVED alias.
    expect(store.getState().aliases.some((a) => a.cleanCode === COOPER_CODE && a.approved)).toBe(true);
  });
});
