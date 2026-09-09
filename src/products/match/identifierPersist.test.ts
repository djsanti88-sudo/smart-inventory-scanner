import { describe, it, expect } from "vitest";
import { sanitizeProduct } from "@/shared/privacy/serializers";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { matchProductByIdentifiers } from "@/products/match/aliasMatcher";
import type { CleanedCode, Product } from "@/types";

// Owner rule (2026-07-22, encoded in src/inventory/FinalCountTable.tsx:129-131): the barcode a shop
// scanned onto THEIR OWN product row is THEIR data - already rendered to every role in the UI - so
// stripping it from that same device's own localStorage persistence protects nothing and instead
// destroys the shop's own data (the Products/Counts "Barcode" column showed "-" after any reload for a
// "business"-level session). This test proves the fix: a product's own primaryBarcode/gtin/upc/ean
// survive sanitizeProduct at "business" level and a real persist round-trip.
//
// This does NOT reopen the reusable alias/catalog corpus: aliases, vendorCodes, and the master catalog
// stay platform-only (proven by the unchanged assertions in security.test.ts / scanPersist.test.ts).

describe("identifier fields survive customer ('business') persistence (2026-07-22)", () => {
  const product = {
    id: "p1", name: "Falken", brand: "Falken", category: "Tire", specsShort: "215/70R15",
    primarySku: "28816861", primaryBarcode: "848983012906", gtin: "848983012906", upc: "123", ean: "456",
    aliases: ["28816861", "2881-6861"], vendorCodes: ["x"], imageUrl: "", location: "Bay A", notes: "", status: "active",
  };

  it("sanitizeProduct(product, 'business') preserves primaryBarcode/gtin/upc/ean", () => {
    const p = sanitizeProduct(product, "business") as Record<string, unknown>;
    expect(p.primaryBarcode).toBe("848983012906");
    expect(p.gtin).toBe("848983012906");
    expect(p.upc).toBe("123");
    expect(p.ean).toBe("456");
    // Reusable alias/catalog data must still be stripped - only the product's OWN identifier fields open up.
    expect("aliases" in p).toBe(false);
    expect("vendorCodes" in p).toBe(false);
  });

  function makeState(): PersistableScanState {
    return {
      userId: "cust-1", businessId: "biz-1", sessionId: "session-1", currentSession: { id: "session-1" },
      location: "Main", recentLocations: [], settings: {}, pendingSyncQueue: [], syncedScanEventIds: [],
      simulateSyncFailure: false,
      products: [
        {
          id: "prod-1", businessId: "biz-1", name: "Falken Wildpeak", brand: "Falken", category: "tire",
          specsShort: "265/70R17", primarySku: "2881-6861", primaryBarcode: "0123456789012",
          gtin: "00123456789012", upc: "123456789012", ean: "0123456789012", vendorCodes: ["X001ABCD"],
          aliases: ["2881-6861", "28816861"], imageUrl: "", location: "Bay 3", notes: "", status: "active",
          trustedExactCanonicalId: "trusted-exact:v1:tenant-scoped-opaque-id",
        },
      ],
      aliases: [], scanFeed: [], finalCounts: [], needsReviewQueue: [], lastCleanupBackup: null,
      catalog: [], shopOverrides: [], feedbackEvents: [], countSnapshots: [], firstScanAt: null,
      sessionHistory: [],
    };
  }

  it("buildPersistedScanState round-trip (JSON stringify/parse) at 'business' level keeps primaryBarcode intact", () => {
    const persisted = buildPersistedScanState(makeState(), "business");
    const rehydrated = JSON.parse(JSON.stringify(persisted));
    const product1 = (rehydrated.products as Array<Record<string, unknown>>)[0];
    expect(product1.primaryBarcode).toBe("0123456789012");
    expect(product1.gtin).toBe("00123456789012");
    expect(product1.upc).toBe("123456789012");
    expect(product1.ean).toBe("0123456789012");
    expect(product1.trustedExactCanonicalId).toBe("trusted-exact:v1:tenant-scoped-opaque-id");
    // The reusable alias/vendor data on the product is still gone.
    expect(product1.aliases).toBeUndefined();
    expect(product1.vendorCodes).toBeUndefined();
  });

  // Regression for the trust-gate-breaking bug: CUSTOMER_SAFE_PRODUCT_FIELDS omitted `verified` and
  // `businessId`, so after a customer persist/reload round-trip a verified product's own identifier
  // (primaryBarcode/gtin/upc/ean) survived (per the fix above) but the resolver trust gate in
  // matchProductByIdentifiers (src/products/match/aliasMatcher.ts:111, `p.businessId === businessId &&
  // p.verified === true`) could never match it again - the shop's own already-verified products stopped
  // resolving as "known" after every reload. This proves both fields round-trip AND the trust gate still
  // matches post-reload.
  it("sanitizeProduct(product, 'business') preserves verified and businessId", () => {
    const verifiedProduct = { ...product, businessId: "biz-1", verified: true };
    const p = sanitizeProduct(verifiedProduct, "business") as Record<string, unknown>;
    expect(p.verified).toBe(true);
    expect(p.businessId).toBe("biz-1");
  });

  it("a verified product still resolves as known via matchProductByIdentifiers after a full customer persist round-trip", () => {
    const businessId = "biz-1";
    const state = makeState();
    state.products[0].verified = true;
    delete state.products[0].trustedExactCanonicalId;

    const persisted = buildPersistedScanState(state, "business");
    const rehydrated = JSON.parse(JSON.stringify(persisted)) as { products: Product[] };

    const cleaned: CleanedCode = {
      rawCode: "0123456789012",
      cleanCode: "0123456789012",
      normalizedCandidates: ["0123456789012"],
    };

    const resolution = matchProductByIdentifiers(cleaned, rehydrated.products, businessId);
    expect(resolution, "the rehydrated product's own primaryBarcode still resolves as known").not.toBeNull();
    expect(resolution?.matchType).toBe("primary_barcode");
    expect(resolution?.productId).toBe("prod-1");
  });
});
