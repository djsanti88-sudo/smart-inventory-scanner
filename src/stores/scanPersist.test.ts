import { describe, it, expect, afterEach } from "vitest";
import { buildPersistedScanState, persistAccessLevel, type PersistableScanState } from "@/stores/scanPersist";
import { effectiveClientAccessLevel } from "@/services/security/roleAccess";

// Sec-4 contract: a customer ("business") browser must NOT persist the reusable code database (aliases /
// catalog / shop overrides / OTHER products' codes / provider+decode traces). P1 (2026-06-22): it MUST
// still persist the customer's OWN pending Needs-Review items + scan feed (sanitized) so their unfinished
// work survives a reload. This test proves both: what survives, what is stripped.

function makeState(): PersistableScanState {
  return {
    userId: "cust-1",
    businessId: "biz-1",
    sessionId: "session-1",
    currentSession: { id: "session-1" },
    settings: { aiLookupEnabled: true },
    pendingSyncQueue: [],
    syncedScanEventIds: ["e1"],
    simulateSyncFailure: false,
    products: [
      {
        id: "prod-1", businessId: "biz-1", name: "Falken Wildpeak", brand: "Falken", category: "tire",
        specsShort: "265/70R17", primarySku: "2881-6861", primaryBarcode: "0123456789012",
        gtin: "00123456789012", upc: "123456789012", ean: "0123456789012", vendorCodes: ["X001ABCD"],
        aliases: ["2881-6861", "28816861"], imageUrl: "", location: "Bay 3", notes: "", status: "active",
      },
    ],
    aliases: [{ id: "a1", cleanCode: "2881-6861", normalizedCode: "28816861", productId: "prod-1" }],
    scanFeed: [
      { id: "s1", businessId: "biz-1", sessionId: "session-1", rawCode: "999RAW", cleanCode: "999",
        normalizedCandidates: ["999", "0999"], matchedProductId: null, matchType: "unknown", status: "needs_review",
        resolverStatus: "needs_review", codeType: "numeric_sku", reason: "Unknown code", decodeNote: "gemini said X",
        decodeStatus: "needs_review", quantityAfterScan: 0, createdAt: "t", syncStatus: "pending", syncError: "ECONNRESET secret" },
    ],
    finalCounts: [{ id: "c1", productId: "prod-1", quantity: 3, aliasesSeen: ["2881-6861", "28816861"] }],
    needsReviewQueue: [
      {
        id: "r1", businessId: "biz-1", sessionId: "session-1", rawCode: "999RAW", cleanCode: "999",
        normalizedCandidates: ["999", "0999"], suggestedProductName: "Generic Tire", suggestedBrand: "Acme",
        suggestedCategory: "tire", suggestedSpecsShort: "225/60R16", suggestedImageUrl: "", reason: "Check this",
        blockingReasons: ["incomplete_specs"], status: "open", hasSuggestion: true, decodeStatus: "suggested",
        syncStatus: "pending", createdAt: "t", idempotencyKey: "k1",
        // provider/decode internals + OTHER reusable codes that MUST be stripped for a customer:
        suggestedAliases: ["778899001122"], suggestedGtin: "00778899001122", suggestedUpc: "778899001122",
        suggestedPrimaryBarcode: "778899001122", suggestedPrimarySku: "PN-SECRET", suggestedProductUrl: "https://x",
        sourceUrls: ["https://go-upc.com/778899001122"], verifiedFacts: ["UPC 778899001122 found"],
        providerName: "gemini", confidence: 0.55, evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false,
        crossCheckDecision: "single_provider", decodeProviderSummaries: [{ provider: "gemini", productName: "x" }],
        decodeNote: "internal trace", suggestedSpecsFull: "Fits 2004 Chevrolet",
      },
    ],
    lastCleanupBackup: { removedAliases: [{ id: "a9", cleanCode: "deadbeef" }] },
    catalog: [{ id: "cat1", primaryBarcode: "0123456789012", gtin: "00123456789012" }],
    shopOverrides: [{ id: "so1", cleanCode: "555" }],
    feedbackEvents: [{ id: "f1", code: "2881-6861" }],
    countSnapshots: [],
  };
}

const FORBIDDEN_KEYS = [
  "aliases", "catalog", "shopOverrides", "lastCleanupBackup", "feedbackEvents",
  "normalizedCode", "normalizedCandidates", "primaryBarcode", "gtin", "upc", "ean", "vendorCodes",
  "rawCodeExample", "rawCode", "suggestedAliases", "suggestedGtin", "suggestedUpc",
  "suggestedPrimaryBarcode", "suggestedPrimarySku", "sourceUrls", "verifiedFacts", "providerName",
  "decodeProviderSummaries", "decodeNote", "evidenceStrength", "crossCheckDecision", "matchType", "syncError",
];

