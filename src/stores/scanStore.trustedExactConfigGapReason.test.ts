import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { MISS_REASON_TEXT } from "@/services/ai/decodeFallback";

// TASK T3 (2026-08-06, audit-9 finding B): when the trusted-exact probe reports reasonCode
// "trusted_exact_not_available" (server allowlist not configured / this business is not in it) and
// the ladder continuation that follows then ALSO misses everywhere, the row must not collapse to the
// generic "No match found in the databases or open web" text - that text is indistinguishable from a
// code that genuinely does not exist anywhere. It must instead name the real, fixable cause.

const NON_GTIN_CODE = "3220015959";
const originalFetch = globalThis.fetch;

function configGapProbeResponse(): Response {
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
        reason: "Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "not_checked" },
      },
      reasonCode: "trusted_exact_not_available",
      reasonText: "Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.",
      trustedExact: { path: "trusted_exact_not_checked" },
    }),
  } as Response;
}

function genuineMissProbeResponse(): Response {
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
      reasonCode: "trusted_exact_miss",
      reasonText: "No trusted exact match was found.",
      trustedExact: { path: "trusted_exact_miss" },
    }),
  } as Response;
}

function ladderAllMissResponse(): Response {
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
        reason: MISS_REASON_TEXT.product_not_found,
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "not_checked" },
      },
      reasonCode: "no_result",
      reasonText: MISS_REASON_TEXT.product_not_found,
      timedOut: false,
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
  store.setState((state) => ({ ...state, online: true }));
  return store;
}

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
});

describe("trusted-exact config-gap reason honesty", () => {
  it("names the config gap when the probe was not-available and the continuation ladder all-misses", async () => {
    const store = configureTrustedExactStore();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      return body.deterministicOnly ? configGapProbeResponse() : ladderAllMissResponse();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(2));
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));

    const reviewReason = store.getState().needsReviewQueue[0]?.reason ?? "";
    const feedReason = store.getState().scanFeed[0]?.reason ?? "";

    // THE FIX: the generic all-miss bucket text must NOT be shown verbatim - it collapses a
    // config gap and a genuine "nowhere to be found" miss into the same indistinguishable string.
    expect(reviewReason).not.toBe(MISS_REASON_TEXT.product_not_found);
    expect(feedReason).not.toBe(MISS_REASON_TEXT.product_not_found);
    // Honest, specific, customer-safe copy naming the real cause.
    expect(reviewReason).toBe(
      "Trusted exact lookup is not enabled for this business, and no match was found in the databases. Saved to Needs Review.",
    );
    expect(feedReason).toBe(
      "Trusted exact lookup is not enabled for this business, and no match was found in the databases. Saved to Needs Review.",
    );
    // Every scan still counts (TOP-LEVEL LAW), regardless of identity outcome.
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(1);
  });

  it("control: keeps the plain all-miss text unchanged when the probe was a genuine trusted-exact miss", async () => {
    const store = configureTrustedExactStore();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deterministicOnly?: boolean };
      return body.deterministicOnly ? genuineMissProbeResponse() : ladderAllMissResponse();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(NON_GTIN_CODE);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(2));
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));

    const reviewReason = store.getState().needsReviewQueue[0]?.reason ?? "";
    const feedReason = store.getState().scanFeed[0]?.reason ?? "";

    // A real trusted-exact miss (checked, and genuinely absent) followed by a genuine ladder
    // all-miss is a TRUE "not found anywhere" - the plain generic text stays honest and unchanged.
    expect(reviewReason).toBe(MISS_REASON_TEXT.product_not_found);
    expect(feedReason).toBe(MISS_REASON_TEXT.product_not_found);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(1);
  });
});
