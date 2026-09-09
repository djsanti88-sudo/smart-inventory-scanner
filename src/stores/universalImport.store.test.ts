import { describe, expect, it } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { ImportPreviewRow } from "@/import/importSchema";

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

// Finding 3 (P4 ultra-review HIGH): builds a row that shares its raw aggregation key (falls back to
// `name` because barcode/partNumber are both blank) with another row, but resolves to a DIFFERENT
// product identity (distinct candidate.uid + brand). Used to prove divergent-identity collisions are
// no longer silently merged under the first row's identity.
function nameFallbackRow(uid: string, brand: string, name: string, quantity: number): ImportPreviewRow {
  return {
    line: 2,
    status: "fuzzy",
    reason: "Character-level fuzzy candidate.",
    confidence: 0.8,
    candidate: { uid, brand, name },
    source: {
      line: 2,
      partNumber: "",
      barcode: "",
      name,
      brand,
      model: "",
      size: "",
      category: "Tires",
      quantity,
      uom: "each",
      expected: {
        externalId: "",
        partNumbers: [],
        brand,
        model: "",
        sizeText: "",
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

  // Finding 3 (P4 ultra-review HIGH): a single normal row (no collision at all) must keep working
  // exactly as before - the divergence guard must not change behavior for the common case.
  it("still applies a single normal row with no key collision (Finding 3 regression guard)", () => {
    const store = createTestScanStore();
    const summary = store.getState().applyUniversalImport([previewRow("exact", "PN-SOLO-1", 7)]);
    expect(summary).toEqual({ applied: 1, queuedForReview: 0, rejected: 0 });
    const after = store.getState();
    expect(after.aliases.some((alias) => alias.cleanCode === "PN-SOLO-1" && alias.approved)).toBe(true);
    expect(after.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(7);
  });

  // Finding 3 (P4 ultra-review HIGH, CONFIRMED): two rows share the same raw aggregation key (both fall
  // back to the generic name "Tire" because barcode/partNumber are blank) but resolve to GENUINELY
  // DIFFERENT products (different candidate.uid/brand). Before the fix, row B's identity was silently
  // discarded and its quantity misattributed to row A's identity via a bare `existing.quantity +=`.
  // After the fix, a divergent collision must route BOTH rows to Needs Review under their OWN identity
  // and must never sum quantities under a single wrong identity.
  it("routes a same-key but DIFFERENT-identity collision to review instead of silently merging (Finding 3)", () => {
    const store = createTestScanStore();
    const rowA = nameFallbackRow("uid-michelin-tire", "Michelin", "Tire", 4);
    const rowB = nameFallbackRow("uid-goodyear-tire", "Goodyear", "Tire", 6);
    const summary = store.getState().applyUniversalImport([rowA, rowB]);

    // Neither row may be silently merged into a single applied/queued entry carrying 10 units.
    expect(summary.applied).toBe(0);
    // Both divergent rows must be queued for review (never auto-applied, never dropped).
    expect(summary.queuedForReview).toBe(2);
    expect(summary.rejected).toBe(0);

    const state = store.getState();
    const reviews = state.needsReviewQueue.filter((item) => item.cleanCode.toLowerCase().includes("tire"));
    // Two distinct review rows, one per genuine identity - never collapsed into one.
    expect(reviews.length).toBeGreaterThanOrEqual(2);

    const michelinReview = reviews.find((r) => r.suggestedBrand === "Michelin");
    const goodyearReview = reviews.find((r) => r.suggestedBrand === "Goodyear");
    expect(michelinReview).toBeDefined();
    expect(goodyearReview).toBeDefined();
    // Each review keeps its OWN quantity - never blended into the other's total.
    expect(michelinReview?.importQuantity).toBe(4);
    expect(goodyearReview?.importQuantity).toBe(6);
    // No count may have been silently created carrying a misattributed quantity.
    expect(state.finalCounts).toEqual([]);
    // The honest reason must explain the conflict rather than reporting a normal fuzzy match.
    expect(michelinReview?.reason.toLowerCase()).toMatch(/more than one product|conflict|confirm/);
    expect(goodyearReview?.reason.toLowerCase()).toMatch(/more than one product|conflict|confirm/);
  });
});
