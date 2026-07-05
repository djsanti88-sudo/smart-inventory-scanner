import { describe, it, expect } from "vitest";
import { scanStoreMigrate } from "@/stores/scanStore";
import type { Product } from "@/types";

// Task 4 review fix: no unit test exercised the persist migrate() step directly - only end-to-end
// via the full zustand persist/localStorage machinery. This builds a realistic v5 persisted-state
// fixture and calls scanStoreMigrate(state, 5) directly (the >=5 branch: additive backfill, never a
// reset - see the migrate function's own comments in scanStore.ts) to prove every non-product field
// survives byte-for-byte and a human-locked product row is left completely untouched.

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "b1", name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

describe("scanStoreMigrate - v5 -> v6 persist migration (Task 4 review fix)", () => {
  it("preserves every listed session/sync field byte-for-byte and only adds structured fields to non-human products", () => {
    const humanProduct = product({
      id: "p-human",
      name: "Cooper Discoverer AT3 265/70R17",
      brand: "Cooper",
      structuredBy: "human",
      structuredBrand: "Cooper Tires Corrected",
      structuredModel: "Custom Model Human Edited",
    });
    const plainProduct = product({
      id: "p-plain",
      name: "Michelin Defender 225/45R17",
      brand: "Michelin",
      // no structured fields yet - this is the pre-Task-4 shape a real v5 install would have.
    });

    const aliases = [
      {
        id: "a1", businessId: "b1", productId: "p-plain", rawCodeExample: "049000028904",
        cleanCode: "049000028904", normalizedCode: "049000028904", aliasType: "upc", source: "seed",
        confidence: 1, approved: true, createdAt: "t", updatedAt: "t", createdBy: "seed",
        lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k1",
      },
    ];
    const scanFeed = [
      {
        id: "se1", businessId: "b1", sessionId: "s1", rawCode: "049000028904", cleanCode: "049000028904",
        normalizedCandidates: ["049000028904"], matchedProductId: "p-plain", matchType: "upc",
        status: "known", resolverStatus: "known", codeType: "upc", reason: "matched",
        quantityDelta: 1, quantityAfterScan: 1, createdAt: "t", source: "scan", notes: "",
        syncStatus: "synced", syncError: null, idempotencyKey: "k2",
      },
    ];
    const finalCounts = [
      {
        id: "c1", businessId: "b1", sessionId: "s1", productId: "p-plain", quantity: 1,
        lastScannedAt: "t", aliasesSeen: ["049000028904"], scanEventIds: ["se1"],
        createdAt: "t", updatedAt: "t", syncStatus: "synced", syncError: null,
        appliedIdempotencyKeys: ["k2"],
      },
    ];
    const needsReviewQueue = [
      {
        id: "r1", businessId: "b1", sessionId: "s1", rawCode: "UNKNOWN1", cleanCode: "UNKNOWN1",
        normalizedCandidates: ["UNKNOWN1"], suggestedProductName: "", suggestedBrand: "",
        suggestedCategory: "", suggestedSpecsShort: "", suggestedSpecsFull: "", suggestedPrimarySku: "",
        suggestedPrimaryBarcode: "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
        suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [],
        verifiedFacts: [], guesses: [], reason: "unknown code", providerName: "", confidence: 0,
        hasSuggestion: false, decodeStatus: "needs_review", evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "weak", status: "open",
        createdAt: "t", resolvedAt: null, resolvedBy: null, resolutionAction: null,
        syncStatus: "synced", idempotencyKey: "k3",
      },
    ];
    const pendingSyncQueue = [
      {
        id: "ps1", businessId: "b1", sessionId: "s1", entityType: "ScanEvent", entityId: "se1",
        operation: "create", payload: { foo: "bar" }, status: "pending", retryCount: 0,
        lastError: null, createdAt: "t", updatedAt: "t", idempotencyKey: "k2", scanEventId: "se1",
      },
    ];
    const syncedScanEventIds = ["se1"];

    const persistedV5 = {
      businessId: "b1",
      products: [humanProduct, plainProduct],
      aliases,
      scanFeed,
      finalCounts,
      needsReviewQueue,
      pendingSyncQueue,
      syncedScanEventIds,
      settings: { aiLookupEnabled: true },
    };

    const migrated = scanStoreMigrate(persistedV5, 5) as unknown as typeof persistedV5 & { products: Product[] };

    // Every listed field survives byte-equal.
    expect(migrated.aliases).toEqual(aliases);
    expect(migrated.scanFeed).toEqual(scanFeed);
    expect(migrated.finalCounts).toEqual(finalCounts);
    expect(migrated.needsReviewQueue).toEqual(needsReviewQueue);
    expect(migrated.pendingSyncQueue).toEqual(pendingSyncQueue);
    expect(migrated.syncedScanEventIds).toEqual(syncedScanEventIds);
    expect(migrated.businessId).toBe("b1");

    // The human-stamped row is completely untouched (byte-for-byte).
    const migratedHuman = migrated.products.find((p) => p.id === "p-human");
    expect(migratedHuman).toEqual(humanProduct);

    // The plain row gains structured fields (the whole point of the v5->v6 backfill).
    const migratedPlain = migrated.products.find((p) => p.id === "p-plain");
    expect(migratedPlain?.structuredBrand).toBe("Michelin");
    expect(migratedPlain?.structuredBy).toBe("deterministic");
  });

  it("does NOT reset products/aliases/session state for a v5 install (only < v5 installs get the poison-cleanup reset)", () => {
    const plainProduct = product({ id: "p-only", name: "Falken Wildpeak AT3W 225/45R17", brand: "Falken" });
    const persistedV5 = {
      products: [plainProduct],
      aliases: [{ id: "keep-me" }],
      scanFeed: [{ id: "keep-feed" }],
      finalCounts: [{ id: "keep-count" }],
      needsReviewQueue: [{ id: "keep-review" }],
      pendingSyncQueue: [{ id: "keep-sync" }],
      syncedScanEventIds: ["keep-synced-id"],
    };

    const migrated = scanStoreMigrate(persistedV5, 5) as unknown as typeof persistedV5;

    expect(migrated.aliases).toEqual(persistedV5.aliases);
    expect(migrated.scanFeed).toEqual(persistedV5.scanFeed);
    expect(migrated.finalCounts).toEqual(persistedV5.finalCounts);
    expect(migrated.needsReviewQueue).toEqual(persistedV5.needsReviewQueue);
    expect(migrated.pendingSyncQueue).toEqual(persistedV5.pendingSyncQueue);
    expect(migrated.syncedScanEventIds).toEqual(persistedV5.syncedScanEventIds);
  });
});
