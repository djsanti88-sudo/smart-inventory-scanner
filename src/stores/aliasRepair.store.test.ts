import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// Phase 4 proof: an alias accidentally linked to the wrong product can be UNLINKED (stops resolving)
// or MOVED to the correct product, without deleting scan history.

function makeProductWithCode(store: ReturnType<typeof createTestScanStore>, barcode: string, name: string) {
  store.getState().processScan(barcode);
  const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === barcode)!;
  store.getState().resolveUnknown(r.id, "create_new", { applyToCount: false, origin: "human", newProduct: { name, primaryBarcode: barcode } });
  return store.getState().products.find((p) => p.name === name)!.id;
}

describe("alias repair (unlink / move)", () => {
  it("UNLINK stops a bad alias from resolving to the wrong product", () => {
    const store = createTestScanStore();
    const cigId = makeProductWithCode(store, "000cigbad1", "Camel Crush Menthol Silver Cigarettes");
    // bad link: a tire code wrongly linked to the cigarette product
    store.getState().processScan("770000tire1");
    const tireReview = store.getState().needsReviewQueue.find((x) => x.cleanCode === "770000tire1")!;
    store.getState().resolveUnknown(tireReview.id, "link_existing", { productId: cigId, applyToCount: false, origin: "human" });
    const badAlias = store.getState().aliases.find((a) => a.cleanCode === "770000tire1" && a.productId === cigId)!;
    expect(store.getState().processScan("770000tire1")?.matchedProductId).toBe(cigId); // currently resolves wrong

    store.getState().unlinkAlias(badAlias.id);
    const res = store.getState().processScan("770000tire1");
    expect(res?.resolverStatus).not.toBe("known"); // no longer resolves to cigarettes
    expect(res?.matchedProductId).toBeNull();
  });

  it("MOVE re-points a bad alias to the correct product", () => {
    const store = createTestScanStore();
    const cigId = makeProductWithCode(store, "000cigbad2", "Camel Crush Menthol Silver Cigarettes");
    const tireId = makeProductWithCode(store, "848000falken", "Falken Sincera ST80");
    store.getState().processScan("770000tire2");
    const tireReview = store.getState().needsReviewQueue.find((x) => x.cleanCode === "770000tire2")!;
    store.getState().resolveUnknown(tireReview.id, "link_existing", { productId: cigId, applyToCount: false, origin: "human" });
    const badAlias = store.getState().aliases.find((a) => a.cleanCode === "770000tire2" && a.productId === cigId)!;

    store.getState().moveAlias(badAlias.id, tireId);
    const res = store.getState().processScan("770000tire2");
    expect(res?.resolverStatus).toBe("known");
    expect(res?.matchedProductId).toBe(tireId); // now resolves to the correct tire
  });
});
