import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

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

// QA ROUND-2 SEAM 3 (live-proven bypass, 2026-07-16): the prefix floor gave a confident fabricated
// brand ("Healthyholics / product unconfirmed") to a scanner-MISREAD GTIN (bad GS1 check digit) and to
// textbook GS1 EXAMPLE barcodes. TOP-LEVEL LAW: the code STILL appears + counts as "Unidentified item"
// (no scan is lost) - it just carries NO fabricated identity. The name/brand must agree across every
// surface (count row + scan feed provisional product) - no brand anywhere.
describe("prefix floor - no fabricated brand for misread/example codes (three surfaces agree)", () => {
  it("a misread GTIN (bad check digit) counts as 'Unidentified item', brand '', NO 'Healthyholics'", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false }); // synchronous provisional count path
    store.getState().processScan("012345678900"); // prefix maps to Healthyholics, but check digit FAILS

    // LAW: it still appears and still counts.
    expect(totalCount(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === "012345678900");
    expect(prod, "a provisional product must exist for the scanned code").toBeDefined();
    // No fabricated identity: honest Unidentified placeholder + empty brand.
    expect(prod!.name).toBe("Unidentified item (code 012345678900)");
    expect(prod!.name).not.toMatch(/Healthyholics/i);
    expect(prod!.brand).toBe("");
    expect(prod!.verified).toBe(false);
    expect(prod!.provisional).toBe(true);

    // Feed surface agrees - no brand leaked into the scan feed reason/name either.
    const ev = store.getState().scanFeed.find((e) => e.cleanCode === "012345678900");
    expect(ev).toBeDefined();
    expect(JSON.stringify(ev)).not.toMatch(/Healthyholics/i);
  });

  it("a textbook GS1 EXAMPLE barcode counts as 'Unidentified item', brand '', no fabricated identity", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("0012345670121"); // documented Healthyholics EXAMPLE GTIN (valid check digit)

    expect(totalCount(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === "0012345670121");
    expect(prod, "a provisional product must exist for the scanned code").toBeDefined();
    expect(prod!.name).toMatch(/^Unidentified item/);
    expect(prod!.name).not.toMatch(/Healthyholics/i);
    expect(prod!.brand).toBe("");
    expect(prod!.verified).toBe(false);
  });

  it("REGRESSION: a legitimate code with a real prefix STILL gets its confident floor brand", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("051596000004"); // valid check digit, real prefix, not an example

    expect(totalCount(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === "051596000004");
    expect(prod!.name).toBe("United Solutions / product unconfirmed");
    expect(prod!.brand).toBe("United Solutions");
  });
});
