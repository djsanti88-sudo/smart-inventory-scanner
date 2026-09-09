import { describe, it, expect, afterEach } from "vitest";
import { buildPersistedScanState, persistAccessLevel, type PersistableScanState } from "@/stores/scanPersist";
import { effectiveClientAccessLevel } from "@/users-businesses/roles/roleAccess";

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
    location: "Main",
    recentLocations: [],
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
        resolverStatus: "needs_review", codeType: "numeric_sku", reason: "Unknown code", decodeNote: "provider said X",
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
        providerName: "gpt-5.4-mini", confidence: 0.55, evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false,
        crossCheckDecision: "single_provider", decodeProviderSummaries: [{ provider: "gpt-5.4-mini", productName: "x" }],
        decodeNote: "internal trace", suggestedSpecsFull: "Fits 2004 Chevrolet",
      },
    ],
    lastCleanupBackup: { removedAliases: [{ id: "a9", cleanCode: "deadbeef" }] },
    catalog: [{ id: "cat1", primaryBarcode: "0123456789012", gtin: "00123456789012" }],
    shopOverrides: [{ id: "so1", cleanCode: "555" }],
    feedbackEvents: [{ id: "f1", code: "2881-6861" }],
    countSnapshots: [],
    firstScanAt: "2026-07-20T10:00:00.000Z",
    sessionHistory: [],
  };
}

