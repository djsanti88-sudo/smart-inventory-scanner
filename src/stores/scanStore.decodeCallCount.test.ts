import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// TASK T6 (2026-08-06, audit-6 finding 5, live-observed): a scan that is already SETTLED by the
// deterministic-only trusted-exact probe was still firing a second, ordinary /api/ai-lookup POST -
// ~2 requests per scan for a corpus-verified code, wasteful double network round trips (both free
// rungs, so no paid burn, but pure latency/load waste). Root cause: the client's post-probe settle
// check only recognizes the PRIVATE boss-authenticated trusted-exact corpus hit (which carries an
// opaque trustedExactCanonicalProductId + "boss_trusted_exact_barcode" path). A "global_corpus"
// trusted-exact hit is ALSO a genuine, already-verified, exact-code-evidenced identity (see
// TireKnowledgeProvider.ts's resolveTrustedExactBarcodeDecision - it deliberately omits the canonical
// id for sourceScope "global_corpus"), but the client was treating that as an ordinary "miss" and
// unconditionally firing the owner-ratified miss-continuation into a second, full decode call - which
// then re-hits the exact-same server-side corpus check a second time and re-verifies the identical
// answer. The fix reuses the probe's own verified response instead of discarding and re-fetching it.

const originalFetch = globalThis.fetch;

function decodeCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/ai-lookup");
}

/** A genuinely verified, exact-code-evidenced corpus hit that is NOT the private boss corpus (no
 *  trustedExactCanonicalProductId, corroborationPath/trustedExact.path are the plain non-boss values) -
 *  exactly what resolveTrustedExactBarcodeDecision returns for sourceScope "global_corpus". */
function globalCorpusVerifiedResponse(code: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      mode: "decode",
      providerNames: ["tire-corpus"],
      results: [{
        productName: "Certified tire",
        brand: "Blackhawk",
        category: "Tire",
        specsShort: "235/60R18",
        primarySku: "BH-2356018",
        primaryBarcode: code,
        gtin: "",
        upc: "",
        ean: "",
        confidence: 1,
      }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "corpus_exact_barcode",
        crossCheck: { decision: "single_provider", confidence: 1, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
      },
      // NOT "boss_trusted_exact_barcode" - the plain global-corpus path, so the client's strict
      // boss-canonical-id settle check (trustedExactCanonicalId) legitimately returns null for this.
      trustedExact: { path: "corpus_exact_barcode" },
    }),
  } as Response;
}

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

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
});

describe("decode dispatch call count (audit-6 finding 5)", () => {
  it("a scan settled by a non-boss trusted-exact corpus hit fires exactly ONE /api/ai-lookup POST total", async () => {
    const code = "036000291452";
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const fetchSpy = vi.fn(async () => globalCorpusVerifiedResponse(code));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(code);

    await vi.waitFor(() => {
      const badge = store.getState().scanFeed[0]?.decodeStatus;
      expect(badge === "verified" || badge === "suggested").toBe(true);
    });
    // Give any (wrongly) fired second dispatch a chance to land before asserting the final count.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(decodeCalls(fetchSpy)).toHaveLength(1);
    expect(JSON.parse(String(decodeCalls(fetchSpy)[0]?.[1]?.body))).toMatchObject({
      deterministicOnly: true,
      cleanCode: code,
    });
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("a genuine trusted-exact miss still continues into exactly ONE ordinary follow-up (2 total)", async () => {
    const code = "036000291452";
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const fetchSpy = vi.fn(async () => missResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(code);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(2));
    const bodies = decodeCalls(fetchSpy).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.deterministicOnly)).toEqual([true, false]);
    // Settle time for any further (unwanted) dispatch before the final assertion.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decodeCalls(fetchSpy)).toHaveLength(2);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });
});
