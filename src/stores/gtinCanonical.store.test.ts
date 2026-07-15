import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// Task 4 (QA fix plan 2026-07-15): GTIN-14 canonicalization. Proven live bug: scanning 00049000028911
// against a product whose upc is stored as 049000028911 used to resolve "unknown" (leading-zero padding
// difference), minting a duplicate provisional product row instead of counting the existing one. Fix is
// additive canonical/variant candidates in buildNormalizedCandidates (scanCleaner.ts) - the deterministic
// resolver and every store-level exact-identifier comparison read from that same candidate list.

function reviewIdFor(store: ReturnType<typeof createTestScanStore>, cleanCode: string) {
  const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === cleanCode && x.status === "open");
  if (!r) throw new Error(`no open review for ${cleanCode}`);
  return r.id;
}

describe("scanStore - Task 4: GTIN-14 canonicalization (leading-zero equivalence)", () => {
  it("a verified product with a 12-digit upc is matched Known by both its 12-digit and 14-digit zero-padded forms, one product row, count incremented on each scan", () => {
    const store = createTestScanStore();

    // Seed a verified product carrying the 12-digit UPC (mirrors how most catalog rows are stored).
    store.getState().processScan("049000028911"); // unknown -> Needs Review (no seed product for this code)
    store.getState().resolveUnknown(reviewIdFor(store, "049000028911"), "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Canned Beans", brand: "GenericBrand", upc: "049000028911" },
    });
    const pid = store.getState().products.find((p) => p.name === "Canned Beans")!.id;
    expect(store.getState().finalCounts.find((c) => c.productId === pid)?.quantity).toBe(1);

    // Re-scan the SAME product via its 14-digit zero-padded GTIN form - must resolve Known to the SAME
    // product (not a new "unknown" -> provisional duplicate) and increment the SAME count row.
    const rescan = store.getState().processScan("00049000028911");
    expect(rescan?.resolverStatus).toBe("known");
    expect(rescan?.matchedProductId).toBe(pid);

    const rows = store.getState().products.filter((p) => p.status !== "archived" && (p.upc === "049000028911" || p.name === "Canned Beans"));
    expect(rows, "exactly one product row for this GTIN identity").toHaveLength(1);
    expect(store.getState().finalCounts.filter((c) => c.productId === pid)).toHaveLength(1);
    expect(store.getState().finalCounts.find((c) => c.productId === pid)!.quantity).toBe(2);
  });

  it("CASE-PACK NEGATIVE: a GTIN-14 with a non-zero indicator digit (case pack) never merges into the unit product's count", () => {
    const store = createTestScanStore();

    store.getState().processScan("049000028911");
    store.getState().resolveUnknown(reviewIdFor(store, "049000028911"), "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Canned Beans (unit)", brand: "GenericBrand", upc: "049000028911" },
    });
    const pid = store.getState().products.find((p) => p.name === "Canned Beans (unit)")!.id;
    expect(store.getState().finalCounts.find((c) => c.productId === pid)?.quantity).toBe(1);

    // 10049000028918: indicator digit "1" -> a case pack, a DIFFERENT countable product. Must stay
    // Needs Review (or mint its own separate row), never silently increment the unit product's count.
    const rescan = store.getState().processScan("10049000028918");
    expect(rescan?.matchedProductId).not.toBe(pid);
    expect(store.getState().finalCounts.find((c) => c.productId === pid)!.quantity).toBe(1);
  });
});
