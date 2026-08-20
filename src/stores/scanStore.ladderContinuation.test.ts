import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

const NON_GTIN_CODE = "3220015959";
const originalFetch = globalThis.fetch;

function missResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      mode: "decode",
      providerNames: [],
      results: [],
      decision: {
        status: "needs_review",
        confidence: 0,
        reason: "No trusted exact match was found.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "not_checked" },
      },
      trustedExact: { path: "trusted_exact_miss" },
    }),
  } as Response;
}

function verifiedResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      mode: "decode",
      providerNames: ["tire-corpus"],
      results: [{
        productName: "Ladder follow-up tire",
        brand: "Blackhawk",
        category: "Tire",
        specsShort: "235/60R18",
        primarySku: "BH-2356018",
        primaryBarcode: NON_GTIN_CODE,
        gtin: "",
        upc: "",
        ean: "",
        confidence: 1,
      }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Authenticated trusted exact corpus match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: `trusted-exact:v1:${"C".repeat(32)}`,
        crossCheck: { decision: "single_provider" },
      },
      trustedExact: { path: "boss_trusted_exact_barcode", index: { schemaVersion: "1.0.0", contentDigest: "D".repeat(64) } },
    }),
  } as Response;
}

function decodeCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/ai-lookup");
}

function configureTrustedExactStore() {
  const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
  store.getState().updateSettings({ aiLookupEnabled: true });
  store.getState().setAiStatus({
    openaiConfigured: true,
    freeDecodeAvailable: true,
    missingKeys: [],
  });
  return store;
}

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
});

