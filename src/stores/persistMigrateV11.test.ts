import { describe, it, expect } from "vitest";
import { scanStoreMigrate } from "@/stores/scanStore";
import type { Product } from "@/types";

// v10 -> v11 persist migration (Group C item 11, owner mandate 2026-07-21): re-clean existing
// product names on rehydrate. For each row NOT stamped structuredBy "human", rebuild its name via
// cleanListingTitle + the assembled canonicalTireDisplayName when the tire parse is confident
// (brand+model+size, matching enrichProductIdentity's own rule) - so a row saved BEFORE this fix
// shipped (raw junky listing text as its `name`) gets the ONE canonical display format retroactively.
// A row whose name is already clean (no junk pattern match) is left untouched (conservative
// "someone already fixed this" proxy, since Product has no separate manuallyEdited flag beyond
// structuredBy: "human"). Quantities/ledger fields must be completely untouched.

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "b1", name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

describe("scanStoreMigrate - v10 -> v11 canonical name re-clean (Group C item 11)", () => {
  it("rebuilds a junky legacy name into the canonical display form when the tire parse is confident", () => {
    const junkyRow = product({
      id: "p-junky",
      name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires",
      brand: "", category: "", specsShort: "", specsFull: "",
    });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [junkyRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-junky")!;

    expect(row.name).toBe("Fortune FSR305 265/50R20 111T XL");
  });

  it("never rewrites a row stamped structuredBy human, even if its name still contains junk patterns", () => {
    const humanRow = product({
      id: "p-human",
      name: "Set of 4 Fortune FSR305 265/50R20 111T XL Tires",
      structuredBy: "human",
      structuredModel: "Custom Human Model",
    });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [humanRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-human")!;

    expect(row.name).toBe("Set of 4 Fortune FSR305 265/50R20 111T XL Tires");
  });

  it("never touches a name that is already clean (no junk pattern, no confident-parse trigger needed twice)", () => {
    const cleanRow = product({ id: "p-clean", name: "Cooper Discoverer A/T3 LT245/75R16 120R" });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [cleanRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-clean")!;

    // Already confidently tire-parseable AND already clean - canonical assembly is a no-op here
    // (brand/model/size assemble back to the same string), so this also incidentally proves
    // idempotency on an already-canonical name.
    expect(row.name).toBe("Cooper Discoverer A/T3 LT245/75R16 120R");
  });

  it("never touches a non-tire product name (no confident parse, no junk pattern)", () => {
    const retailRow = product({ id: "p-retail", name: "Member's Mark Purified Water 500ml" });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [retailRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-retail")!;

    expect(row.name).toBe("Member's Mark Purified Water 500ml");
  });

  it("also fills specs/category via enrichProductIdentity fill-if-empty for a rewritten row", () => {
    const junkyRow = product({
      id: "p-junky2",
      name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires",
      brand: "", category: "", specsShort: "", specsFull: "",
    });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [junkyRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-junky2")!;

    expect(row.brand).toBe("Fortune");
    expect(row.category).toBe("Tire");
    expect(row.specsShort).toBe("265/50R20 111T XL");
  });

  it("quantity/count/ledger fields are byte-identical before and after migrate on a row whose name DID get rewritten", () => {
    const junkyRow = product({
      id: "p-junky3",
      name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires",
    });
    const finalCounts = [{ id: "c1", productId: "p-junky3", quantity: 7, scanEventIds: ["se1", "se2"] }];

    const persisted = { businessId: "b1", products: [junkyRow], finalCounts };
    const migrated = scanStoreMigrate(persisted, 10) as unknown as {
      products: Product[];
      finalCounts: Array<{ quantity: number; scanEventIds: string[] }>;
    };

    const row = migrated.products.find((p) => p.id === "p-junky3")!;
    expect(row.name).not.toBe(junkyRow.name); // sanity: the rewrite really happened
    expect(migrated.finalCounts).toEqual(finalCounts);
    expect(migrated.finalCounts[0].quantity).toBe(7);
    expect(migrated.finalCounts[0].scanEventIds).toEqual(["se1", "se2"]);
  });

  it("is idempotent: running the v10->v11 migration twice does not change an already-rewritten name further", () => {
    const junkyRow = product({ id: "p-idem", name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" });
    const once = scanStoreMigrate({ businessId: "b1", products: [junkyRow] }, 10) as unknown as { products: Product[] };
    const twice = scanStoreMigrate(once, 10) as unknown as { products: Product[] };

    expect(twice.products.find((p) => p.id === "p-idem")).toEqual(once.products.find((p) => p.id === "p-idem"));
  });

  it("rewrites a name still carrying a literal '(suggested)' suffix junk marker", () => {
    const suggestedRow = product({ id: "p-sugg", name: "Fortune FSR305 265/50R20 111T XL (suggested)" });

    const migrated = scanStoreMigrate({ businessId: "b1", products: [suggestedRow] }, 10) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-sugg")!;

    expect(row.name).not.toContain("(suggested)");
  });
});
