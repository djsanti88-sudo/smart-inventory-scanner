import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// B2 regression (owner-reported, 268-row review, 2026-07-20): 848983027580 appeared as a SEPARATE
// counted product row from 00848983027580 (and 0877184000481 vs 877184000481) - the same physical
// GTIN in two zero-padding encodings minted TWO product rows instead of merging into one with an
// aggregated quantity. Several deterministic layers already cooperate to merge most GTIN-variant
// rescans (processScan's provisional-match bridge and scanCleaner's own GTIN-padded
// normalizedCandidates cover a re-scan of the same raw code; findIdentityMerge/multi-code aliasing
// cover most create_new mints). The one gap that survived ALL of those: resolveUnknown's own
// "ORPHANED-COUNT DEDUP" block (scanStore.ts, inside the create_new dedup guard) compared a still-
// counted PROVISIONAL product's identifier fields with raw string equality (`.trim()`), never
// canonicalGtin - the only path standing between a still-counted provisional row and a duplicate
// mint, since provisional products are deliberately excluded from the verified-only resolver tier and
// from findIdentityMerge's candidate pool. Fixed to canonicalize both sides before comparing, the
// SAME key universal import already uses (aggKeyFor, ~scanStore.ts:5282).

const qtyFor = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

describe("scanStore - canonical-GTIN dedup across leading-zero variants", () => {
  it("ensureProvisionalCount: scanning the zero-padded variant of an already-counted code reuses the same product", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // First scan: a 12-digit UPC-A, unknown -> provisional placeholder counted once.
    store.getState().processScan("848983027580");
    const rows1 = store.getState().products.filter((p) => p.primaryBarcode === "848983027580");
    expect(rows1.length, "first scan mints exactly one provisional row").toBe(1);
    const p1 = rows1[0];
    expect(qtyFor(store, p1.id)).toBe(1);

    // Second scan: the SAME physical GTIN, zero-padded to 14 digits (the canonical EAN/GTIN-14 form).
    store.getState().processScan("00848983027580");

    const countedRows = store.getState().products.filter(
      (p) => p.status !== "archived" && qtyFor(store, p.id) > 0,
    );
    expect(countedRows.length, "the zero-padded variant reuses the SAME product row, not a duplicate").toBe(1);
    expect(qtyFor(store, p1.id), "quantity aggregates onto the existing row (1 + 1 = 2)").toBe(2);
  });

  it("ensureProvisionalCount: reversed order (13-digit scanned first) still merges with the 12-digit variant", () => {
    const store = createTestScanStore({ db: new MockDb() });

    store.getState().processScan("0877184000481");
    const rows1 = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(rows1.length).toBe(1);

    store.getState().processScan("877184000481");

    const countedRows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(countedRows.length, "still exactly one counted row for the shared GTIN identity").toBe(1);
    expect(countedRows[0].id).toBe(rows1[0].id);
    expect(qtyFor(store, rows1[0].id)).toBe(2);
  });

  it("resolveUnknown orphaned-count dedup: a PROVISIONAL (unverified) counted product's zero-padded GTIN variant reuses it, never duplicates", () => {
    // Provisional (unverified) products are deliberately excluded from resolveScanToProductTiered's
    // verified-only gate AND from findIdentityMerge's candidate pool (identityMerge.ts: `provisional
    // !== true`) - both intentional trust-gate exclusions (an unconfirmed AI guess must not become
    // deterministic identity or a merge target for ANOTHER guess). That leaves the "ORPHANED-COUNT
    // DEDUP" raw-equality block as the ONLY dedup mechanism standing between a still-counted provisional
    // product and a duplicate mint on its zero-padded GTIN variant - exactly the gap this test targets.
    const store = createTestScanStore({ db: new MockDb() });

    // First scan: an evidence-less AI suggestion (no brand/gtin/upc/ean/sourceUrls) that the human/auto
    // path accepts verbatim - isWeakGuess() keeps the minted product provisional + unverified, but it IS
    // counted (owner rule: scan N = count N).
    store.getState().processScan("VENDORCODE-XYZ-1");
    const review1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-XYZ-1" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review1.id ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402" } : r,
      ),
    }));
    store.getState().resolveUnknown(review1.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", gtin: "848983027580" },
    });
    const firstRows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(firstRows.length).toBe(1);
    const p1 = firstRows[0];
    expect(p1.provisional, "the evidence-less guess stays provisional (poison guard)").toBe(true);
    expect(p1.verified, "the evidence-less guess stays unverified (poison guard)").toBe(false);
    expect(p1.gtin).toBe("848983027580");

    // A second, DIFFERENT scanned code decodes to the zero-padded variant of the SAME GTIN, with the
    // same evidence-less suggestion shape (still not enough to auto-verify).
    store.getState().processScan("VENDORCODE-XYZ-2");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-XYZ-2" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review2.id ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402" } : r,
      ),
    }));
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", gtin: "00848983027580" },
    });

    const countedRows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(countedRows.length, "the zero-padded-GTIN decode reuses the existing provisional product, no duplicate row").toBe(1);
    expect(countedRows[0].id).toBe(p1.id);
    expect(qtyFor(store, p1.id), "quantity aggregates (1 + 1 = 2)").toBe(2);
  });

  it("resolveUnknown orphaned-count dedup: with NO alias left (customer-safe persist shape), the zero-padded GTIN variant still reuses the counted provisional row", () => {
    // The previous test is green through the alias tier: the first create_new mints an approved
    // multi-code alias for the GTIN, so resolveScanToProductTiered merges the rows before the
    // orphaned-count comparison is ever consulted. This test removes that rescue to pin the block the
    // B2 fix actually describes: a counted provisional product whose approved aliases AND verified
    // flag were stripped by the customer-safe persist, carrying the 14-digit GTIN, then a decode of
    // the 12-digit encoding. Provisional rows are excluded from the verified-identifier tier and from
    // findIdentityMerge, so ONLY the orphaned-count block can prevent a duplicate mint, and it can
    // only do so if it compares canonical GTINs rather than raw strings.
    const store = createTestScanStore({ db: new MockDb() });

    store.getState().processScan("VENDORCODEAAA1");
    const p1 = store.getState().products.find((p) => qtyFor(store, p.id) > 0)!;
    expect(qtyFor(store, p1.id)).toBe(1);

    store.setState((s) => ({
      products: s.products.map((p) =>
        p.id === p1.id ? { ...p, gtin: "00848983027580", verified: false, provisional: true } : p,
      ),
      aliases: [],
    }));

    store.getState().processScan("VENDORCODEBBB2");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODEBBB2" && r.status === "open")!;
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", gtin: "848983027580" },
    });

    const countedRows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(countedRows.length, "12-digit decode of a counted 14-digit GTIN reuses the row, no duplicate").toBe(1);
    expect(countedRows[0].id).toBe(p1.id);
    expect(qtyFor(store, p1.id), "quantity aggregates (1 + 1 = 2)").toBe(2);
  });
});
