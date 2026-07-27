import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// TOP-LEVEL LAW repro (review finding, 2026-07-22): re-scanning a code after a CUSTOMER-level reload
// must still count (scan 2 = count 2). The identifier-persist fix (CUSTOMER_SAFE_PRODUCT_FIELDS now
// keeps primaryBarcode/gtin/upc/ean) interacted badly with the still-stripped `provisional` flag:
// (1) an unknown scan mints a provisional product and counts it (qty 1);
// (2) a reload at "business" access level rehydrates that product WITH primaryBarcode but WITHOUT
//     provisional:true;
// (3) a re-scan of the same code misses processScan's Phase-2 re-scan bridge (it requires
//     p.provisional === true), so the scan routes to the unknown path;
// (4) ensureProvisionalCount's idempotent guard then matches the rehydrated product by the surviving
//     primaryBarcode and returns early WITHOUT counting - feed shows 2 rows, total stays 1.
// Fix: `provisional` is a LOCAL boolean flag (not a barcode, not reusable alias/catalog data, not
// sensitive), so it now survives the customer persist split (CUSTOMER_SAFE_PRODUCT_FIELDS), letting
// the re-scan bridge find the still-counted provisional row and increment it.

function totalQty(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

function rehydrateAsCustomer(store: ReturnType<typeof createTestScanStore>) {
  const s = store.getState();
  const persisted = buildPersistedScanState(s as unknown as PersistableScanState, "business");
  // Simulate the ACTUAL localStorage round trip (JSON serialize + parse), then apply it back onto the
  // store exactly like onRehydrateStorage would - merging the rehydrated (sanitized) fields over the
  // in-memory state (same harness as resolveAfterReload.store.test.ts).
  const rehydrated = JSON.parse(JSON.stringify(persisted));
  store.setState((prev) => ({ ...prev, ...rehydrated }));
}

describe("scanStore - re-scan of the same unknown code after a customer reload still counts (TOP-LEVEL LAW)", () => {
  it("scan, customer reload, re-scan same code: feed shows 2 rows AND total counts 2 (scan 2 = count 2)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const code = "999000111222";

    store.getState().processScan(code);
    expect(totalQty(store), "the first unknown scan is provisionally counted").toBe(1);
    expect(store.getState().scanFeed.length).toBe(1);

    // Real full reload: round-trip through the customer ("business") persist split.
    rehydrateAsCustomer(store);
    expect(totalQty(store), "the reload itself must not lose the provisional count").toBe(1);

    store.getState().processScan(code);

    // TOP-LEVEL LAW: every scan appears on the feed AND counts. Scan 2 = count 2, no exceptions.
    expect(store.getState().scanFeed.length, "the re-scan appears on the feed").toBe(2);
    expect(totalQty(store), "the re-scan COUNTS: total is 2, not 1").toBe(2);

    // The re-scan increments the SAME provisional row (re-scan bridge), never a duplicate product row.
    expect(store.getState().finalCounts.length, "one count row: the re-scan incremented the existing provisional row").toBe(1);
  });
});