describe("buildPersistedScanState (Sec-4 customer localStorage split)", () => {
  it("customer: NO reusable code DB / provider internals reach disk (incl. inside reviews + feed)", () => {
    const blob = JSON.stringify(buildPersistedScanState(makeState(), "business"));
    for (const k of FORBIDDEN_KEYS) {
      expect(blob, `forbidden key "${k}" leaked into customer persist`).not.toContain(`"${k}"`);
    }
    // OTHER reusable code VALUES (alias/catalog/decode-discovered) are gone too.
    expect(blob).not.toContain("28816861");
    expect(blob).not.toContain("0123456789012");
    expect(blob).not.toContain("778899001122"); // decode-discovered other code
    expect(blob).not.toContain("PN-SECRET");
    expect(blob).not.toContain("ECONNRESET"); // raw sync error
    expect(blob).not.toContain("internal trace");
  });

  it("customer: pending reviews + scan feed ARE persisted (sanitized) so work survives reload (P1)", () => {
    const p = buildPersistedScanState(makeState(), "business");
    const reviews = p.needsReviewQueue as Array<Record<string, unknown>>;
    const feed = p.scanFeed as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(feed).toHaveLength(1);
    // What the customer needs to ACT on the review survives:
    expect(reviews[0]).toMatchObject({ id: "r1", cleanCode: "999", suggestedProductName: "Generic Tire", suggestedBrand: "Acme", reason: "Check this", status: "open" });
    // Their own scan feed row survives (product/qty/status) but WITHOUT the raw code: a matched feed row's
    // code->product mapping is a slice of the reusable DB and must not persist to a customer browser (Sec-4).
    expect(feed[0]).toMatchObject({ id: "s1", status: "needs_review", syncStatus: "pending" });
    expect(feed[0].cleanCode).toBeUndefined();
  });

  it("platform: full local view persisted (legacy unchanged)", () => {
    const p = buildPersistedScanState(makeState(), "platform");
    for (const key of ["aliases", "catalog", "scanFeed", "needsReviewQueue", "shopOverrides"]) expect(p).toHaveProperty(key);
    const blob = JSON.stringify(p);
    expect(blob).toContain("28816861"); // platform keeps full internal data locally
    expect(blob).toContain("778899001122"); // platform keeps decode-discovered codes
  });

  it("round-trip: 3 open customer reviews persist + rehydrate as 3 open + approvable", () => {
    const s = makeState();
    s.needsReviewQueue = ["a", "b", "c"].map((n) => ({
      id: `r-${n}`, businessId: "biz-1", sessionId: "session-1", cleanCode: `code-${n}`, rawCode: `raw-${n}`,
      suggestedProductName: `Tire ${n}`, suggestedBrand: "Acme", reason: "Check this", status: "open",
      hasSuggestion: true, decodeStatus: "suggested", syncStatus: "pending", createdAt: "t", idempotencyKey: `k-${n}`,
    }));
    const persisted = buildPersistedScanState(s, "business");
    const rehydrated = JSON.parse(JSON.stringify(persisted)).needsReviewQueue as Array<Record<string, unknown>>;
    expect(rehydrated).toHaveLength(3);
    expect(rehydrated.every((r) => r.status === "open")).toBe(true);
    // Each rehydrated review keeps the cleanCode the approved alias is keyed on (approve+count works).
    expect(rehydrated.map((r) => r.cleanCode)).toEqual(["code-a", "code-b", "code-c"]);
  });
});

// QA fix 2026-07-15 regression: the QA Task 6 local-runtime override (data-survival on the owner's own
// no-login device) MUST live ONLY on the persist seam. It was originally folded into
// effectiveClientAccessLevel - the SHARED UI role hint - which silently promoted every local UI render to
// "platform", defeating the customer role-gating + Model/name customer-sanitization guarantee
// (FinalCountTable role gating + Model-cell strip tests regressed from that). These two tests pin the
// decoupling so it cannot regress again: persist survives, UI stays customer-gated - in the SAME (unit /
// no cloud backend, no auth-bypass) runtime the FinalCountTable tests use.
describe("QA Task 6 local-runtime override is persist-only, never the UI role hint (no regression)", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_FIREBASE_BACKEND;
    delete process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
    delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
  });

  it("local runtime (no cloud backend): PERSIST resolves platform so owner data survives reload", () => {
    // no NEXT_PUBLIC_FIREBASE_BACKEND, no auth-bypass -> local owner device
    expect(persistAccessLevel(null)).toBe("platform");
    const p = buildPersistedScanState(makeState(), persistAccessLevel(null));
    expect(p).toHaveProperty("aliases"); // owner's alias DB survives
    expect(JSON.stringify(p)).toContain("0123456789012"); // product barcode survives
  });

  it("local runtime (no cloud backend): UI ROLE stays business for a non-owner identity (customer gated)", () => {
    // Same runtime as the FinalCountTable customer tests: no platform-owner flag set.
    expect(effectiveClientAccessLevel({ uid: null })).toBe("business");
    expect(effectiveClientAccessLevel({ uid: "cust-1" })).toBe("business");
    // The explicit E2E platform-owner flag still forces platform (mock Playwright specs).
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    expect(effectiveClientAccessLevel({ uid: null })).toBe("platform");
  });

  it("real cloud backend: a signed-in customer PERSISTS at business (stripped), UI role business too", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    expect(persistAccessLevel("cust-1")).toBe("business");
    expect(effectiveClientAccessLevel({ uid: "cust-1" })).toBe("business");
  });
});
