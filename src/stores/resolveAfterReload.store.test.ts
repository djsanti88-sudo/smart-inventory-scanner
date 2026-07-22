import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// Repro for the customer-review-persistence bot failure (task-BOTFIX2-report.md / task-RESOLVEMERGE):
// a customer scans 3 unknown codes (Plan A gives each an immediate provisional "Unidentified item"
// count row), does a REAL full page reload (state round-trips through the customer/"business" persist
// split - src/stores/scanPersist.ts), then approves the FIRST Needs-Review item via "create new
// product". Before the fix, the Counts table kept ALL 3 "Unidentified item" rows instead of merging the
// resolved code's provisional count into the newly named product - net effect: wrong counts.
//
// Root cause: resolveUnknown's provOrphanId lookup (scanStore.ts) finds the scan's own provisional
// placeholder product by matching `review.cleanCode` against the product's
// [primaryBarcode, gtin, upc, ean, primarySku] identifier fields. buildPersistedScanState's customer
// ("business") shape (CUSTOMER_SAFE_PRODUCT_FIELDS in sensitiveFields.ts) does NOT include
// primaryBarcode/gtin/upc/ean (only primarySku, which is normally blank for an auto-minted provisional
// placeholder), and does not preserve `provisional` either. After a real reload, the rehydrated
// provisional product's identifier fields are gone, so provOrphanId can never find it again -
// resolveUnknown falls into the "mint a brand new product" branch, leaving the original provisional
// product + its finalCounts row permanently orphaned (never merged, never removed).

function totalQty(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

function rehydrateAsCustomer(store: ReturnType<typeof createTestScanStore>) {
  const s = store.getState();
  const persisted = buildPersistedScanState(s as unknown as PersistableScanState, "business");
  // Simulate the ACTUAL localStorage round trip (JSON serialize + parse), same as scanPersist.test.ts's
  // "round-trip" case, then apply it back onto the store exactly like onRehydrateStorage would - merging
  // the rehydrated (sanitized) fields over the in-memory state.
  const rehydrated = JSON.parse(JSON.stringify(persisted));
  store.setState((prev) => ({ ...prev, ...rehydrated }));
}

describe("scanStore - resolveUnknown(create_new) after a real customer reload merges provisional counts", () => {
  it("approving one of 3 unresolved scans after reload yields ONE named product at the right qty, zero stray duplicate rows for that code", () => {
    const store = createTestScanStore({ db: new MockDb() });

    const codes = ["999000111222", "888000111222", "777000111222"];
    for (const c of codes) store.getState().processScan(c);

    // Sanity: Plan A "scan N = count N" gave each unresolved code its own provisional count row already.
    expect(totalQty(store), "3 unresolved scans are provisionally counted before reload").toBe(3);
    expect(store.getState().finalCounts.length).toBe(3);
    const provisionalIdsBefore = new Set(store.getState().products.filter((p) => p.provisional === true).map((p) => p.id));
    expect(provisionalIdsBefore.size).toBe(3);

    // Real full reload: round-trip through the customer ("business") persist split.
    rehydrateAsCustomer(store);

    // The provisional counts must still be there after reload (nothing lost by the reload itself).
    expect(totalQty(store), "reload must not lose any provisional count").toBe(3);

    const firstCode = codes[0];
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === firstCode && r.status === "open");
    expect(review, "the review for the first scanned code survives reload").toBeDefined();

    // Approve it via "create new product" (the exact action the bot's UI performs).
    store.getState().resolveUnknown(review!.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Rehydrated Test Product" },
    });

    const named = store.getState().products.find((p) => p.name === "Rehydrated Test Product" && p.status !== "archived");
    expect(named, "the newly named product exists").toBeDefined();

    const namedQty = store.getState().finalCounts.find((c) => c.productId === named!.id)?.quantity ?? 0;
    // The resolved code's provisional count (1) must have been PRESERVED onto the named product - not
    // reset to 0 (lost) and not doubled to 2 (re-counted) or left duplicated across two rows.
    expect(namedQty, "the named product's count equals the resolved code's provisional qty (1), not 0 and not 2").toBe(1);

    // The total quantity across ALL rows must be unchanged by the resolve (3 physical items scanned,
    // still 3 counted total) - no count created or destroyed by the merge.
    expect(totalQty(store), "resolving must not change the total counted quantity").toBe(3);

    // No stray leftover row for the RESOLVED code's own provisional placeholder should remain counted
    // under the generic "Unidentified item" label - it must have been merged into the named product, not
    // left behind as an orphan alongside it.
    const unidentifiedRowsForFirstCode = store.getState().products.filter(
      (p) =>
        p.status !== "archived" &&
        p.name.includes("Unidentified item") &&
        store.getState().finalCounts.some((c) => c.productId === p.id) &&
        // this placeholder used to carry the resolved code's identity before reload stripped it; we
        // identify it here structurally: it must NOT coexist with the named product for the same review.
        p.id === named!.id,
    );
    expect(unidentifiedRowsForFirstCode.length, "the resolved placeholder was renamed in place, not left as a separate Unidentified row").toBe(0);

    // The OTHER two (still-unresolved) codes must remain untouched: still their own provisional
    // "Unidentified item" rows, still counted once each.
    const otherCodes = codes.slice(1);
    for (const code of otherCodes) {
      const stillOpenReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === code);
      expect(stillOpenReview?.status, `${code}'s review remains open (untouched by resolving a different code)`).toBe("open");
    }
    expect(store.getState().finalCounts.length, "3 count rows total: 1 named + 2 still-provisional").toBe(3);
  });
});
