import { describe, it, expect } from "vitest";
import { backfillProducts } from "@/services/polish/backfillProducts";
import type { Product } from "@/types";

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "b", name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

describe("backfillProducts", () => {
  it("structures every row that has no structuredBy stamp", () => {
    const p = product({ id: "p1", name: "Cooper Discoverer AT3 265/70R17", brand: "Cooper" });
    const { products, changedIds, skippedHumanIds } = backfillProducts([p]);
    expect(products[0].structuredBrand).toBe("Cooper");
    expect(products[0].sizeTag).toBe("2657017");
    expect(products[0].structuredBy).toBe("deterministic");
    expect(changedIds).toEqual(["p1"]);
    expect(skippedHumanIds).toEqual([]);
  });

  it("SKIPS a row whose structuredBy is human (never overwrites a human correction)", () => {
    const p = product({
      id: "p2", name: "Cooper Discoverer AT3 265/70R17", brand: "Cooper",
      structuredBy: "human", structuredBrand: "Cooper Tires", structuredModel: "Discoverer Special",
    });
    const { products, changedIds, skippedHumanIds } = backfillProducts([p]);
    expect(products[0]).toEqual(p); // byte-for-byte unchanged
    expect(changedIds).toEqual([]);
    expect(skippedHumanIds).toEqual(["p2"]);
  });

  it("is idempotent: running it twice on its own output changes nothing the second time", () => {
    const p = product({ id: "p3", name: "Michelin Defender 225/65R17", brand: "Michelin" });
    const first = backfillProducts([p]);
    const second = backfillProducts(first.products);
    expect(second.changedIds).toEqual([]);
    expect(second.products).toEqual(first.products);
  });

  it("processes a mixed batch: structures the plain rows, skips the human row", () => {
    const plain = product({ id: "a", name: "Falken Wildpeak AT3W 225/45R17", brand: "Falken" });
    const human = product({ id: "b", name: "Weird Name", brand: "", structuredBy: "human" });
    const { changedIds, skippedHumanIds } = backfillProducts([plain, human]);
    expect(changedIds).toEqual(["a"]);
    expect(skippedHumanIds).toEqual(["b"]);
  });
});
