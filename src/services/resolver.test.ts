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

describe("A3/AM-2: bad-check-digit codes get an additive, non-terminal misread reason", () => {
  it("an unknown GTIN-shaped code failing its check digit gets the misread reason and stays a normal needs_review row", () => {
    const r = resolve("049000006345");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.reason).toContain("Barcode check digit fails");
    expect(r.reason).toContain("scanner misread");
    expect(r.reason).toContain("rescan");
    expect(r.reason).toContain("store-internal code");
    expect(r.reason).toContain("still link it to a product");
  });

  it("AM-2 case 1: a number-system-2 in-store UPC (12 digits starting with 2, bad plain GS1 check) is a normal aliasable needs_review row whose reason names BOTH possibilities", () => {
    // 212345678900: GTIN-shaped, fails the plain GS1 check digit by design (in-store price-embedded
    // code), exactly like a genuine scanner misread would. Verified via scripted check: isValidCheckDigit === false.
    const r = resolve("212345678900");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.matchType).toBe("unknown");
    expect(r.reason).toContain("scanner misread");
    expect(r.reason).toContain("store-internal code");
    expect(r.reason).toContain("You can still link it to a product");
  });

  it("AM-2 case 2: a 13-digit non-GS1 warehouse numeric is likewise a normal aliasable needs_review row with the additive reason", () => {
    const r = resolve("9876543210981");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.matchType).toBe("unknown");
    expect(r.reason).toContain("scanner misread");
    expect(r.reason).toContain("store-internal code");
  });

  it("AM-2 case 3 (ITF-14 wrapper): a 14-digit code with a bad plain check digit is likewise a normal aliasable needs_review row with the additive reason", () => {
    const r = resolve("18400000567895");
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.matchType).toBe("unknown");
    expect(r.reason).toContain("scanner misread");
    expect(r.reason).toContain("store-internal code");
  });

  it("AM-2 case 4: an APPROVED alias for a bad-check-digit code still resolves Known (alias wins; reason is untouched)", () => {
    const linked = alias({
      cleanCode: "212345678900",
      normalizedCode: "212345678900",
      productId: "prod-coke",
      approved: true,
    });
    const r = resolve("212345678900", products, [...aliases, linked]);
    expect(r.resolverStatus).toBe("known");
    expect(r.productId).toBe("prod-coke");
    // The misread/additive copy only ever applies on the unknown branch - a known match's reason
    // names the product match, never the misread language.
    expect(r.reason).not.toContain("scanner misread");
    expect(r.reason).not.toContain("Barcode check digit fails");
  });

  it("a code that is NOT GTIN-shaped (vendor label) never gets the misread reason", () => {
    const r = resolve("X004DY7YUT");
    expect(r.reason).not.toContain("scanner misread");
    expect(r.reason).not.toContain("Barcode check digit fails");
  });

  it("a valid GTIN with correct check digit never gets the misread reason", () => {
    const r = resolve("855724007602"); // seed regression case, still unknown but a VALID check digit
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.reason).not.toContain("scanner misread");
    expect(r.reason).not.toContain("Barcode check digit fails");
  });
});

describe("resolveRawScan - affix core does not auto-count against a different-format alias", () => {
  it("scanning 762590BH with an approved alias for 762590 routes to Needs Review, not Known", () => {
    const products = [{ id: "p1", businessId: "b1", name: "Some Tire", verified: true } as unknown as Product];
    const aliases = [{
      id: "a1", businessId: "b1", productId: "p1", approved: true,
      cleanCode: "762590", normalizedCode: "762590", rawCodeExample: "762590",
    } as unknown as Alias];
    const res = resolveRawScan("762590BH", products, aliases, "b1");
    expect(res.resolverStatus).toBe("needs_review");
    expect(res.productId).toBeNull();
  });
});