describe("trusted-exact ladder continuation", () => {
  it("continues a trusted-exact miss on a non-GTIN code into the ordinary ladder", async () => {
    const store = configureTrustedExactStore();
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      return body.deterministicOnly ? missResponse() : pending;
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(2));
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("decoding");
    const continuationBody = JSON.parse(String(decodeCalls(fetchSpy)[1]?.[1]?.body)) as {
      deterministicOnly?: boolean;
      rawCode?: string;
      cleanCode?: string;
    };
    expect(continuationBody).not.toMatchObject({ deterministicOnly: true });
    // Fix-wave 2026-08-04: a bare separator-free 8-14 digit scan code must reach the server as real
    // digits, not the phone sanitizer's "[redacted-phone]" placeholder (sanitizer.ts PHONE pattern
    // masks bare 10-digit runs). Mirrors route.ts's own bareNumericCode carve-out client-side.
    expect(continuationBody.cleanCode).toBe(NON_GTIN_CODE);
    expect(continuationBody.rawCode).toBe(NON_GTIN_CODE);
    expect(continuationBody.cleanCode).not.toBe("[redacted-phone]");

    release!(verifiedResponse());
    await vi.waitFor(() => expect(store.getState().scanFeed[0]?.decodeStatus).toBe("verified"));
  });

  it("does not continue a trusted-exact miss when offline and explains why", async () => {
    const store = configureTrustedExactStore();
    let resolveMiss!: (value: Response) => void;
    const missPending = new Promise<Response>((resolve) => {
      resolveMiss = resolve;
    });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      if (body.deterministicOnly) return missPending;
      throw new Error("follow-up decode should not fire while offline");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(1));
    store.setState((state) => ({ ...state, online: false }));
    resolveMiss!(missResponse());
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));
    const reason = store.getState().needsReviewQueue[0]?.reason ?? "";
    expect(reason).toMatch(/No trusted exact match was found/i);
    expect(reason).toMatch(/decode did not continue/i);
    expect(reason.toLowerCase()).toMatch(/offline/);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(1);
  });

  it.each([
    ["continues", true, 2],
    ["blocks offline", false, 1],
  ])("keeps the counted scan and feed row intact when the trusted-exact miss %s", async (_label, online) => {
    const store = configureTrustedExactStore();
    store.setState((state) => ({ ...state, online: true }));
    let release!: (value: Response) => void;
    let resolveMiss!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const missPending = new Promise<Response>((resolve) => {
      resolveMiss = resolve;
    });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      if (body.deterministicOnly) return missPending;
      return online ? pending : missResponse();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(1));
    if (online) {
      resolveMiss!(missResponse());
      release!(verifiedResponse());
    } else {
      store.setState((state) => ({ ...state, online: false }));
      resolveMiss!(missResponse());
    }
    expect(decodeCalls(fetchSpy)).toHaveLength(1);
    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("resolves the row honestly instead of stalling when the daily AI cap is genuinely spent during continuation", async () => {
    const store = configureTrustedExactStore();
    // createTestScanStore pins now() to 2026-06-12T10:00:00.000Z (scanStore.ts createTestScanStore), so
    // lastResetDate "2026-06-12" is "today" on that clock - this is the genuine cap-hit-after-usage
    // branch, not the silently-reset default. The continuation gate forces dailyCount to 0 (cap math is
    // server-side) so the handoff into the ordinary ladder is allowed, but the ordinary ladder's OWN
    // pre-existing gate (evaluateAiGate, using the REAL dailyCount) must then genuinely block the
    // follow-up call - the reviewer-proven silent stall.
    store.setState((state) => ({
      ...state,
      online: true,
      settings: { ...state.settings, dailyLookupCount: 1, dailyLookupLimit: 1, lastResetDate: "2026-06-12" },
    }));
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      if (body.deterministicOnly) return missResponse();
      throw new Error("follow-up decode must never fire once the daily cap gate blocks it");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    // Exactly one fetch total: the free trusted-exact probe. The follow-up call is blocked at the
    // ordinary gate before ever reaching fetch, so it must never add a second call.
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));
    await vi.waitFor(() => expect(store.getState().scanFeed[0]?.decodeStatus).toBe("needs_review"));
    expect(decodeCalls(fetchSpy)).toHaveLength(1);

    const reviewReason = store.getState().needsReviewQueue[0]?.reason ?? "";
    const feedReason = store.getState().scanFeed[0]?.reason ?? "";
    expect(reviewReason.toLowerCase()).toMatch(/daily ai lookup cap/);
    expect(feedReason.toLowerCase()).toMatch(/daily ai lookup cap/);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    // Fix-wave 2026-08-04: the log entry for a genuine daily-cap block must say "blocked_cap", not
    // a generic label shared with a disabled-AI or open-circuit-breaker block.
    expect(store.getState().aiLookupLogs[0]?.status).toBe("blocked_cap");
  });

  it("labels the inner-gate block honestly as blocked_disabled when AI lookup is turned off, not blocked_cap", async () => {
    // Deliberately a PLAIN store (no trusted-exact probe involved) - this is the same shared inner
    // gate (evaluateAiGate at the top of runLiveDecodeOnce) that every decode call goes through, so
    // it is exercised directly here rather than through the trusted-exact continuation's own outer
    // gate (evaluateAutoDecode), which already blocks on a disabled aiLookupEnabled BEFORE ever
    // calling liveDecode - the only way to deterministically reach the INNER gate's own "disabled"
    // branch is to call runLiveDecodeOnce directly, after seeding a real needsReviewQueue row.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setAiStatus({
      openaiConfigured: true,
      freeDecodeAvailable: true,
      missingKeys: [],
      autoDecodeOnScan: false, // keep processScan from auto-firing decode so the row is seeded, not resolved
    });
    store.setState((state) => ({ ...state, online: true }));
    const fetchSpy = vi.fn(async () => {
      throw new Error("decode fetch must never fire once the inner gate blocks it");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);
    const reviewId = store.getState().needsReviewQueue[0]?.id;
    expect(reviewId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled(); // autoDecodeOnScan:false kept this from auto-firing

    store.getState().updateSettings({ aiLookupEnabled: false });
    await store.getState().runLiveDecodeOnce(reviewId!);

    expect(fetchSpy).not.toHaveBeenCalled();
    const reviewReason = store.getState().needsReviewQueue[0]?.reason ?? "";
    expect(reviewReason.toLowerCase()).toMatch(/ai lookup is off/);
    expect(store.getState().aiLookupLogs[0]?.status).toBe("blocked_disabled");
  });
});
