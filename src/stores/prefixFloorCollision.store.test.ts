import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// Regression for task-FINALREVIEW-report.md's "Important, low likelihood" follow-up: the
// reload-resilient provOrphanId fallback in resolveUnknown (scanStore.ts) used to re-identify a scan's
// own provisional placeholder ONLY by reconstructed NAME (provisionalPlaceholderName(review.cleanCode))
// once a customer reload stripped the placeholder's `provisional` flag and identifier fields. A
// prefix-floor placeholder name is BRAND-ONLY ("<Brand> / product unconfirmed", prefixFloor.ts), not
// code-specific - two DIFFERENT unresolved codes whose GS1 prefixes map to the SAME brand mint the
// IDENTICAL placeholder name. After reload, `state.products.find(...)` on that name returns the FIRST
// match by array order, which can be the OTHER code's placeholder - resolving one code then merges the
// WRONG code's count into the named product and orphans the other. Net total count was preserved, but
// ATTRIBUTION was wrong.
//
// Fix (task-STABLEID): resolveUnknown now matches on the review's own stable `provisionalProductId`
// (captured at mint time, a local product id - not a barcode/gtin, so it survives the customer persist
// split) BEFORE falling back to the identifier match or the collision-prone name match. This test drives
// two codes that share the seed "United Solutions" GS1 prefix (0051596) - both valid UPC-A check digits -
// so both mint "United Solutions / product unconfirmed" placeholders, round-trips through a REAL customer
// persist, resolves the SECOND-scanned code (the one that is NOT the array-order-first name match, so a
// name-only fallback would grab the WRONG placeholder), and asserts the CORRECT code's count merged.

