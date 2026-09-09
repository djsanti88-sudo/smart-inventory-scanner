import { describe, it, expect } from "vitest";
import { collectGroundedIdentifiers, discoverableIdentifiers } from "@/products/match/aliasDiscovery";
import type { Alias } from "@/types";

const BIZ = "demo-business";

function alias(over: Partial<Alias>): Alias {
  return {
    id: "a1", businessId: BIZ, productId: "p1", rawCodeExample: "", cleanCode: "", normalizedCode: "",
    aliasType: "sku", source: "human_review", confidence: 1, approved: true, createdAt: "", updatedAt: "",
    createdBy: "t", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "k", ...over,
  };
}

describe("collectGroundedIdentifiers", () => {
  it("collects only PRESENT identifier values; never invents; dedupes by clean code", () => {
    const g = collectGroundedIdentifiers({
      primaryBarcode: "049000028904",
      primarySku: "DCF887B",
      gtin: "00885911484047",
      upc: "", // empty -> not invented / skipped
      ean: "   ", // whitespace -> skipped
      vendorCodes: ["VC-1", "DCF887B"], // duplicate clean code skipped
      extras: ["PN-555", ""], // decode-surfaced part number; empty skipped
    });
    const codes = g.map((x) => x.cleanCode);
    expect(codes).toContain("049000028904");
    expect(codes).toContain("DCF887B");
    expect(codes).toContain("00885911484047");
    expect(codes).toContain("VC-1");
    expect(codes).toContain("PN-555");
    expect(codes.filter((c) => c === "DCF887B")).toHaveLength(1); // deduped
    expect(codes).not.toContain(""); // never an empty/fabricated code
  });

  it("returns nothing for an all-empty identity (prefer blank over fabricated)", () => {
    expect(collectGroundedIdentifiers({ primarySku: "", upc: "", extras: [] })).toHaveLength(0);
  });
});

describe("discoverableIdentifiers", () => {
  const grounded = collectGroundedIdentifiers({ upc: "049000028904", primarySku: "PN-555", gtin: "GTIN-9" });

  it("offers grounded codes that are NOT yet an approved alias anywhere", () => {
    const out = discoverableIdentifiers(grounded, [], "p1", BIZ).map((x) => x.cleanCode);
    expect(out).toEqual(expect.arrayContaining(["049000028904", "PN-555", "GTIN-9"]));
  });

  it("excludes a code already APPROVED for this product (already matchable)", () => {
    const aliases = [alias({ productId: "p1", cleanCode: "049000028904", approved: true })];
    const out = discoverableIdentifiers(grounded, aliases, "p1", BIZ).map((x) => x.cleanCode);
    expect(out).not.toContain("049000028904");
    expect(out).toContain("PN-555");
  });

  it("excludes a code approved for a DIFFERENT product (conflict; never hijack)", () => {
    const aliases = [alias({ productId: "other", cleanCode: "PN-555", approved: true })];
    const out = discoverableIdentifiers(grounded, aliases, "p1", BIZ).map((x) => x.cleanCode);
    expect(out).not.toContain("PN-555");
  });

  it("an UNapproved alias for this product is still discoverable (not yet matchable until approved)", () => {
    const aliases = [alias({ productId: "p1", cleanCode: "PN-555", approved: false })];
    const out = discoverableIdentifiers(grounded, aliases, "p1", BIZ).map((x) => x.cleanCode);
    expect(out).toContain("PN-555");
  });
});
