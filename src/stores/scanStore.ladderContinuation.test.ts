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
    geminiConfigured: true,
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
    expect(JSON.parse(String(decodeCalls(fetchSpy)[1]?.[1]?.body))).not.toMatchObject({ deterministicOnly: true });

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
});
