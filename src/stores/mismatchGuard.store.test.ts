import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// Phase 3 proof (store): linking a tire part-number code to a cigarette product is BLOCKED until the
// human explicitly overrides. The block is enforced in the store (not just the UI).

function setup() {
  const store = createTestScanStore();
  // Create a cigarette product (the wrong target).
  store.getState().processScan("0000000cig1");
  const cigReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === "0000000cig1")!;
  store.getState().resolveUnknown(cigReview.id, "create_new", {
    applyToCount: false,
    origin: "human",
    newProduct: { name: "Camel Crush Menthol Silver Cigarettes", brand: "Camel", category: "Cigarettes", primaryBarcode: "0000000cig1" },
  });
  const cigId = store.getState().products.find((p) => p.name.includes("Camel"))!.id;

  // A scan of a tire part-number code that the system has a TIRE suggestion for (as if AI/web identified it).
  store.getState().processScan("7700-tire");
  const tireReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === "7700-tire")!;
  // simulate that a lookup suggested a Falken tire for this code
  store.setState({
    needsReviewQueue: store.getState().needsReviewQueue.map((r) =>
      r.id === tireReview.id ? { ...r, suggestedProductName: "Falken Sincera ST80", suggestedBrand: "Falken", suggestedCategory: "Tire" } : r,
    ),
  });
  return { store, cigId, tireReviewId: tireReview.id };
}

describe("mismatch guard blocks wrong-product links", () => {
  it("BLOCKS linking a tire code to a cigarette product (no alias created)", () => {
    const { store, cigId, tireReviewId } = setup();
    store.getState().resolveUnknown(tireReviewId, "link_existing", { productId: cigId, applyToCount: false, origin: "human" });

    // not linked: no approved alias for the tire code under the cigarette product
    const linked = store.getState().aliases.some((a) => a.cleanCode === "7700-tire" && a.productId === cigId);
    expect(linked).toBe(false);
    // a warning was raised for the UI
    const w = store.getState().lastMismatchWarning;
    expect(w?.verdict.risk).toBe("high_risk");
    expect(w?.verdict.suggestedDomain).toBe("tire");
  });

  it("evaluateLinkMismatch reports high_risk without committing", () => {
    const { store, cigId, tireReviewId } = setup();
    const v = store.getState().evaluateLinkMismatch(tireReviewId, cigId);
    expect(v?.risk).toBe("high_risk");
  });

  it("OVERRIDE (confirmedMismatch) links it and records the override", () => {
    const { store, cigId, tireReviewId } = setup();
    store.getState().resolveUnknown(tireReviewId, "link_existing", { productId: cigId, applyToCount: false, origin: "human", confirmedMismatch: true });
    const linked = store.getState().aliases.some((a) => a.cleanCode === "7700-tire" && a.productId === cigId);
    expect(linked).toBe(true);
    expect(store.getState().lastMismatchWarning).toBeNull(); // cleared on successful link
  });
});
