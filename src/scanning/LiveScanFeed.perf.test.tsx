import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LiveScanFeed } from "@/scanning/LiveScanFeed";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent, Product } from "@/types";

// DEFECT #37 (live-reproduced 2026-08-05/06, canelo round 2): a fresh device signing into a business
// with thousands of scanEvents/products freezes the renderer for 30+ seconds. Root cause traced to
// this component: for every rendered scanFeed row it called the store's `getProduct(id)`, which does
// `products.find(p => p.id === id)` - an O(products.length) LINEAR SCAN. Rendering N feed rows against
// M products is therefore O(N*M), not the O(N+M) a single-pass Map-based lookup should cost.
//
// This test proves the ALGORITHMIC SHAPE (not wall-clock): it counts how many times `product.id` is
// actually read while rendering N rows against M products. A Map built once from `products` reads each
// product's `id` exactly once (M total) no matter how many feed rows reference it. The old per-row
// `.find()` re-scans up to M products for EVERY row, so the id-read count scales with N*M and blows
// past any fixed bound as N grows for a constant M.
describe("LiveScanFeed perf - product lookup must be O(N+M), never O(N*M) (defect #37)", () => {
  afterEach(() => {
    cleanup();
    useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
  });

  it("reads each product's id a bounded number of times regardless of how many feed rows reference it", () => {
    const M = 50; // distinct products
    const N = 800; // scan feed rows, all referencing products (worst case: last id in the array)

    let idReadCount = 0;
    const products: Product[] = Array.from({ length: M }, (_, i) => {
      const realId = `prod-${i}`;
      const p = {
        businessId: "biz1",
        name: `Product ${i}`,
        brand: "Acme",
        specsShort: "",
        primarySku: `SKU-${i}`,
        provisional: false,
      } as unknown as Product;
      // Instrument `id` as a counted getter so we can measure how many times the render path reads it,
      // independent of any particular implementation detail (Map vs. find vs. index).
      Object.defineProperty(p, "id", {
        enumerable: true,
        configurable: true,
        get() {
          idReadCount++;
          return realId;
        },
      });
      return p;
    });

    // Every row targets the LAST product in the array - the worst case for a linear `.find()` scan
    // (it must walk all M entries before matching), and the case a Map-based lookup handles in O(1).
    const targetId = "prod-49";
    const scanFeed: ScanEvent[] = Array.from({ length: N }, (_, i) => ({
      id: `ev-${i}`,
      rawCode: `code-${i}`,
      cleanCode: `code-${i}`,
      matchedProductId: targetId,
      matchType: "barcode",
      status: "known",
      quantityAfterScan: 1,
      decodeStatus: "verified",
      reason: "",
      syncStatus: "synced",
      createdAt: Date.now(),
    })) as unknown as ScanEvent[];

    useScanStore.setState({ scanFeed, needsReviewQueue: [], products, finalCounts: [] });

    idReadCount = 0; // reset after seeding the store (setState itself must not read the getter M*N times)
    render(<LiveScanFeed />);

    // O(N+M)/O(M) bound: building a lookup structure reads each product's id ~once (M total), plus a
    // small constant overhead. O(N*M) would read it on the order of N*M = 800*50 = 40,000 times.
    // A generous bound of 5*M keeps this robust to minor implementation variance while still failing
    // hard against the quadratic pattern.
    expect(idReadCount).toBeLessThan(M * 5);
  });
});
