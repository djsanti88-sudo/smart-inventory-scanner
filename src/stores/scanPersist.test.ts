import { describe, it, expect } from "vitest";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// Sec-4 contract: a customer ("business") browser must NOT persist the reusable code database. This test
// proves what reaches localStorage for each role. The SecurityLeakBot proves the same against a real
// browser; this is the fast, deterministic guard.

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
        id: "prod-1",
        businessId: "biz-1",
        name: "Falken Wildpeak",
        brand: "Falken",
        category: "tire",
        specsShort: "265/70R17",
        primarySku: "2881-6861",
        primaryBarcode: "0123456789012",
        gtin: "00123456789012",
        upc: "123456789012",
        ean: "0123456789012",
        vendorCodes: ["X001ABCD"],
        aliases: ["2881-6861", "28816861"],
        imageUrl: "",
        location: "Bay 3",
        notes: "",
        status: "active",
      },
    ],
    aliases: [{ id: "a1", cleanCode: "2881-6861", normalizedCode: "28816861", productId: "prod-1" }],
    scanFeed: [{ id: "s1", rawScannedCode: "2881-6861", cleanCode: "2881-6861", productId: "prod-1" }],
    finalCounts: [{ id: "c1", productId: "prod-1", quantity: 3, aliasesSeen: ["2881-6861", "28816861"] }],
    needsReviewQueue: [{ id: "r1", rawScannedCode: "999", cleanCode: "999" }],
    lastCleanupBackup: { removedAliases: [{ id: "a9", cleanCode: "deadbeef" }] },
    catalog: [{ id: "cat1", primaryBarcode: "0123456789012", gtin: "00123456789012" }],
    shopOverrides: [{ id: "so1", cleanCode: "555" }],
    feedbackEvents: [{ id: "f1", code: "2881-6861" }],
  };
}

// Keys/values that must NEVER appear in a customer's persisted blob.
const FORBIDDEN_KEYS = [
  "aliases",
  "catalog",
  "shopOverrides",
  "scanFeed",
  "needsReviewQueue",
  "lastCleanupBackup",
  "feedbackEvents",
  "cleanCode",
  "normalizedCode",
  "rawScannedCode",
  "primaryBarcode",
  "gtin",
  "upc",
  "ean",
  "vendorCodes",
  "rawCodeExample",
];
// Note: finalCounts keep an `aliasesSeen` key but blanked to [] (shape-safe, zero codes) - asserted below.

describe("buildPersistedScanState (Sec-4 customer localStorage split)", () => {
  it("customer (business): NO aliases/catalog/codes are written to disk", () => {
    const persisted = buildPersistedScanState(makeState(), "business");
    const blob = JSON.stringify(persisted);

    // None of the sensitive keys/values appear anywhere in the serialized blob.
    for (const k of FORBIDDEN_KEYS) {
      expect(blob, `forbidden key/value "${k}" leaked into customer persist`).not.toContain(`"${k}"`);
    }
    // The raw code VALUES themselves are gone too.
    expect(blob).not.toContain("28816861");
    expect(blob).not.toContain("0123456789012");
    expect(blob).not.toContain("X001ABCD");

    // What SHOULD survive: session, settings, sync plumbing, numeric counts, product-facing fields.
    expect(persisted.businessId).toBe("biz-1");
    expect(persisted.sessionId).toBe("session-1");
    expect(Array.isArray(persisted.products)).toBe(true);
    const p = (persisted.products as Array<Record<string, unknown>>)[0];
    expect(p.name).toBe("Falken Wildpeak");
    expect(p.primarySku).toBe("2881-6861"); // part number is product-facing (allowed)
    const counts = persisted.finalCounts as Array<Record<string, unknown>>;
    expect(counts[0].quantity).toBe(3);
    expect(counts[0].aliasesSeen).toEqual([]); // codes stripped from counts
  });

  it("platformOwner (platform): full local view is persisted (legacy behavior unchanged)", () => {
    const persisted = buildPersistedScanState(makeState(), "platform");
    expect(persisted).toHaveProperty("aliases");
    expect(persisted).toHaveProperty("catalog");
    expect(persisted).toHaveProperty("scanFeed");
    expect(persisted).toHaveProperty("needsReviewQueue");
    expect(persisted).toHaveProperty("shopOverrides");
    const blob = JSON.stringify(persisted);
    expect(blob).toContain("28816861"); // platformOwner keeps the full internal data locally
  });
});
