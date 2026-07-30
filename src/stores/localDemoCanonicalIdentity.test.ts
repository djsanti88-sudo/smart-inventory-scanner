import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

const LOCAL_TIRE_UID = "TIRE_4959A8AD1134FEABF0AC";

function localTireResponse(overrides: Record<string, unknown> = {}) {
  return {
    mode: "decode",
    providerNames: ["local-tire-corpus"],
    results: [{
      productName: "Falken Wildpeak A/T Trail 225/65R17 102H",
      brand: "Falken",
      category: "Tire",
      specsShort: "225/65R17 102H",
      specsFull: "",
      primarySku: "",
      primaryBarcode: "848983007933",
      gtin: "",
      upc: "848983007933",
      ean: "",
      aliases: [],
      imageUrl: "",
      productUrl: "",
      sourceUrls: [],
      confidence: 1,
      verifiedFacts: [],
      guesses: [],
      needsHumanReview: false,
    }],
    decision: {
      status: "verified",
      confidence: 1,
      reason: "Exact match found in the local tire database.",
      evidenceStrength: "fetched_source",
      exactCodeEvidenceVerifiedByApp: true,
      crossCheck: { decision: "single_provider", confidence: 1, reason: "Local corpus match.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    },
    debug: { canonicalProductUid: LOCAL_TIRE_UID, corroborationPath: "corpus_exact_barcode", aiCalled: false },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("local-demo canonical identity provenance", () => {
  it("binds a verified local tire UID to its one counted scan through the resolved remap", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("848983007933");
    const review = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === "848983007933" && entry.status === "open");
    expect(review).toBeDefined();
    store.getState().updateSettings({ aiLookupEnabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => localTireResponse() })));

    await store.getState().liveDecode(review!.id);

    const event = store.getState().scanFeed.find((entry) => entry.cleanCode === "848983007933");
    expect(event?.localDemoCanonicalProductUid).toBe(LOCAL_TIRE_UID);
    expect(event?.matchedProductId).toBeTruthy();
    expect(store.getState().finalCounts.reduce((total, count) => total + count.quantity, 0)).toBe(1);
    expect(store.getState().finalCounts.find((count) => count.productId === event?.matchedProductId)?.quantity).toBe(1);
  });

  it.each([
    ["a nonlocal provider", { providerNames: ["go-upc"] }],
    ["a malformed local UID", { debug: { canonicalProductUid: "provider-injection", corroborationPath: "corpus_exact_barcode", aiCalled: false } }],
  ])("does not persist a UID from %s", async (_name, overrides) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("848983007933");
    const review = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === "848983007933" && entry.status === "open");
    expect(review).toBeDefined();
    store.getState().updateSettings({ aiLookupEnabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => localTireResponse(overrides),
    })));

    await store.getState().liveDecode(review!.id);

    expect(store.getState().scanFeed.find((entry) => entry.cleanCode === "848983007933")?.localDemoCanonicalProductUid).toBeUndefined();
  });
});
