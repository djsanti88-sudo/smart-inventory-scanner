import { describe, it, expect } from "vitest";
import { sanitizeProduct } from "@/services/security/serializers";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// Owner rule (2026-07-22, encoded in src/components/FinalCountTable.tsx:129-131): the barcode a shop
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
        },
      ],
      aliases: [], scanFeed: [], finalCounts: [], needsReviewQueue: [], lastCleanupBackup: null,
      catalog: [], shopOverrides: [], feedbackEvents: [], countSnapshots: [], firstScanAt: null,
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
    // The reusable alias/vendor data on the product is still gone.
    expect(product1.aliases).toBeUndefined();
    expect(product1.vendorCodes).toBeUndefined();
  });
});
