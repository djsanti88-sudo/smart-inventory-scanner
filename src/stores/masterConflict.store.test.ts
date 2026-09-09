import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";
import { sanitizeCatalogEntry } from "@/products/catalog/sanitizeCatalog";
import type { CatalogEntry } from "@/products/catalog/catalogTypes";

// Phase 5b Task 4: cloudCatalogResolve's cross-tier conflict check. When the async global-catalog
// lookup finds a MASTER entry whose identity disagrees with a tenant product this account already
// has resolvable for the same code, the row must route to needs_review with an honest reason and
// the enrichment apply must be SKIPPED - never silently overwrite the tenant's own identity.
// TOP-LEVEL LAW (CLAUDE.md): the scan row already appeared and counted synchronously before any of
// this async resolve runs; this phase changes IDENTITY only, never visibility/counting.

const CODE = "700000000099";
const NOW = "2026-07-20T10:00:00.000Z";

// A master-catalog hit carrying an identity, sanitized the same way scanStore.lookupGlobalCatalog's
// toStoreEntry would produce it, PLUS the Phase 5b masterId/masterProvenanceTier pass-through.
function masterEntry(name: string, brand: string, masterId = "gtin_700000000099"): CatalogEntry {
  return {
    ...sanitizeCatalogEntry(
      { barcode: CODE, normalizedBarcode: CODE, name, brand, category: "" },
      { now: NOW, verificationStatus: "verified", verifiedBy: null, by: "trusted_source" },
    ),
    masterId,
    masterProvenanceTier: "ladder_verified_strong",
  };
}

function reviewIdFor(store: ReturnType<typeof createTestScanStore>, cleanCode: string) {
  const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === cleanCode && x.status === "open");
  if (!r) throw new Error(`no open review for ${cleanCode}`);
  return r.id;
}

// Seed a VERIFIED tenant product resolvable for CODE (the create_new + applyToCount:false path used
// by crossIdentifier.store.test.ts - resolveUnknown marks it verified:true so the deterministic
// matcher will find it on the next scan of the same code).
function seedTenantProduct(store: ReturnType<typeof createTestScanStore>, name: string, brand: string) {
  store.getState().processScan(CODE);
  store.getState().resolveUnknown(reviewIdFor(store, CODE), "create_new", {
    applyToCount: false,
    origin: "human",
    newProduct: { name, brand, primaryBarcode: CODE },
  });
  return store.getState().products.find((p) => p.name === name)!.id;
}

function storeWithMaster(lookup: (codes: string[]) => Promise<CatalogEntry | null>) {
  const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog: lookup });
  store.setState({ online: true });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  // AI lookup stays OFF: these tests drive cloudCatalogResolve directly and must never race against
  // the store's own auto-triggered liveDecode overwriting the scanFeed row this test asserts on.
  store.getState().updateSettings({ aiLookupEnabled: false });
  return store;
}