function totalQty(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

function rehydrateAsCustomer(store: ReturnType<typeof createTestScanStore>) {
  const s = store.getState();
  const persisted = buildPersistedScanState(s as unknown as PersistableScanState, "business");
  const rehydrated = JSON.parse(JSON.stringify(persisted));
  store.setState((prev) => ({ ...prev, ...rehydrated }));
}

describe("scanStore - resolveUnknown(create_new) after reload attributes the RIGHT code when two placeholders share a prefix-floor brand name", () => {
  it("scans two different codes sharing the United Solutions prefix-floor brand, reloads, resolves the SECOND scan - only that code's count merges, the other stays untouched", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // Both valid UPC-A (correct check digit) and both share the seed prefix 0051596 -> "United Solutions"
    // (src/products/catalog/prefixIndex.ts), so ensureProvisionalCount mints the IDENTICAL placeholder
    // name "United Solutions / product unconfirmed" for both - the exact collision precondition.
    const codeA = "051596000004";
    const codeB = "051596320812";

    store.getState().processScan(codeA);
    store.getState().processScan(codeB);

    expect(totalQty(store), "both unresolved scans are provisionally counted before reload").toBe(2);
    const placeholdersBefore = store.getState().products.filter((p) => p.provisional === true);
    expect(placeholdersBefore.length, "two distinct placeholder products were minted").toBe(2);
    expect(
      new Set(placeholdersBefore.map((p) => p.name)).size,
      "sanity: both placeholders share the identical prefix-floor brand name (the collision precondition)",
    ).toBe(1);
    expect(placeholdersBefore[0].name).toBe("United Solutions / product unconfirmed");
    // Sanity: codeA's placeholder is array-order FIRST (this is what a name-only `.find()` fallback would
    // always return, regardless of which review is actually being resolved) - the exact wrong-match risk.
    const placeholderIdA0 = store.getState().needsReviewQueue.find((r) => r.cleanCode === codeA)!.provisionalProductId;
    expect(placeholdersBefore[0].id).toBe(placeholderIdA0);

    // Both reviews must have captured their OWN placeholder's stable id at mint time.
    const reviewABefore = store.getState().needsReviewQueue.find((r) => r.cleanCode === codeA);
    const reviewBBefore = store.getState().needsReviewQueue.find((r) => r.cleanCode === codeB);
    expect(reviewABefore?.provisionalProductId, "review A captured a provisionalProductId").toBeTruthy();
    expect(reviewBBefore?.provisionalProductId, "review B captured a provisionalProductId").toBeTruthy();
    expect(
      reviewABefore!.provisionalProductId,
      "the two reviews' stable ids are NOT the same (they point at their own distinct placeholders)",
    ).not.toBe(reviewBBefore!.provisionalProductId);

    // Real full reload: round-trip through the customer ("business") persist split. This strips
    // `provisional` + identifier fields from every product, but `provisionalProductId` (a local id, not a
    // barcode/gtin) survives on the review via CUSTOMER_SAFE_REVIEW_FIELDS.
    rehydrateAsCustomer(store);
    expect(totalQty(store), "reload must not lose either provisional count").toBe(2);

    const reviewA = store.getState().needsReviewQueue.find((r) => r.cleanCode === codeA && r.status === "open");
    const reviewB = store.getState().needsReviewQueue.find((r) => r.cleanCode === codeB && r.status === "open");
    expect(reviewA, "review A survives reload").toBeDefined();
    expect(reviewB, "review B survives reload").toBeDefined();
    expect(reviewA!.provisionalProductId, "review A's stable id survives the customer persist split").toBeTruthy();
    expect(reviewB!.provisionalProductId, "review B's stable id survives the customer persist split").toBeTruthy();

    // Resolve ONLY code B (the SECOND-scanned code, NOT the array-order-first name match) via create_new.
    // A name-only fallback would incorrectly grab code A's placeholder here (array order), merging code
    // B's resolution onto code A's count and leaving code B's own placeholder orphaned.
    store.getState().resolveUnknown(reviewB!.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Resolved Product B" },
    });

    const named = store.getState().products.find((p) => p.name === "Resolved Product B" && p.status !== "archived");
    expect(named, "the newly named product for code B exists").toBeDefined();
    // THE KEY ASSERTION: the named product must be code B's OWN placeholder upgraded in place (matched by
    // stable id), never a fresh mint and never code A's placeholder.
    expect(named!.id, "code B's own placeholder was upgraded in place (matched by stable id)").toBe(
      reviewB!.provisionalProductId,
    );

    const namedQty = store.getState().finalCounts.find((c) => c.productId === named!.id)?.quantity ?? 0;
    // Code B's own provisional count (1) merged into the named product - not code A's, not doubled, not lost.
    expect(namedQty, "code B's own count (1) merged into the named product").toBe(1);

    // Code A's review must be COMPLETELY untouched: still open, still pointing at its OWN placeholder,
    // still counted once.
    const reviewAAfter = store.getState().needsReviewQueue.find((r) => r.id === reviewA!.id);
    expect(reviewAAfter?.status, "code A's review is untouched - still open").toBe("open");
    expect(
      reviewAAfter?.provisionalProductId,
      "code A's review still points at its OWN placeholder id (never reassigned)",
    ).toBe(reviewA!.provisionalProductId);

    const aPlaceholder = store.getState().products.find((p) => p.id === reviewAAfter!.provisionalProductId);
    expect(aPlaceholder, "code A's own placeholder product still exists").toBeDefined();
    expect(aPlaceholder!.status).not.toBe("archived");
    expect(aPlaceholder!.name, "code A's placeholder keeps the generic prefix-floor name - never renamed to B's product").toBe(
      "United Solutions / product unconfirmed",
    );
    const aQty = store.getState().finalCounts.find((c) => c.productId === aPlaceholder!.id)?.quantity ?? 0;
    expect(aQty, "code A's placeholder still carries its OWN count of 1 - not merged away, not doubled").toBe(1);

    // Total count across all rows is unchanged: 2 physical scans, still 2 counted, no double/lost count.
    expect(totalQty(store), "resolving code B must not change the total counted quantity").toBe(2);

    // Exactly 2 count rows total: the named product (B) + code A's still-provisional placeholder. No
    // stray orphan row left behind.
    expect(store.getState().finalCounts.length, "2 count rows total: 1 named (B) + 1 still-provisional (A)").toBe(2);
  });
});
