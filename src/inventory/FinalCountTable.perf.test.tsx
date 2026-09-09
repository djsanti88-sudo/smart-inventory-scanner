import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { FinalCountTable } from "@/inventory/FinalCountTable";
import type { InventoryCount, Product } from "@/types";

// DEFECT #37 (live-reproduced 2026-08-05/06, canelo round 2): same O(N*M) render-time product lookup
// class as LiveScanFeed.perf.test.tsx, here for the counts table. `rows` was built with
// `sessionCounts.map((c) => ({ count: c, product: getProduct(c.productId) }))`, where getProduct does
// a linear `products.find()` - AND `rows` was not memoized at all, so this O(N*M) scan re-ran on every
// render, not just when the underlying data changed.
//
// Each rendered row legitimately reads `product.id` a small constant number of times on its own (data-
// testids, action handlers) - that cost is O(N) and expected. What must NOT happen is that cost scaling
// with the CATALOG size M: a lookup implemented as a per-row linear `.find()` re-reads `product.id` for
// every candidate it scans past, so growing M (with N fixed) inflates the read count proportionally to
// M. A single-pass Map-based lookup (built once, O(M)) makes per-row lookup O(1), so growing M should
// barely move the total read count. This test asserts exactly that M-invariance instead of relying on a
// brittle hand-picked constant.
describe("FinalCountTable perf - product lookup must be O(N+M), never O(N*M) (defect #37)", () => {
  afterEach(() => {
    cleanup();
    useScanStore.setState({ products: [], finalCounts: [], currentSession: null });
  });

  function measureIdReads(N: number, M: number): number {
    let idReadCount = 0;
    const products: Product[] = Array.from({ length: M }, (_, i) => {
      const realId = `prod-${i}`;
      const p = {
        businessId: "biz1",
        name: `Product ${i}`,
        brand: "Acme",
        category: "Tools",
        specsShort: "",
        specsFull: "",
        primarySku: `SKU-${i}`,
        primaryBarcode: `${1000000000000 + i}`,
        status: "active",
        verified: true,
      } as unknown as Product;
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

    // Worst case for a linear find(): every row targets the LAST product in the array, forcing a full
    // M-length scan per row under the old implementation.
    const targetId = `prod-${M - 1}`;
    const sessionId = "session-1"; // matches the store's default currentSession.id
    const counts: InventoryCount[] = Array.from({ length: N }, (_, i) => ({
      id: `c-${i}`,
      businessId: "biz1",
      sessionId,
      productId: targetId,
      quantity: i + 1,
      lastScannedAt: "",
      aliasesSeen: [],
      scanEventIds: [],
      createdAt: "",
      updatedAt: "",
      syncStatus: "synced",
      syncError: null,
      appliedIdempotencyKeys: [],
    }));

    useScanStore.setState({ products, finalCounts: counts });
    idReadCount = 0; // reset after seeding the store
    render(<FinalCountTable />);
    cleanup();
    return idReadCount;
  }

  it("growing the catalog 6x (M) barely moves product.id reads, for a fixed number of rows (N)", () => {
    const N = 400;
    const readsSmallCatalog = measureIdReads(N, 50);
    const readsBigCatalog = measureIdReads(N, 300);

    // O(N*M): growing M by 6x would grow the read count by roughly 6x too (dominated by the linear
    // scan through the catalog for every one of the N rows: growth ~= N * (300-50) = 100,000).
    // O(N+M): the extra M only adds a bounded number of Map-build reads (~250 more, once), which is
    // tiny relative to N - well under a generous 2*N bound.
    const growth = readsBigCatalog - readsSmallCatalog;
    expect(growth).toBeLessThan(2 * N);
  });
});
