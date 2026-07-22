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

  // Group C item 11 (owner mandate 2026-07-21): rebuild a junky legacy name into the app's own
  // canonical display form when the tire parse is confident, so the persist migration (which reuses
  // this SAME function) can retroactively clean names saved before this fix shipped.
  describe("canonical name re-clean (Group C item 11)", () => {
    it("rebuilds a junky name into the canonical display form when brand+model+size confidently parse", () => {
      const p = product({ id: "p-junky", name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" });
      const { products, changedIds } = backfillProducts([p]);
      expect(products[0].name).toBe("Fortune FSR305 265/50R20 111T XL");
      expect(changedIds).toEqual(["p-junky"]);
    });

    it("never rewrites a name on a row stamped structuredBy human", () => {
      const p = product({
        id: "p-human", name: "Set of 4 Fortune FSR305 265/50R20 111T XL Tires", structuredBy: "human",
      });
      const { products } = backfillProducts([p]);
      expect(products[0].name).toBe(p.name);
    });

    it("never touches an already-clean name (no junk pattern present)", () => {
      const p = product({ id: "p-clean", name: "Cooper Discoverer A/T3 LT245/75R16 120R" });
      const { products } = backfillProducts([p]);
      expect(products[0].name).toBe(p.name);
    });

    it("never touches a non-tire product name", () => {
      const p = product({ id: "p-retail", name: "Member's Mark Purified Water 500ml" });
      const { products } = backfillProducts([p]);
      expect(products[0].name).toBe(p.name);
    });

    it("rewrites a name still carrying the literal '(suggested)' junk suffix", () => {
      const p = product({ id: "p-sugg", name: "Fortune FSR305 265/50R20 111T XL (suggested)" });
      const { products } = backfillProducts([p]);
      expect(products[0].name).not.toContain("(suggested)");
    });

    it("is idempotent: rewriting twice does not change the name further", () => {
      const p = product({ id: "p-idem", name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" });
      const once = backfillProducts([p]);
      const twice = backfillProducts(once.products);
      expect(twice.products[0].name).toBe(once.products[0].name);
      expect(twice.changedIds).toEqual([]);
    });

    it("never touches quantities or unrelated fields - only name/brand/category/specs/structuredModel", () => {
      const p = product({ id: "p-fields", name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires", primarySku: "KEEP-ME", location: "Bay 9" });
      const { products } = backfillProducts([p]);
      expect(products[0].primarySku).toBe("KEEP-ME");
      expect(products[0].location).toBe("Bay 9");
    });
  });

  // Bug 4 (CRITICAL mechanism, owner mandate 2026-07-21, 310-row review): a row damaged by an earlier
  // buggy enrichment pass ("Greenball Greenball Greenball Tow-Master", brand duplicated by repeated
  // apply-site + backfill passes) must self-heal on the NEXT backfill run - and running backfill twice
  // on its own output must never add another copy.
  describe("dedupe self-heal (Bug 4)", () => {
    it("dedupes a brand-duplicated legacy name on backfill", () => {
      const p = product({ id: "p-dup", name: "Greenball Greenball Greenball Tow-Master", brand: "Greenball" });
      const { products } = backfillProducts([p]);
      expect(products[0].name).toBe("Greenball Tow-Master");
    });

    it("backfill(backfill(row)) === backfill(row): running it twice never adds another brand copy", () => {
      const p = product({ id: "p-dup2", name: "Greenball Greenball Greenball Tow-Master", brand: "Greenball" });
      const once = backfillProducts([p]);
      const twice = backfillProducts(once.products);
      expect(twice.products[0].name).toBe(once.products[0].name);
      expect(twice.changedIds).toEqual([]);
    });

    it("never rewrites a duplicated name on a row stamped structuredBy human", () => {
      const p = product({
        id: "p-dup-human", name: "Greenball Greenball Greenball Tow-Master", brand: "Greenball", structuredBy: "human",
      });
      const { products } = backfillProducts([p]);
      expect(products[0].name).toBe(p.name);
    });
  });
});
