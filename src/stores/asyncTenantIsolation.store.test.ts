import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

type TestStore = ReturnType<typeof createTestScanStore>;

const LOOKUP_RESULT = {
  providerName: "mock-provider",
  result: {
    productName: "Tenant A lookup result",
    brand: "Tenant A",
    category: "Tires",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    imageUrl: "",
    productUrl: "",
    aliases: [],
    sourceUrls: [],
    verifiedFacts: [],
    guesses: [],
    confidence: 0.7,
    needsHumanReview: true,
  },
};

const LIVE_RESULT = {
  providerNames: ["mock-provider"],
  results: [{
    productName: "Tenant A live result",
    brand: "Tenant A",
    category: "Tires",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    imageUrl: "",
    productUrl: "",
    aliases: [],
    sourceUrls: [],
    verifiedFacts: [],
    guesses: [],
    confidence: 0.6,
  }],
  decision: {
    status: "suggested",
    confidence: 0.6,
    reason: "Suggestion for tenant A",
    evidenceStrength: "url_only",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "agree",
      confidence: 0.6,
      reason: "",
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  },
};

function storeWithOpenReview() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().updateSettings({ aiLookupEnabled: false });
  // Client-resolved prefix avoids an unrelated async /api/prefix-floor request in these AI-call tests.
  store.getState().processScan("051596000004");
  const reviewId = store.getState().needsReviewQueue.find((review) => review.status === "open")!.id;
  store.getState().updateSettings({ aiLookupEnabled: true });
  return { store, reviewId };
}

function switchToTenantB(store: TestStore) {
  const breaker = store.getState().breaker;
  store.setState((state) => ({
    businessId: "business-B",
    userId: "user-B",
    products: [],
    aliases: [],
    scanFeed: [],
    finalCounts: [],
    needsReviewQueue: [],
    aiLookupLogs: [],
    breaker,
    settings: {
      ...state.settings,
      dailyLookupCount: 41,
      lastResetDate: "2026-06-12",
    },
  }));
  return breaker;
}

function expectTenantBUnchanged(store: TestStore, breaker: TestStore["getState"] extends () => infer S ? S extends { breaker: infer B } ? B : never : never) {
  expect(store.getState()).toMatchObject({
    businessId: "business-B",
    userId: "user-B",
    products: [],
    aliases: [],
    scanFeed: [],
    finalCounts: [],
    needsReviewQueue: [],
    aiLookupLogs: [],
  });
  expect(store.getState().settings.dailyLookupCount).toBe(41);
  expect(store.getState().breaker).toBe(breaker);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("async decode tenant isolation", () => {
  it("drops a delayed lookupUnknown success after the active tenant changes", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { store, reviewId } = storeWithOpenReview();

    const lookup = store.getState().lookupUnknown(reviewId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const tenantBBreaker = switchToTenantB(store);
    resolveFetch({ ok: true, json: async () => LOOKUP_RESULT } as Response);
    await lookup;

    expectTenantBUnchanged(store, tenantBBreaker);
  });

  it("drops a delayed lookupUnknown failure after the active tenant changes", async () => {
    let rejectFetch!: (error: Error) => void;
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    vi.stubGlobal("fetch", fetch);
    const { store, reviewId } = storeWithOpenReview();

    const lookup = store.getState().lookupUnknown(reviewId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const tenantBBreaker = switchToTenantB(store);
    rejectFetch(new Error("tenant A network failure"));
    await lookup;

    expectTenantBUnchanged(store, tenantBBreaker);
  });

  it("drops a delayed live decode success after the active tenant changes", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { store, reviewId } = storeWithOpenReview();

    const decode = store.getState().runLiveDecodeOnce(reviewId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const tenantBBreaker = switchToTenantB(store);
    resolveFetch({ ok: true, status: 200, json: async () => LIVE_RESULT } as Response);
    await decode;

    expectTenantBUnchanged(store, tenantBBreaker);
  });

  it("drops a delayed live decode failure after the active tenant changes", async () => {
    let rejectFetch!: (error: Error) => void;
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    vi.stubGlobal("fetch", fetch);
    const { store, reviewId } = storeWithOpenReview();

    const decode = store.getState().runLiveDecodeOnce(reviewId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const tenantBBreaker = switchToTenantB(store);
    rejectFetch(new Error("tenant A decode failure"));
    await decode;

    expectTenantBUnchanged(store, tenantBBreaker);
  });

  it("drops a delayed background deep-verify success after the active tenant changes", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { store, reviewId } = storeWithOpenReview();

    const deepVerify = store.getState().backgroundVerifyDeep(reviewId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const tenantBBreaker = switchToTenantB(store);
    resolveFetch({
      ok: true,
      json: async () => ({
        results: [{
          productName: "Tenant A deep result",
          brand: "Tenant A",
          sourceUrls: [],
          verifiedFacts: [],
          guesses: [],
          aliases: [],
          confidence: 0.6,
        }],
        decision: {
          status: "suggested",
          confidence: 0.6,
          reason: "Deep suggestion for tenant A",
          evidenceStrength: "url_only",
          exactCodeEvidenceVerifiedByApp: false,
        },
      }),
    } as Response);
    await deepVerify;

    expectTenantBUnchanged(store, tenantBBreaker);
  });
});
