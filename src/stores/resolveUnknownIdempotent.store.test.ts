import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// resolveUnknown must be idempotent against a double-click / concurrent re-entry. Every async decode path
// (liveDecode, backgroundVerifyDeep, cloudCatalogResolve, correctionRecheck) already re-checks
// `review.status !== "open"` before resolving; resolveUnknown itself did not, so a second call on an
// already-resolved review re-ran applyToCount -> processScan(code) and counted the SAME physical item twice.

const CODE = "111222333444";

describe("resolveUnknown idempotency (double-click / re-entry guard)", () => {
  it("a second resolveUnknown on an already-resolved review is a no-op (no double-count)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan(CODE); // unknown -> a single open Needs-Review item
    const review = store.getState().needsReviewQueue.at(-1)!;
    expect(review.status).toBe("open");

    const payload = { applyToCount: true, origin: "human" as const, newProduct: { name: "My Product", brand: "MyBrand" } };
    store.getState().resolveUnknown(review.id, "create_new", payload); // first resolve -> counts qty 1
    store.getState().resolveUnknown(review.id, "create_new", payload); // double-click / race -> must be a no-op

    const prod = store.getState().products.find((p) => p.name === "My Product");
    expect(prod, "the product is created once").toBeTruthy();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity, "counted exactly once").toBe(1);
    expect(store.getState().products.filter((p) => p.name === "My Product"), "no duplicate product row").toHaveLength(1);
  });
});
