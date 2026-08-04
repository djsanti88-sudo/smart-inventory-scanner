import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";

const UNKNOWN_VALID_UPC = "012345678905";

function deterministicMissResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      providerNames: [],
      results: [],
      decision: {
        status: "needs_review",
        confidence: 0,
        reason: "No deterministic match.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "not_checked" },
      },
    }),
  } as unknown as Response;
}

function decodeRequests(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/ai-lookup");
}

function prefixFloorRequests(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes("/api/prefix-floor"));
}

function deterministicExactResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      providerNames: ["tire-corpus"],
      results: [{ productName: "Exact tire", brand: "Acme", category: "Tire", aliases: [], sourceUrls: [] }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Trusted exact index match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheck: { decision: "agree" },
      },
    }),
  } as unknown as Response;
}

function bossTrustedExactResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      providerNames: ["tire-corpus"],
      results: [{ productName: "Boss exact tire", brand: "Acme", category: "Tire", aliases: [], sourceUrls: [] }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Trusted exact index match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: "trusted-exact:00012345678905",
        crossCheck: { decision: "agree" },
      },
      debug: { trustedExactIndex: { schemaVersion: "1.0.0", contentDigest: "a".repeat(64) } },
    }),
  } as unknown as Response;
}

function bossTrustedShortCodeResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      providerNames: ["tire-corpus"],
      results: [{ productName: "Boss short-code tire", brand: "Blackhawk", category: "Tire", aliases: [], sourceUrls: [] }],
      decision: {
        status: "verified", confidence: 1, reason: "Trusted exact index match.", evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true, corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: "trusted-exact:canonical:TIRE_D0F7590DC52EB30084BC", crossCheck: { decision: "agree" },
      },
      debug: { trustedExactIndex: { schemaVersion: "1.0.0", contentDigest: "a".repeat(64) } },
    }),
  } as unknown as Response;
}

