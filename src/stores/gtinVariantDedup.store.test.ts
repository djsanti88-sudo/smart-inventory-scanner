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
  it("does not use a shared part number to link a checksum-valid EAN-8 scan to an existing product", () => {
    // 96385074 is GS1's valid EAN-8 example. It is eight digits, but that does not make it a
    // numeric part-number scan: the decoded part number belongs to a distinct barcode identity.
    const store = createTestScanStore({ db: new MockDb() });
    const existing = store.getState().products.find((p) => p.id === "prod-coke")!;
    store.setState((s) => ({
      products: s.products.map((p) => p.id === existing.id ? { ...p, primarySku: "SHARED-MPN" } : p),
    }));

    store.getState().processScan("96385074");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "96385074" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Distinct EAN-8 item", primarySku: "SHARED-MPN" },
    });

    const scannedRow = store.getState().scanFeed.find((event) => event.cleanCode === "96385074")!;
    expect(scannedRow.matchedProductId).not.toBe(existing.id);
    expect(qtyFor(store, existing.id)).toBe(0);
    expect(qtyFor(store, scannedRow.matchedProductId!)).toBe(1);
  });

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

    // Model a persisted orphan directly: its alias and verified flag have been stripped while its count
    // survives. That deliberately rules out both resolver aliases and processScan's provisional bridge.
    store.getState().processScan("ORPHAN-SEED-1");
    const seedReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === "ORPHAN-SEED-1" && r.status === "open")!;
    const p1 = seedReview.provisionalProductId!;
    store.setState((s) => ({
      products: s.products.map((p) => p.id === p1 ? {
        ...p,
        name: "Counted provisional orphan",
        primaryBarcode: "ORPHAN-SEED-1",
        primarySku: "",
        gtin: "848983027580",
        upc: "",
        ean: "",
        aliases: [],
        provisional: true,
        verified: false,
      } : p),
      aliases: s.aliases.filter((a) => a.productId !== p1),
    }));
    expect(qtyFor(store, p1)).toBe(1);
    expect(store.getState().products.find((p) => p.id === p1)?.aliases).toEqual([]);

    // A different physical scan creates its own provisional placeholder before resolution. The only
    // legitimate way to reuse p1 is the orphaned-count identifier comparison below resolveUnknown.
    store.getState().processScan("FRESH-OTHER-2");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "FRESH-OTHER-2" && r.status === "open")!;
    expect(review2.provisionalProductId).not.toBe(p1);
    expect(qtyFor(store, review2.provisionalProductId!)).toBe(1);
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review2.id ? { ...r, hasSuggestion: true, suggestedProductName: "Different opaque decode" } : r,
      ),
    }));
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Different opaque decode", gtin: "00848983027580" },
    });

    const countedRows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(countedRows.length, "the zero-padded-GTIN decode reuses the existing provisional product, no duplicate row").toBe(1);
    expect(countedRows[0].id).toBe(p1);
    expect(qtyFor(store, p1), "quantity aggregates (1 + 1 = 2)").toBe(2);
    expect(store.getState().finalCounts.find((c) => c.productId === p1)?.scanEventIds).toHaveLength(2);
    expect(store.getState().scanFeed.filter((e) => e.matchedProductId === p1)).toHaveLength(2);
  });

  it("resolveUnknown orphaned-count dedup keeps case-pack GTINs and leading-zero MPNs distinct", () => {
    const resolveAgainstOrphan = (params: {
      existingGtin?: string;
      existingSku?: string;
      decodedGtin?: string;
      decodedSku?: string;
      freshCode: string;
    }) => {
      const store = createTestScanStore({ db: new MockDb() });
      store.getState().processScan("ORPHAN-SEED-1");
      const seed = store.getState().needsReviewQueue.find((r) => r.cleanCode === "ORPHAN-SEED-1" && r.status === "open")!;
      const orphanId = seed.provisionalProductId!;
      store.setState((s) => ({
        products: s.products.map((p) => p.id === orphanId ? {
          ...p,
          name: "Counted provisional orphan",
          primaryBarcode: "ORPHAN-SEED-1",
          primarySku: params.existingSku ?? "",
          gtin: params.existingGtin ?? "",
          upc: "",
          ean: "",
          aliases: [],
          provisional: true,
          verified: false,
        } : p),
        aliases: s.aliases.filter((a) => a.productId !== orphanId),
      }));
      store.getState().processScan(params.freshCode);
      const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === params.freshCode && r.status === "open")!;
      store.setState((s) => ({
        needsReviewQueue: s.needsReviewQueue.map((r) =>
          r.id === review.id ? { ...r, hasSuggestion: true, suggestedProductName: "Different opaque decode" } : r,
        ),
      }));
      store.getState().resolveUnknown(review.id, "create_new", {
        applyToCount: true,
        origin: "ai",
        newProduct: { name: "Different opaque decode", gtin: params.decodedGtin, primarySku: params.decodedSku },
      });
      return store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    };

    // Indicator digit 1 identifies a GTIN-14 case pack, not a zero-padded unit GTIN.
    expect(resolveAgainstOrphan({
      existingGtin: "10848983027587",
      decodedGtin: "00848983027580",
      freshCode: "FRESH-OTHER-2",
    })).toHaveLength(2);

    // A five-digit MPN is not GTIN-shaped, so its leading zero remains identity-significant.
    expect(resolveAgainstOrphan({
      existingSku: "0012345",
      decodedSku: "12345",
      freshCode: "98765",
    })).toHaveLength(2);
  });
});
