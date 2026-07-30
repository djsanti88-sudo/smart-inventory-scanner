import { describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

describe("scanStore trusted corpus model propagation", () => {
  it("applies an exact-barcode corpus model after parsing to its one provisional count", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "848983006257";
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.cleanCode === code)!.id;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
      mode: "decode", providerNames: ["tire-corpus"],
      debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false },
      decision: { status: "verified", confidence: 0.97, reason: "Verified", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider", confidence: 0.97, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] } },
      results: [{ productName: "Kumho Crugen HP71 245/60R18", brand: "Kumho", category: "Tire", specsShort: "245/60R18", trustedStructuredModel: "Crugen HP71", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
    }) })) as unknown as typeof fetch;
    try { await store.getState().liveDecode(reviewId); } finally { globalThis.fetch = originalFetch; }

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    const product = store.getState().products.find((p) => p.id === review.provisionalProductId)!;
    expect(review).not.toHaveProperty("trustedStructuredModel");
    expect(product).toMatchObject({ structuredModel: "Crugen HP71", structuredBy: "trusted_corpus" });
    expect(store.getState().scanFeed.filter((event) => event.cleanCode === code)).toHaveLength(1);
    expect(store.getState().finalCounts.filter((count) => count.productId === product.id)).toMatchObject([{ quantity: 1 }]);
  });

  it("rejects the same field when the response is a part-number suggestion", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("PN123");
    const reviewId = store.getState().needsReviewQueue.find((r) => r.cleanCode === "PN123")!.id;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
      mode: "decode", providerNames: ["tire-corpus"], debug: { corroborationPath: "corpus_exact_part_number", aiCalled: false },
      decision: { status: "suggested", confidence: 0.85, reason: "Suggested", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider", confidence: 0.85, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] } },
      results: [{ productName: "Kumho Crugen HP71", trustedStructuredModel: "Injected", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
    }) })) as unknown as typeof fetch;
    try { await store.getState().liveDecode(reviewId); } finally { globalThis.fetch = originalFetch; }
    expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)).not.toHaveProperty("trustedStructuredModel");
  });

  it("clears a prior trusted model when a later decode for the same review is not eligible", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "848983006258";
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.cleanCode === code)!.id;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mode: "decode", providerNames: ["tire-corpus"],
        debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false },
        decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true },
        results: [{ productName: "", trustedStructuredModel: "Crugen HP71", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mode: "decode", providerNames: ["tire-corpus"],
        debug: { corroborationPath: "corpus_exact_part_number", aiCalled: false },
        decision: { status: "suggested", exactCodeEvidenceVerifiedByApp: false },
        results: [{ productName: "", trustedStructuredModel: "Injected", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
      }) }) as unknown as typeof fetch;
    try {
      await store.getState().liveDecode(reviewId);
      await store.getState().liveDecode(reviewId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Human Tire" },
    });

    const product = store.getState().products.find((p) => p.primaryBarcode === code)!;
    expect(product.structuredModel).not.toBe("Crugen HP71");
  });

  it("does not apply an old trusted model after a retry fetch fails", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "848983006260";
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.cleanCode === code)!.id;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mode: "decode", providerNames: ["tire-corpus"],
        debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false },
        decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true },
        results: [{ productName: "", trustedStructuredModel: "Crugen HP71", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
      }) })
      .mockRejectedValueOnce(new Error("network unavailable")) as unknown as typeof fetch;
    try {
      await store.getState().liveDecode(reviewId);
      expect(store.getState().needsReviewQueue.find((r) => r.id === reviewId)?.status).toBe("open");
      await store.getState().liveDecode(reviewId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Human Tire" },
    });

    const product = store.getState().products.find((p) => p.primaryBarcode === code)!;
    expect(product.structuredModel).not.toBe("Crugen HP71");
  });

  it.each([
    ["a business switch", (store: ReturnType<typeof createTestScanStore>) => store.getState().setBusinessContext("business-other", "user-other")],
    ["sign-out reset", (store: ReturnType<typeof createTestScanStore>) => store.getState().resetForSignOut()],
    ["a new session", (store: ReturnType<typeof createTestScanStore>) => store.getState().startSession("New", "Main")],
    ["session clear", (store: ReturnType<typeof createTestScanStore>) => store.getState().clearSession()],
    ["local cache clear", (store: ReturnType<typeof createTestScanStore>) => store.getState().clearLocalCache()],
  ])("discards a trusted model after %s empties or replaces reviews", async (_label, clearReviews) => {
    const store = createTestScanStore({ db: new MockDb(), idFactory: () => "stable" });
    const code = "848983006259";
    store.getState().processScan(code);
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === code)!;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
      mode: "decode", providerNames: ["tire-corpus"],
      debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false },
      decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true },
      results: [{ productName: "", trustedStructuredModel: "Crugen HP71", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
    }) })) as unknown as typeof fetch;
    try { await store.getState().liveDecode(review.id); } finally { globalThis.fetch = originalFetch; }

    clearReviews(store);
    store.setState({ needsReviewQueue: [review] });
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Human Tire" },
    });

    expect(store.getState().products.some((p) => p.structuredModel === "Crugen HP71")).toBe(false);
  });

  it.each([
    ["a provider-injected result", { providerNames: ["gpt"], debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false } }],
    ["multiple providers", { providerNames: ["tire-corpus", "gpt"], debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false } }],
    ["an AI-called corpus-shaped result", { providerNames: ["tire-corpus"], debug: { corroborationPath: "corpus_exact_barcode", aiCalled: true } }],
  ])("does not apply the model from %s", async (_label, overrides) => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "777000000002";
    store.getState().processScan(code);
    const reviewId = store.getState().needsReviewQueue.find((r) => r.cleanCode === code)!.id;
    store.getState().updateSettings({ aiLookupEnabled: true });
    const originalFetch = globalThis.fetch;
    const corpusResponse = {
      mode: "decode", providerNames: ["tire-corpus"],
      debug: { corroborationPath: "corpus_exact_barcode", aiCalled: false },
      decision: { status: "verified", confidence: 0.97, reason: "Verified", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider", confidence: 0.97, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] } },
      results: [{ productName: "Kumho Crugen HP71 245/60R18", brand: "Kumho", category: "Tire", specsShort: "245/60R18", trustedStructuredModel: "Injected Corpus Model", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [] }],
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
      ...corpusResponse,
      ...overrides,
    }) })) as unknown as typeof fetch;
    try { await store.getState().liveDecode(reviewId); } finally { globalThis.fetch = originalFetch; }

    expect(store.getState().products.some((p) => p.structuredModel === "Injected Corpus Model")).toBe(false);
  });

  it("ignores a forged persisted review marker when resolving a product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("777000000001");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "777000000001")!;
    store.setState({
      needsReviewQueue: [{ ...review, trustedStructuredModel: "Forged Model" } as typeof review],
    });

    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Human Tire" },
    });

    const product = store.getState().products.find((p) => p.id === review.provisionalProductId)!;
    expect(product.structuredModel).not.toBe("Forged Model");
  });
});
