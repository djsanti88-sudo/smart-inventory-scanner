import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// UI-1 fix (2026-08-13; see docs/HISTORY.md): resolveUnknown rewrites a
// resolved code's feed row(s) to status "resolved" but used to carry over `quantityAfterScan` verbatim
// from scan time. That value is a snapshot of the PROVISIONAL PLACEHOLDER's own running count at the
// moment it was scanned - it is only still correct when the resolution reuses that same placeholder id
// (the ordinary create_new path). When resolution instead MERGES the placeholder into a DIFFERENT,
// already-counted existing product (link_existing / dedup-reuse via transferOrphanCount), the stale
// snapshot no longer matches the target product's true finalCounts quantity - LiveScanFeed widening its
// render condition to "resolved" (the companion component fix) would then display a WRONG number, which
// is worse than the blank "-" it replaces. This test proves resolveUnknown keeps quantityAfterScan in
// lockstep with the authoritative finalCounts ledger through an orphan merge.
describe("resolveUnknown - feed row quantityAfterScan matches finalCounts after an orphan merge (UI-1)", () => {
  it("the merged code's feed row shows the TARGET product's post-merge quantity, not the stale placeholder count", () => {
    const store = createTestScanStore();

    // 1. Establish product A with an existing count of 2 (two scans of its own code).
    const CODE_A = "111111111111";
    store.getState().processScan(CODE_A);
    const reviewA = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_A && r.status === "open")!;
    store.getState().resolveUnknown(reviewA.id, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Widget Alpha", brand: "Acme" },
    });
    const productAId = reviewA.provisionalProductId!;
    // A second scan of the now-aliased code counts directly (no review involved).
    store.getState().processScan(CODE_A);

    const productABefore = store.getState().finalCounts.find((c) => c.productId === productAId);
    expect(productABefore?.quantity, "product A has 2 units counted before the merge").toBe(2);

    // 2. Scan a DIFFERENT, still-unknown code B once - it mints its own provisional placeholder and
    // counts synchronously (TOP-LEVEL LAW), independent of product A.
    const CODE_B = "222222222222";
    store.getState().processScan(CODE_B);
    const reviewB = store.getState().needsReviewQueue.find((r) => r.cleanCode === CODE_B && r.status === "open")!;
    const provisionalBId = reviewB.provisionalProductId!;
    const rowB = store.getState().scanFeed.find((e) => e.cleanCode === CODE_B)!;
    expect(rowB.status, "code B's row already counted as a provisional 'known' row").toBe("known");
    expect(rowB.quantityAfterScan, "code B's placeholder ran its own count starting at 1").toBe(1);

    // 3. Human resolves code B by linking it to the EXISTING product A (a genuine duplicate-code case:
    // the same physical item was scanned under two different codes). This merges the code-B placeholder's
    // quantity onto product A via transferOrphanCount.
    store.getState().resolveUnknown(reviewB.id, "link_existing", {
      productId: productAId,
      applyToCount: false,
      origin: "human",
    });

    const productAAfter = store.getState().finalCounts.find((c) => c.productId === productAId);
    expect(productAAfter?.quantity, "product A's ledger absorbs code B's 1 unit: 2 + 1 = 3").toBe(3);
    const orphanRowStillPresent = store.getState().finalCounts.some((c) => c.productId === provisionalBId);
    expect(orphanRowStillPresent, "the merged placeholder's own finalCounts row is gone (no double count)").toBe(false);

    const resolvedRowB = store.getState().scanFeed.find((e) => e.id === rowB.id)!;
    expect(resolvedRowB.status).toBe("resolved");
    expect(resolvedRowB.matchedProductId).toBe(productAId);
    // THE FIX: the feed row's displayed quantity must match the authoritative ledger for product A at
    // this moment (3), never the stale pre-merge placeholder snapshot (1).
    expect(
      resolvedRowB.quantityAfterScan,
      "resolved feed row's quantity must match finalCounts for the product it now points to",
    ).toBe(3);
  });
});
