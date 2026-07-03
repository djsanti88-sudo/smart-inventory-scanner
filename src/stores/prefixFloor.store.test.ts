import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Plan C Task 3 - PREFIX FLOOR: a counted-but-unidentified row must never be a bare
// "Unidentified item (barcode X)" when the scanned code's GS1 company prefix maps to a known brand.
// "051596000004" is a valid UPC-A (mod-10 check digit) whose GTIN-13 form starts with the curated
// seed prefix "0051596" (United Solutions, confidence 0.9 - see prefixIndex.ts SEED). "222222222229"
// has no known prefix mapping anywhere in the seed/derived/learned tiers, so it must keep the bare
// fallback.

function totalCount(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

describe("prefix floor - never an empty row when the GS1 prefix maps to a known brand", () => {
  it("names a code with a known prefix '<Brand> / product unconfirmed', Suggested, unverified, and still counts", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false }); // synchronous provisional count path
    store.getState().processScan("051596000004");

    expect(totalCount(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === "051596000004");
    expect(prod, "a provisional product must exist for the scanned code").toBeDefined();
    expect(prod!.name).toBe("United Solutions / product unconfirmed");
    expect(prod!.brand).toBe("United Solutions");
    expect(prod!.verified).toBe(false);
    expect(prod!.provisional).toBe(true);

    const ev = store.getState().scanFeed.find((e) => e.cleanCode === "051596000004");
    expect(ev?.decodeStatus).toBe("suggested"); // Suggested surface (Task 1 relabels this badge's text)
  });

  it("falls back to the bare 'Unidentified item' placeholder when the prefix maps to nothing", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("222222222229");

    expect(totalCount(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === "222222222229");
    expect(prod, "a provisional product must exist for the scanned code").toBeDefined();
    expect(prod!.name).toBe("Unidentified item (code 222222222229)"); // fails the mod-10 check digit
    expect(prod!.brand).toBe("");
    expect(prod!.verified).toBe(false);
  });
});