// primaryBarcode/gtin/upc/ean are NOT in this list: owner rule (2026-07-22) a product's OWN scanned
// identifier is the shop's own data (FinalCountTable.tsx:129-131) and now survives business persistence
// (see the positive assertion below). The reusable alias/catalog corpus (vendorCodes, aliases, the
// catalog array, suggested-alias/gtin/upc/barcode fields on a REVIEW - i.e. codes OTHER than the
// review's own cleanCode) stays platform-only and remains forbidden.
const FORBIDDEN_KEYS = [
  "aliases", "catalog", "shopOverrides", "lastCleanupBackup", "feedbackEvents",
  "normalizedCode", "normalizedCandidates", "vendorCodes",
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
    // OTHER reusable code VALUES (alias/catalog/decode-discovered - codes NOT this product's own scanned
    // identifier) are gone too. "28816861" only ever appears here as an ALIAS value (products[0].aliases),
    // never as this product's own primaryBarcode/gtin/upc/ean, so it stays a valid negative check.
    expect(blob).not.toContain("28816861");
    expect(blob).not.toContain("778899001122"); // decode-discovered other code
    expect(blob).not.toContain("PN-SECRET");
    expect(blob).not.toContain("ECONNRESET"); // raw sync error
    expect(blob).not.toContain("internal trace");
    // Owner rule (2026-07-22): the product's OWN scanned identifier ("0123456789012") is the shop's own
    // data (FinalCountTable.tsx:129-131) and now DOES survive - it must NOT be stripped from its product row.
    const persisted = buildPersistedScanState(makeState(), "business");
    const persistedProduct = (persisted.products as Array<Record<string, unknown>>)[0];
    expect(persistedProduct.primaryBarcode).toBe("0123456789012");
    expect(persistedProduct.gtin).toBe("00123456789012");
    expect(persistedProduct.upc).toBe("123456789012");
    expect(persistedProduct.ean).toBe("0123456789012");
    // But the reusable alias/catalog corpus fields on that same product row stay stripped.
    expect(persistedProduct.aliases).toBeUndefined();
    expect(persistedProduct.vendorCodes).toBeUndefined();
  });

  it("customer: pending reviews + scan feed ARE persisted (sanitized) so work survives reload (P1)", () => {
    const p = buildPersistedScanState(makeState(), "business");
    const reviews = p.needsReviewQueue as Array<Record<string, unknown>>;
    const feed = p.scanFeed as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(feed).toHaveLength(1);
    // What the customer needs to ACT on the review survives:
    expect(reviews[0]).toMatchObject({ id: "r1", cleanCode: "999", suggestedProductName: "Generic Tire", suggestedBrand: "Acme", reason: "Check this", status: "open" });
    // Their own scan feed row survives (product/qty/status) INCLUDING the shop's own scanned code: the
    // shop's own scan of its own barcode is the shop's own data (QA fix #15 - audit trail must not lose
    // what was physically scanned on the label after a reload). Needs Review already kept cleanCode at
    // this same access level; this makes scanFeed symmetric with it.
    expect(feed[0]).toMatchObject({ id: "s1", status: "needs_review", syncStatus: "pending", cleanCode: "999" });
    // But every OTHER reusable/decode-internal field on that same event stays stripped - the firewall
    // narrowing is exactly one field wide (cleanCode), nothing else leaked.
    expect(feed[0].rawCode).toBeUndefined();
    expect(feed[0].normalizedCandidates).toBeUndefined();
    expect(feed[0].matchType).toBeUndefined();
    expect(feed[0].decodeNote).toBeUndefined();
    expect(feed[0].syncError).toBeUndefined();
  });

  it("platform: full local view persisted (legacy unchanged)", () => {
    const p = buildPersistedScanState(makeState(), "platform");
    for (const key of ["aliases", "catalog", "scanFeed", "needsReviewQueue", "shopOverrides"]) expect(p).toHaveProperty(key);
    const blob = JSON.stringify(p);
    expect(blob).toContain("28816861"); // platform keeps full internal data locally
    expect(blob).toContain("778899001122"); // platform keeps decode-discovered codes
  });

  it("caps ONLY the append-only diagnostic arrays (syncedScanEventIds, feedbackEvents), never customer data (#16)", () => {
    // Finding #16 mitigation (c): the persisted blob grew unbounded because append-only diagnostic
    // ledgers were serialized in full on every scan. Cap them to a bounded ring (newest kept), the
    // same way countSnapshots/feedback already cap. CUSTOMER DATA (scanFeed / finalCounts /
    // needsReviewQueue / pendingSyncQueue) must NEVER be capped - that would lose counts / unfinished
    // review work / unsynced writes (TOP-LEVEL LAW).
    const s = makeState();
    s.syncedScanEventIds = Array.from({ length: 5000 }, (_, i) => `e-${i}`);
    s.feedbackEvents = Array.from({ length: 5000 }, (_, i) => ({ id: `f-${i}`, code: `${i}` }));
    // Large customer data that must survive uncapped:
    s.scanFeed = Array.from({ length: 3000 }, (_, i) => ({ id: `s-${i}`, status: "counted", syncStatus: "synced", cleanCode: `${i}` }));
    s.finalCounts = Array.from({ length: 3000 }, (_, i) => ({ id: `c-${i}`, productId: `p-${i}`, quantity: 1, aliasesSeen: [] }));
    s.needsReviewQueue = Array.from({ length: 400 }, (_, i) => ({ id: `r-${i}`, cleanCode: `${i}`, reason: "x", status: "open", createdAt: "t", idempotencyKey: `k-${i}` }));
    s.pendingSyncQueue = Array.from({ length: 400 }, (_, i) => ({ id: `q-${i}`, status: "pending" }));

    // Platform level exercises the full (unstripped) view - diagnostic arrays present there too.
    const p = buildPersistedScanState(s, "platform");

    // Diagnostic ledgers are bounded and keep the NEWEST entries.
    const synced = p.syncedScanEventIds as string[];
    const feedback = p.feedbackEvents as Array<Record<string, unknown>>;
    expect(synced.length).toBeLessThanOrEqual(1000);
    expect(synced[synced.length - 1]).toBe("e-4999"); // newest retained
    expect(feedback.length).toBeLessThanOrEqual(500);
    expect((feedback[feedback.length - 1] as { id: string }).id).toBe("f-4999");

    // Customer data is NOT capped - every row survives.
    expect((p.scanFeed as unknown[]).length).toBe(3000);
    expect((p.finalCounts as unknown[]).length).toBe(3000);
    expect((p.needsReviewQueue as unknown[]).length).toBe(400);
    expect((p.pendingSyncQueue as unknown[]).length).toBe(400);
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

  it("persists location and recentLocations for customer-role reloads", () => {
    const s = makeState();
    s.location = "Bay A";
    s.recentLocations = ["Main", "Bay A"];
    const persisted = buildPersistedScanState(s, "business");
    expect(persisted).toMatchObject({ location: "Bay A", recentLocations: ["Main", "Bay A"] });
  });

  it("customer: persisted feed retains location but not attribution-only deviceId", () => {
    const s = makeState();
    const first = s.scanFeed[0] as Record<string, unknown>;
    s.scanFeed = [{ ...first, location: "Bay A", deviceId: "device-a" }];
    const persisted = buildPersistedScanState(s, "business");
    const feed = persisted.scanFeed as Array<Record<string, unknown>>;
    expect(feed[0].location).toBe("Bay A");
    expect(feed[0].deviceId).toBeUndefined();
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