describe("Task 4 deterministic-only lookup dispatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("settles an approved non-GTIN exact scan directly without alias or catalog writes", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async () => bossTrustedShortCodeResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const event = store.getState().processScan("3220017438");

    expect(event?.rawCode).toBe("3220017438");
    expect(store.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));
    expect(decodeRequests(fetchSpy)).toHaveLength(1);
    const state = store.getState();
    expect(state.scanFeed[0]).toMatchObject({ status: "known", decodeStatus: "verified", rawCode: "3220017438" });
    expect(state.products.find((product) => product.trustedExactCanonicalId === "trusted-exact:canonical:TIRE_D0F7590DC52EB30084BC")?.aliases).toEqual([]);
    expect(state.needsReviewQueue.some((review) => review.status === "open" || review.status === "suggested")).toBe(false);
  });

  it.each([
    ["AI disabled", (store: ReturnType<typeof createTestScanStore>) => store.getState().updateSettings({ aiLookupEnabled: false })],
    ["provider keys absent", (store: ReturnType<typeof createTestScanStore>) => store.setState((state) => ({ aiStatus: { ...state.aiStatus, geminiConfigured: false, openaiConfigured: false, freeDecodeAvailable: false } }))],
    ["daily cap reached", (store: ReturnType<typeof createTestScanStore>) => store.getState().updateSettings({ dailyLookupLimit: 1, dailyLookupCount: 1, lastResetDate: "2026-08-03" })],
    ["breaker open", (store: ReturnType<typeof createTestScanStore>) => store.setState((state) => ({ breaker: { ...state.breaker, state: "open", openedAt: Date.now() } }))],
    ["kill switch on", (store: ReturnType<typeof createTestScanStore>) => store.setState((state) => ({ aiStatus: { ...state.aiStatus, emergencyStop: true } }))],
  ])("issues deterministic-only lookup when %s", async (_gate, closeAiGate) => {
    const store = createTestScanStore({ db: new MockDb() });
    const fetchSpy = vi.fn(async () => deterministicMissResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    closeAiGate(store);

    const event = store.getState().processScan(UNKNOWN_VALID_UPC);

    expect(event).not.toBeNull();
    expect(event?.decodeStatus).toBe("decoding");
    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("decoding");
    expect(store.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
    await vi.waitFor(() => expect(decodeRequests(fetchSpy)).toHaveLength(1));
    const body = JSON.parse(String(decodeRequests(fetchSpy)[0]?.[1]?.body));
    expect(body.deterministicOnly).toBe(true);
    expect(store.getState().needsReviewQueue[0]?.status).toBe("open");
  });

  it("does not request deterministic lookup while offline or after a bad GTIN check digit", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const fetchSpy = vi.fn(async () => deterministicMissResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().setOnline(false);
    store.getState().processScan(UNKNOWN_VALID_UPC);
    store.getState().setOnline(true);
    store.getState().processScan("012345678906");

    await Promise.resolve();
    expect(decodeRequests(fetchSpy)).toHaveLength(0);
    expect(store.getState().scanFeed).toHaveLength(2);
    expect(store.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(2);
    expect(store.getState().needsReviewQueue.every((review) => review.status === "open")).toBe(true);
  });

  it("runs the deterministic exact lookup before the global catalog fallback", async () => {
    const calls: string[] = [];
    const lookupGlobalCatalog = vi.fn(async () => {
      calls.push("catalog");
      return null;
    });
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === "/api/ai-lookup") calls.push("decode");
      return deterministicMissResponse();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(UNKNOWN_VALID_UPC);

    await vi.waitFor(() => expect(calls).toEqual(["decode", "catalog"]));
    expect(decodeRequests(fetchSpy)).toHaveLength(1);
    expect(lookupGlobalCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not call the global catalog after a trusted exact hit", async () => {
    const lookupGlobalCatalog = vi.fn(async () => null);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async () => bossTrustedExactResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(UNKNOWN_VALID_UPC);

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));
    expect(decodeRequests(fetchSpy)).toHaveLength(1);
    expect(prefixFloorRequests(fetchSpy)).toHaveLength(0);
    expect(lookupGlobalCatalog).not.toHaveBeenCalled();
  });

  it("keeps deterministicOnly on the rate-limit retry request", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "test retry")!;
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        json: async () => ({}),
      })
      .mockResolvedValueOnce(deterministicMissResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await store.getState().liveDecode(reviewId, { deterministicOnly: true });

    expect(decodeRequests(fetchSpy)).toHaveLength(2);
    for (const [, init] of decodeRequests(fetchSpy)) {
      expect(JSON.parse(String(init?.body)).deterministicOnly).toBe(true);
    }
    expect(decodeRequests(fetchSpy)[0]?.[1]?.signal).not.toBe(decodeRequests(fetchSpy)[1]?.[1]?.signal);
  });

  it("does not turn a failed non-cap 429 retry into a third deterministic request", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "429 transport failure")!;
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        json: async () => ({}),
      } as unknown as Response)
      .mockRejectedValueOnce(new TypeError("retry transport failure"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await store.getState().liveDecode(reviewId, { deterministicOnly: true });

    expect(decodeRequests(fetchSpy)).toHaveLength(2);
    expect(store.getState().needsReviewQueue.find((review) => review.id === reviewId)?.status).toBe("open");
  });

  it("retries one transient deterministic request with a fresh abort signal and settles its exact hit", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setOnline(false);
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "deterministic retry")!;
    store.getState().setOnline(true);
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network temporarily unavailable"))
      .mockResolvedValueOnce(bossTrustedExactResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await store.getState().liveDecode(reviewId, { deterministicOnly: true });

    expect(decodeRequests(fetchSpy)).toHaveLength(2);
    const requests = decodeRequests(fetchSpy);
    expect(JSON.parse(String(requests[0]?.[1]?.body)).deterministicOnly).toBe(true);
    expect(JSON.parse(String(requests[1]?.[1]?.body)).deterministicOnly).toBe(true);
    expect(requests[0]?.[1]?.signal).not.toBe(requests[1]?.[1]?.signal);
    expect(store.getState().needsReviewQueue.find((review) => review.id === reviewId)?.status).toBe("resolved");
  });

  it("retries a deterministic 5xx once without changing it into a paid decode", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setOnline(false);
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "deterministic 5xx retry")!;
    store.getState().setOnline(true);
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce(bossTrustedExactResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await store.getState().liveDecode(reviewId, { deterministicOnly: true });

    expect(decodeRequests(fetchSpy)).toHaveLength(2);
    expect(decodeRequests(fetchSpy).every(([, init]) => JSON.parse(String(init?.body)).deterministicOnly === true)).toBe(true);
    expect(store.getState().needsReviewQueue.find((review) => review.id === reviewId)?.status).toBe("resolved");
  });

  it("stops after one exhausted transient deterministic retry without invoking a paid decode", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setOnline(false);
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "deterministic retry exhaustion")!;
    store.getState().setOnline(true);
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network temporarily unavailable"))
      .mockRejectedValueOnce(new TypeError("still unavailable"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(store.getState().liveDecode(reviewId, { deterministicOnly: true })).rejects.toThrow(
      "Transient deterministic lookup transport failure",
    );

    expect(decodeRequests(fetchSpy)).toHaveLength(2);
    expect(decodeRequests(fetchSpy).every(([, init]) => JSON.parse(String(init?.body)).deterministicOnly === true)).toBe(true);
    const review = store.getState().needsReviewQueue.find((item) => item.id === reviewId);
    expect(review?.status).toBe("open");
    expect(review?.decodeStatus).toBe("decoding");
    expect(review?.reason).toMatch(/Trusted exact lookup was interrupted/);
  });

  it("keeps an exhausted trusted-exact abort in exact recovery without catalog suggestion or review", async () => {
    vi.useFakeTimers();
    try {
      const lookupGlobalCatalog = vi.fn(async () => null);
      const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
      store.getState().updateSettings({ aiLookupEnabled: false });
      const fetchSpy = vi
        .fn()
        .mockRejectedValueOnce(new DOMException("first deterministic attempt aborted", "AbortError"))
        .mockRejectedValueOnce(new DOMException("second deterministic attempt aborted", "AbortError"));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      store.getState().processScan(UNKNOWN_VALID_UPC);
      await vi.advanceTimersByTimeAsync(0);

      const state = store.getState();
      const review = state.needsReviewQueue[0];
      expect(decodeRequests(fetchSpy)).toHaveLength(2);
      expect(lookupGlobalCatalog).not.toHaveBeenCalled();
      expect(review?.status).toBe("open");
      // A client-local abort is not an identity result. Keep this exact-code scan pending for
      // exact-only recovery rather than rendering Suggested or Needs Review.
      expect(review?.decodeStatus).toBe("decoding");
      expect(state.scanFeed[0]?.decodeStatus).toBe("decoding");
      expect(state.scanFeed.some((event) => event.decodeStatus === "suggested" || event.decodeStatus === "needs_review")).toBe(false);
      expect(state.needsReviewQueue.some((item) => item.decodeStatus === "suggested" || item.decodeStatus === "needs_review")).toBe(false);
      expect(state.finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recovers an exhausted exact transport cycle with a later exact hit without catalog, review, or recount", async () => {
    vi.useFakeTimers();
    try {
      const lookupGlobalCatalog = vi.fn(async () => null);
      const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
      store.getState().updateSettings({ aiLookupEnabled: false });
      const exactResponses = [
        Promise.reject(new DOMException("first deterministic attempt aborted", "AbortError")),
        Promise.reject(new DOMException("second deterministic attempt aborted", "AbortError")),
        Promise.resolve(bossTrustedExactResponse()),
      ];
      const fetchSpy = vi.fn((url: string) => {
        if (url === "/api/ai-lookup") return exactResponses.shift()!;
        return Promise.resolve({ ok: true, json: async () => ({ floor: null }) } as Response);
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      store.getState().processScan(UNKNOWN_VALID_UPC);
      // Let the initial two bounded attempts reject and schedule the recovery before advancing
      // the backoff clock. Advancing immediately would move the fake clock before this async chain
      // has installed its timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(decodeRequests(fetchSpy)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTicks();

      expect(decodeRequests(fetchSpy)).toHaveLength(3);
      expect(decodeRequests(fetchSpy).every(([, init]) => JSON.parse(String(init?.body)).deterministicOnly === true)).toBe(true);
      const state = store.getState();
      expect(lookupGlobalCatalog).not.toHaveBeenCalled();
      expect(state.needsReviewQueue.every((review) => review.status === "resolved")).toBe(true);
      expect(state.scanFeed.every((event) => event.status === "known" && event.decodeStatus === "verified")).toBe(true);
      expect(state.needsReviewQueue.some((review) => review.decodeStatus === "suggested" || review.decodeStatus === "needs_review")).toBe(false);
      expect(state.finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("settles a deferred exact response by changing identity without adding another count", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    let resolveResponse!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchSpy = vi.fn(async () => response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    store.getState().updateSettings({ aiLookupEnabled: false });

    const event = store.getState().processScan(UNKNOWN_VALID_UPC)!;
    const initialProductId = event.matchedProductId;
    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);

    resolveResponse({
      ok: true,
      json: async () => ({
        providerNames: [],
        results: [{ productName: "Exact widget", brand: "Acme", category: "tools", aliases: [], sourceUrls: [] }],
        decision: {
          status: "verified",
          confidence: 1,
          reason: "Trusted exact index match.",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          crossCheck: { decision: "agree" },
        },
      }),
    } as unknown as Response);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));

    const state = store.getState();
    expect(state.scanFeed).toHaveLength(1);
    expect(state.scanFeed[0]?.id).toBe(event.id);
    expect(state.scanFeed[0]?.createdAt).toBe(event.createdAt);
    expect(state.scanFeed[0]?.matchedProductId).not.toBe(initialProductId);
    expect(state.finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
    expect(replayLedgerCounts(state.scanFeed, state.sessionId).map((row) => ({ productId: row.productId, quantity: row.quantity }))).toEqual(
      state.finalCounts.map((row) => ({ productId: row.productId, quantity: row.quantity })),
    );
  });

  it("keeps a rapid leading-zero alias in deterministic lookup instead of Suggested", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const pending: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn((url: string) =>
      url === "/api/ai-lookup"
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : Promise.resolve({ ok: true, json: async () => ({ floor: null }) } as Response),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = store.getState().processScan(UNKNOWN_VALID_UPC)!;
    const padded = `0${UNKNOWN_VALID_UPC}`;
    const second = store.getState().processScan(padded)!;

    expect(first.decodeStatus).toBe("decoding");
    expect(second.decodeStatus).toBe("decoding");
    expect(store.getState().scanFeed.every((event) => event.decodeStatus !== "suggested")).toBe(true);
    expect(store.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(2);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    pending.forEach((resolve) => resolve(bossTrustedExactResponse()));
    await vi.waitFor(() => expect(store.getState().needsReviewQueue.every((review) => review.status === "resolved")).toBe(true));

    const state = store.getState();
    expect(state.scanFeed).toHaveLength(2);
    expect(state.scanFeed.every((event) => event.status === "known" && event.decodeStatus === "verified")).toBe(true);
    expect(state.products.filter((product) => product.trustedExactCanonicalId === "trusted-exact:00012345678905" && product.status !== "archived")).toHaveLength(1);
    expect(state.finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(2);
    expect(state.needsReviewQueue.some((review) => review.status === "open" || review.status === "suggested")).toBe(false);
  });

  it("does not continue a deterministic tire miss into background deep decode", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(deterministicMissResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providerNames: ["external-provider"],
          results: [{ productName: "High confidence external tire", brand: "Elsewhere", category: "Tire", aliases: [], sourceUrls: [] }],
          decision: { status: "verified", confidence: 1, exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
        }),
      } as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(UNKNOWN_VALID_UPC);

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.reason).toBe("No usable product was returned by the decode"));
    expect(decodeRequests(fetchSpy)).toHaveLength(1);
    expect(store.getState().needsReviewQueue[0]?.status).toBe("open");
    expect(store.getState().products.some((product) => product.name === "High confidence external tire")).toBe(false);
  });

  it.each([
    ["exact hit", deterministicExactResponse],
    ["miss", deterministicMissResponse],
  ])("keeps paid breaker, cap, and logs unchanged for a deterministic-only %s", async (_kind, response) => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setOnline(false);
    const reviewId = store.getState().reopenNeedsReview(UNKNOWN_VALID_UPC, "deterministic accounting test")!;
    store.getState().setOnline(true);
    store.setState((state) => ({
      breaker: { ...state.breaker, state: "open", openedAt: Date.now() },
      settings: { ...state.settings, dailyLookupCount: 7, lastResetDate: new Date().toISOString().slice(0, 10) },
    }));
    const before = store.getState();
    globalThis.fetch = vi.fn(async () => response()) as unknown as typeof fetch;

    await store.getState().liveDecode(reviewId, { deterministicOnly: true });

    const after = store.getState();
    expect(after.breaker).toEqual(before.breaker);
    expect(after.settings.dailyLookupCount).toBe(before.settings.dailyLookupCount);
    expect(after.aiLookupLogs).toEqual(before.aiLookupLogs);
  });
});
