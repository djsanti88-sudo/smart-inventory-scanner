import { describe, it, expect } from "vitest";
import { resolveRawScan } from "@/services/resolver";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import type { Alias, Product } from "@/types";

const { products, aliases } = getSeed();
const resolve = (raw: string, p: Product[] = products, a: Alias[] = aliases) =>
  resolveRawScan(raw, p, a, DEMO_BUSINESS_ID);

function product(overrides: Partial<Product>): Product {
  return {
    id: "p",
    businessId: DEMO_BUSINESS_ID,
    name: "",
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
    source: "manual",
    confidence: 1,
    verified: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    updatedBy: "",
    ...overrides,
  };
}

function alias(overrides: Partial<Alias>): Alias {
  return {
    id: "a",
    businessId: DEMO_BUSINESS_ID,
    productId: "p",
    rawCodeExample: "",
    cleanCode: "",
    normalizedCode: "",
    aliasType: "barcode",
    source: "manual",
    confidence: 1,
    approved: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    lastSeenAt: "",
    syncStatus: "synced",
    idempotencyKey: "",
    ...overrides,
  };
}

describe("REGRESSION: bad mappings must never happen", () => {
  it("855724007602 never resolves to a wrong product; it goes to Needs Review", () => {
    const r = resolve("855724007602");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
  });

  it("078742051451 never resolves to a wrong product; it goes to Needs Review", () => {
    const r = resolve("078742051451");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
  });

  it("855724007602 may resolve to a product ONLY if a verified seed/manual record exists for it", () => {
    const verifiedSeed = product({ id: "verified-creamer", name: "Verified Creamer", upc: "855724007602", verified: true });
    const r = resolve("855724007602", [...products, verifiedSeed], aliases);
    // With a verified product carrying that UPC, it is Known and points to the VERIFIED record.
    expect(r.resolverStatus).toBe("known");
    expect(r.productId).toBe("verified-creamer");
  });
});

describe("X00/Amazon/vendor label rules", () => {
  it("classifies X004DY7YUT as a vendor label, not a barcode", () => {
    expect(resolve("X004DY7YUT").codeType).toBe("vendor_label");
  });

  it("routes X004DY7YUT to Needs Review when no approved alias exists", () => {
    const r = resolve("X004DY7YUT");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.reason.toLowerCase()).toContain("label");
  });

  it("resolves a vendor label to Known once a human-approved alias links it", () => {
    const linked = alias({ cleanCode: "X004DY7YUT", normalizedCode: "X004DY7YUT", productId: "prod-coke", approved: true });
    const r = resolve("X004DY7YUT", products, [...aliases, linked]);
    expect(r.resolverStatus).toBe("known");
    expect(r.productId).toBe("prod-coke");
  });

  it("P4: an X00 FNSKU gets the honest Amazon-fulfillment-label copy (not a public barcode)", () => {
    const r = resolve("X004DY7YUT");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.reason).toBe(
      "Amazon fulfillment label (FNSKU). Not a public barcode - resolve via your Amazon inventory.",
    );
  });

  it("P4: a B0 ASIN keeps the generic vendor-label copy (only X00 FNSKUs get the FNSKU copy)", () => {
    const r = resolve("B004DY7YUT");
    expect(r.codeType).toBe("vendor_label");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.reason).not.toContain("FNSKU");
    expect(r.reason.toLowerCase()).toContain("label");
  });
});

describe("trust gates", () => {
  it("an UNAPPROVED alias never yields Known", () => {
    const unapproved = alias({ cleanCode: "PENDING1", normalizedCode: "PENDING1", productId: "prod-coke", approved: false });
    const r = resolve("PENDING1", products, [...aliases, unapproved]);
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
  });

  it("an UNVERIFIED product identifier never yields Known", () => {
    const unverified = product({ id: "ai-guess", name: "AI Guess", upc: "111222333444", verified: false });
    const r = resolve("111222333444", [...products, unverified], aliases);
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
  });

  it("a verified seed alias resolves to Known", () => {
    const r = resolve("6419440485331");
    expect(r.resolverStatus).toBe("known");
    expect(r.productId).toBe("prod-nokian");
  });

  it("routes a code that maps to two verified products to Conflict, never guessing", () => {
    const a = product({ id: "dup-a", primarySku: "DUP", verified: true });
    const b = product({ id: "dup-b", primarySku: "DUP", verified: true });
    const r = resolve("DUP", [...products, a, b], aliases);
    expect(r.resolverStatus).toBe("conflict");
    expect(r.productId).toBeNull();
  });
});
