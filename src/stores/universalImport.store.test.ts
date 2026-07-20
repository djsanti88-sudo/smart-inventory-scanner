import { describe, expect, it } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { ImportPreviewRow } from "@/services/importSchema";

function previewRow(status: "exact" | "fuzzy", code: string, quantity: number): ImportPreviewRow {
  return {
    line: 2,
    status,
    reason: status === "exact" ? "Part number hit for exact candidate." : "Character-level fuzzy candidate.",
    confidence: status === "exact" ? 1 : 0.8,
    candidate: { uid: `uid-${code}`, brand: "Acme", name: "Road", partNumber: code },
    source: {
      line: 2,
      partNumber: code,
      barcode: "",
      name: "",
      brand: "Acme",
      model: "Road",
      size: "225/45R18",
      category: "Tires",
      quantity,
      uom: "each",
      expected: {
        externalId: code,
        partNumbers: [code],
        brand: "Acme",
        model: "Road",
        sizeText: "225/45R18",
        qty: quantity,
        raw: {},
      },
    },
  };
}

describe("applyUniversalImport", () => {
  it("does not write until called, then exact rows approve and apply the full quantity", () => {
    const store = createTestScanStore();
    const before = store.getState();
    expect(before.finalCounts).toEqual([]);
    expect(before.needsReviewQueue).toEqual([]);
    const summary = before.applyUniversalImport([previewRow("exact", "PN-EXACT-1", 3)]);
    expect(summary).toEqual({ applied: 1, queuedForReview: 0, rejected: 0 });
    const after = store.getState();
    expect(after.aliases.some((alias) => alias.cleanCode === "PN-EXACT-1" && alias.approved)).toBe(true);
    expect(after.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(3);
    expect(after.countSnapshots).toHaveLength(2);
  });

  it("routes fuzzy rows to Needs Review without alias or quantity, then human confirmation applies quantity", () => {
    const store = createTestScanStore();
    const summary = store.getState().applyUniversalImport([previewRow("fuzzy", "PN-FUZZY-1", 4)]);
    expect(summary).toEqual({ applied: 0, queuedForReview: 1, rejected: 0 });
    let state = store.getState();
    const review = state.needsReviewQueue.find((item) => item.cleanCode === "PN-FUZZY-1");
    expect(review?.importQuantity).toBe(4);
    expect(state.aliases.some((alias) => alias.cleanCode === "PN-FUZZY-1")).toBe(false);
    expect(state.finalCounts).toEqual([]);

    state.resolveUnknown(review!.id, "create_new", {
      origin: "human",
      applyToCount: true,
      newProduct: { name: review!.suggestedProductName, brand: review!.suggestedBrand },
    });
    state = store.getState();
    expect(state.aliases.some((alias) => alias.cleanCode === "PN-FUZZY-1" && alias.approved)).toBe(true);
    expect(state.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(4);
  });

  // C4 correction (plan-review-mandated): Phase 4 must make ZERO /api/ai-lookup calls. An import-origin
  // review must never call liveDecode / correctionRecheck. The store-level contract for that is that a
  // review created via applyUniversalImport (queued-for-review path) carries importQuantity !== undefined,
  // which NeedsReviewTable keys its "hide live-decode/correction-recheck" behavior on. This test proves the
  // store actually sets that marker on the created review (the component test proves the UI honors it).
  it("marks a queued-for-review row with importQuantity so the UI can identify it as import-origin (C4)", () => {
    const store = createTestScanStore();
    store.getState().applyUniversalImport([previewRow("fuzzy", "PN-C4-1", 2)]);
    const review = store.getState().needsReviewQueue.find((item) => item.cleanCode === "PN-C4-1");
    expect(review).toBeDefined();
    expect(review?.importQuantity).toBe(2);
  });

  // C5 correction (plan-review-mandated): reopenNeedsReview reuses the FIRST review sharing a cleanCode,
  // so two import rows sharing a code would overwrite (not sum) importQuantity and silently drop one row's
  // quantity. applyUniversalImport must aggregate rows by cleanCode BEFORE creating reviews/counts so one
  // unique code yields exactly one review/count carrying the TOTAL quantity.
  it("aggregates duplicate-cleanCode rows into one review/count carrying the summed quantity (C5)", () => {
    const store = createTestScanStore();
    const rowA = previewRow("fuzzy", "PN-DUP-1", 2);
    const rowB = previewRow("fuzzy", "PN-DUP-1", 3);
    const summary = store.getState().applyUniversalImport([rowA, rowB]);
    // One unique code -> one queued review, not two.
    expect(summary).toEqual({ applied: 0, queuedForReview: 1, rejected: 0 });
    const state = store.getState();
    const matching = state.needsReviewQueue.filter((item) => item.cleanCode === "PN-DUP-1");
    expect(matching).toHaveLength(1);
    expect(matching[0].importQuantity).toBe(5);

    // Confirming it applies the FULL summed quantity, not just the last row's.
    state.resolveUnknown(matching[0].id, "create_new", {
      origin: "human",
      applyToCount: true,
      newProduct: { name: matching[0].suggestedProductName, brand: matching[0].suggestedBrand },
    });
    const after = store.getState();
    expect(after.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(5);
  });

  // C5 also applies to the exact/auto-approved path: duplicate exact rows must sum before the
  // human-origin create path counts them, not double-create or overwrite.
  it("aggregates duplicate-cleanCode EXACT rows into one applied count carrying the summed quantity (C5)", () => {
    const store = createTestScanStore();
    const rowA = previewRow("exact", "PN-DUP-EXACT", 2);
    const rowB = previewRow("exact", "PN-DUP-EXACT", 3);
    const summary = store.getState().applyUniversalImport([rowA, rowB]);
    expect(summary).toEqual({ applied: 1, queuedForReview: 0, rejected: 0 });
    const after = store.getState();
    const aliasMatches = after.aliases.filter((alias) => alias.cleanCode === "PN-DUP-EXACT" && alias.approved);
    expect(aliasMatches).toHaveLength(1);
    expect(after.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(5);
  });
});
