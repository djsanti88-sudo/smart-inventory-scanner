import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// Task 1b audit note (2026-07-22 follow-up to Task 1's SAVE_PRODUCT idempotency-key fix): a reviewer
// flagged importProductsCsv's SAVE_PRODUCT key (scanStore.ts, bare
// `businessId:sessionId:p.id:SAVE_PRODUCT`) as a sibling of the same bug class fixed at correctProduct
// (024c849) and resolveUnknown's orphan-merge (this same follow-up). Investigated and left UNCHANGED
// on purpose: unlike those two sites, importProductsCsv's product ids are freshly minted by
// buildProductImport -> `prod-import-${idFactory()}` (csvImport.ts:170) ONCE PER ROW, EVERY call - no
// other write path in the codebase (scan, resolve, correct) ever reuses a CSV-import-minted id, and two
// separate importProductsCsv calls (even re-importing the identical file) each mint entirely new,
// non-overlapping ids. So there is no code path where two DISTINCT SAVE_PRODUCT writes share the same
// entityId here - the bare key is safe. This test locks in that invariant: re-importing the SAME CSV
// content twice must produce two INDEPENDENT products (two SAVE_PRODUCT writes with distinct ids/keys),
// never a silently-dropped second import.
describe("importProductsCsv key safety (Task 1b audit: no id-reuse collision exists at this site)", () => {
  it("re-importing the identical CSV content twice creates two separate products, both reaching MockDb", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const csv = "name,barcode\nWidget A,049000050103";

    // First import: barcode 049000050103 (unseeded, valid GTIN) claimed by product #1.
    const first = store.getState().importProductsCsv(csv);
    await store.getState().syncPending();
    expect(first.productsCreated).toBe(1);
    const firstId = store.getState().products.find((p) => p.name === "Widget A")!.id;
    expect(db.snapshot().products[firstId]?.name).toBe("Widget A");

    // Second import of the SAME CSV text: the barcode is now already owned, so this row REFRESHES the
    // existing product's descriptive fields (QA Task 7, rescue/qafix 29cdc63) rather than creating a
    // second product - proving buildProductImport's OWN dedupe guard (unrelated to idempotency keys)
    // already prevents a real duplicate here. (Pre-qafix this row was reported as a conflict; the
    // certified refresh-on-reimport behavior reclassifies it as a refresh, never a new product.)
    const second = store.getState().importProductsCsv(csv);
    await store.getState().syncPending();
    expect(second.productsCreated, "conflicting barcode is not re-applied as a new product").toBe(0);
    expect(second.refreshed, "the already-owned barcode row refreshes the existing product").toBeGreaterThan(0);

    // Import a DIFFERENT product with a fresh, valid, unseeded barcode: distinct id, distinct key, both writes land.
    const third = store.getState().importProductsCsv("name,barcode\nWidget B,012345678905");
    await store.getState().syncPending();
    expect(third.productsCreated).toBe(1);
    const secondId = store.getState().products.find((p) => p.name === "Widget B")!.id;
    expect(secondId).not.toBe(firstId);
    expect(db.snapshot().products[secondId]?.name, "the second distinct import also reaches MockDb (no key collision)").toBe(
      "Widget B",
    );
  });
});
