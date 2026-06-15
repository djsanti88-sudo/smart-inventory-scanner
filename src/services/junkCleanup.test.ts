import { describe, it, expect } from "vitest";
import { findJunkCounts } from "@/services/junkCleanup";
import type { InventoryCount, Product } from "@/types";

function product(id: string, name: string): Product {
  return {
    id,
    businessId: "b",
    name,
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: "",
    status: "active",
    source: "human_review",
    confidence: 1,
    verified: true,
    createdAt: "t",
    updatedAt: "t",
    createdBy: "x",
    updatedBy: "x",
  };
}

function count(id: string, productId: string, quantity = 1): InventoryCount {
  return {
    id,
    businessId: "b",
    sessionId: "s",
    productId,
    quantity,
    lastScannedAt: "t",
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: "t",
    updatedAt: "t",
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: [],
  };
}

describe("findJunkCounts", () => {
  it("flags counts whose product name is a website/junk title, keeps good rows", () => {
    const products = [
      product("p-good", "BIC Classic Pocket Lighter"),
      product("p-junk", "UPC Barcode Search — Look up any UPC, EAN, or ISBN"),
      product("p-junk2", "EANdata"),
    ];
    const counts = [count("c-good", "p-good", 3), count("c-junk", "p-junk", 1), count("c-junk2", "p-junk2", 2)];

    const plan = findJunkCounts(counts, products);

    expect(plan.junkCountIds.sort()).toEqual(["c-junk", "c-junk2"]);
    expect(plan.junkProductIds.sort()).toEqual(["p-junk", "p-junk2"]);
    expect(plan.junkPreview).toContainEqual({ productId: "p-junk2", name: "EANdata", quantity: 2 });
  });

  it("treats an orphan count (product missing) as junk", () => {
    const plan = findJunkCounts([count("c-orphan", "p-gone")], [product("p-good", "Real Thing")]);
    expect(plan.junkCountIds).toEqual(["c-orphan"]);
  });

  it("returns nothing for an all-good inventory", () => {
    const products = [product("p1", "Coca-Cola Classic"), product("p2", "Camel Crush Box")];
    const counts = [count("c1", "p1"), count("c2", "p2")];
    const plan = findJunkCounts(counts, products);
    expect(plan.junkCountIds).toEqual([]);
    expect(plan.junkProductIds).toEqual([]);
  });

  it("does NOT mark a product for removal if a surviving good count still references it", () => {
    // Same product referenced by a junk-id count and a good-id count (defensive guard).
    const products = [product("p-shared", "Real Product Name")];
    const counts = [count("c-keep", "p-shared", 5)];
    const plan = findJunkCounts(counts, products);
    // name is usable -> not junk at all
    expect(plan.junkProductIds).toEqual([]);
  });
});