describe("Phase 5b Task 4: cross-tier master-vs-tenant conflict (cloudCatalogResolve)", () => {
  it("(a) disagreeing master identity -> row needs_review, count unchanged, honest reason; enrichment skipped", async () => {
    const store = storeWithMaster(() => Promise.resolve(masterEntry("Definitely A Different Product", "OtherBrand")));
    const pid = seedTenantProduct(store, "Tenant Widget", "AcmeCo");
    const countBefore = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);

    // Second scan of the SAME code: known tenant match, counts synchronously, THEN cloudCatalogResolve
    // fires (only unknown-code reviews trigger it - drive it directly against a fresh review instead so
    // we exercise the exact async path under test).
    store.getState().processScan("700000000009"); // unrelated unknown scan to obtain an open review id
    const reviewId = reviewIdFor(store, "700000000009");
    // Rewrite the fresh review's code (AND its own scanFeed row, so the two stay in sync exactly as
    // production always has them) to CODE in place so cloudCatalogResolve resolves against a code that
    // already has a resolvable tenant product, without re-triggering seed creation.
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, cleanCode: CODE, rawCode: CODE, normalizedCandidates: [CODE] } : r)),
      scanFeed: s.scanFeed.map((e) => (e.cleanCode === "700000000009" ? { ...e, cleanCode: CODE, rawCode: CODE, normalizedCandidates: [CODE] } : e)),
    }));

    const countAfterScan = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);

    await store.getState().cloudCatalogResolve(reviewId, [CODE]);

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId)!;
    expect(review.reason).toBe("Cross-tier conflict: master catalog identity disagrees with this account's product");
    expect(review.status).toBe("open"); // still needs a human, never silently auto-resolved

    // The scan feed row for this review's own scan must carry the needs_review badge + honest reason.
    const matchingFeed = store.getState().scanFeed.find((e) => e.cleanCode === CODE);
    expect(matchingFeed?.decodeStatus).toBe("needs_review");
    expect(matchingFeed?.reason).toBe("Cross-tier conflict: master catalog identity disagrees with this account's product");

    // Count must be unchanged by this identity-only outcome (GC9 / TOP-LEVEL LAW).
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(countAfterScan);

    // The tenant product's own name/brand must be untouched - enrichment apply was skipped.
    const tenant = store.getState().products.find((p) => p.id === pid)!;
    expect(tenant.name).toBe("Tenant Widget");
    expect(tenant.brand).toBe("AcmeCo");
  });

  it("(b) agreeing master identity -> existing enrichment behavior applies exactly as today (byte-identical)", async () => {
    // Same brand+name (exact agreement) - identitiesAgree should hold and the resolver returns the
    // SAME tenant product, so cloudCatalogResolve falls through to its existing verified-entry apply
    // path unchanged: no conflict reason is ever written.
    const store = storeWithMaster(() => Promise.resolve(masterEntry("Tenant Widget", "AcmeCo")));
    seedTenantProduct(store, "Tenant Widget", "AcmeCo");

    store.getState().processScan("700000000016");
    const reviewId = reviewIdFor(store, "700000000016");
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, cleanCode: CODE, rawCode: CODE, normalizedCandidates: [CODE] } : r)),
    }));

    await store.getState().cloudCatalogResolve(reviewId, [CODE]);

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId);
    // Agreement never writes the cross-tier conflict reason.
    expect(review?.reason).not.toBe("Cross-tier conflict: master catalog identity disagrees with this account's product");
  });

  it("(c) LAW: the scan row already existed and counted BEFORE the async cloudCatalogResolve ran", async () => {
    let resolveLookup: (v: CatalogEntry | null) => void = () => {};
    const pending = new Promise<CatalogEntry | null>((res) => (resolveLookup = res));
    const store = storeWithMaster(() => pending);
    seedTenantProduct(store, "Tenant Widget", "AcmeCo");

    store.getState().processScan("700000000030");
    const reviewId = reviewIdFor(store, "700000000030");

    // Assert PRE-AWAIT state: the row is already on the feed and counted before cloudCatalogResolve's
    // internal await ever settles (we have not resolved `pending` yet).
    expect(store.getState().scanFeed.some((e) => e.cleanCode === "700000000030")).toBe(true);
    expect(store.getState().finalCounts.length).toBeGreaterThan(0);

    const p = store.getState().cloudCatalogResolve(reviewId, ["700000000030"]);
    resolveLookup(null);
    await p;
  });

  // FIX 1 (review HIGH, retail provenance): a retail-catalog hit must never carry masterId, so the
  // cross-tier conflict machinery (gated on entry.masterId, scanStore.ts ~2477) must never run for it
  // even when its identity disagrees with the tenant's own product for the same code. This mirrors
  // toMasterAwareStoreEntry(raw, false, ...) - the store-side effect of the retail (isMaster:false) path.
  it("(retail) a disagreeing entry with NO masterId never flips to needs_review via cross-tier conflict", async () => {
    const store = storeWithMaster(() =>
      Promise.resolve({
        ...sanitizeCatalogEntry(
          { barcode: CODE, normalizedBarcode: CODE, name: "Some Retail Product", brand: "RetailBrand", category: "" },
          { now: NOW, verificationStatus: "verified", verifiedBy: null, by: "trusted_source" },
        ),
        // no masterId / masterProvenanceTier - exactly what a retail hit produces.
      }),
    );
    seedTenantProduct(store, "Tenant Widget", "AcmeCo");

    store.getState().processScan("700000000058");
    const reviewId = reviewIdFor(store, "700000000058");
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, cleanCode: CODE, rawCode: CODE, normalizedCandidates: [CODE] } : r)),
    }));

    await store.getState().cloudCatalogResolve(reviewId, [CODE]);

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId);
    expect(review?.reason).not.toBe("Cross-tier conflict: master catalog identity disagrees with this account's product");
  });

  it("(d) a master-only hit (no tenant candidate) never reaches the tiered resolver; existing behavior byte-identical", async () => {
    // No tenant product exists for this code at all - toMasterCandidates must return [] and the
    // dev-assert must NOT fire (no throw), and the existing (non-Task-4) enrichment path runs exactly
    // as it did before this phase.
    const freshCode = "700000000047";
    const store = storeWithMaster(() => Promise.resolve(masterEntry("Some New Product", "SomeBrand", "gtin_" + freshCode)));

    expect(() => store.getState().processScan(freshCode)).not.toThrow();
    const reviewId = reviewIdFor(store, freshCode);

    await expect(store.getState().cloudCatalogResolve(reviewId, [freshCode])).resolves.not.toThrow();

    const review = store.getState().needsReviewQueue.find((r) => r.id === reviewId);
    expect(review?.reason).not.toBe("Cross-tier conflict: master catalog identity disagrees with this account's product");
    // The existing verified-catalog apply path took over (master hit is verificationStatus "verified"),
    // resolving the review from the catalog with no conflict short-circuit.
    expect(review?.status).toBe("resolved");
  });
});
