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

describe("QA fix cluster #8: over-500-char scans are flagged but never dropped (law: still appears+counts)", () => {
  it("a 600-char string still resolves (needs_review), row appears, rawCode preserved in full", () => {
    const longCode = "A".repeat(600);
    const r = resolve(longCode);
    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.rawCode).toBe(longCode);
    expect(r.rawCode.length).toBe(600);
    expect(r.reason.toLowerCase()).toContain("unusually long");
  });

  it("a code at or under the 500 cap does not get the unusually-long reason", () => {
    const okCode = "B".repeat(500);
    const r = resolve(okCode);
    expect(r.reason.toLowerCase()).not.toContain("unusually long");
  });

  it("law: scanning N codes yields N feed entries and count N - a long code is never silently dropped", () => {
    const longCode = "C".repeat(600);
    const results = [resolve(longCode), resolve(longCode), resolve(longCode)];
    // Each individual scan call still produces one resolution (one feed entry) - never thrown away.
    for (const r of results) {
      expect(r).toBeDefined();
      expect(r.resolverStatus).not.toBeUndefined();
    }
    expect(results.length).toBe(3);
  });

  it("an over-long code that DOES match an approved alias still resolves Known (length cap never blocks a real match)", () => {
    const longRaw = "T432119" + "Z".repeat(600);
    const linked = alias({
      cleanCode: longRaw,
      normalizedCode: longRaw,
      productId: "prod-coke",
      approved: true,
    });
    const r = resolve(longRaw, products, [...aliases, linked]);
    expect(r.resolverStatus).toBe("known");
    expect(r.productId).toBe("prod-coke");
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

describe("QA Task 8: review-only near-match SKU suggestion (distance<=1, single candidate)", () => {
  // NOTE: the seed catalog already contains a real product (prod-nokian) with primarySku
  // "T432119" - the plan's own worked example. These tests exercise it directly instead of
  // re-seeding a colliding SKU (which would create a genuine two-candidate case and correctly
  // suppress the suggestion). Isolation cases below use a distinct base code family (Q88xxxx)
  // that does not collide with any seed primarySku/vendorCode/alias.

  it("T432118 vs the seeded T432119 (prod-nokian) -> nearMatchSuggestion attached AND resolverStatus stays needs_review (never auto-counts)", () => {
    const r = resolve("T432118");

    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.matchType).toBe("unknown");
    expect(r.nearMatchSuggestion).toBeDefined();
    expect(r.nearMatchSuggestion!.productId).toBe("prod-nokian");
    expect(r.nearMatchSuggestion!.distance).toBe(1);
    expect(r.nearMatchSuggestion!.matchedOn).toBe("T432119");
  });

  it("matches against an approved alias cleanCode too (not just primarySku)", () => {
    const seeded = product({ id: "prod-alias-match", name: "Aliased Widget", primarySku: "", verified: true });
    const linked = alias({ cleanCode: "Q882119", normalizedCode: "Q882119", productId: "prod-alias-match", approved: true });
    const r = resolve("Q882118", [...products, seeded], [...aliases, linked]);

    expect(r.resolverStatus).toBe("needs_review");
    expect(r.nearMatchSuggestion).toBeDefined();
    expect(r.nearMatchSuggestion!.productId).toBe("prod-alias-match");
  });

  it("matches against a product's vendorCodes too", () => {
    const seeded = product({ id: "prod-vendor-match", name: "Vendor Widget", vendorCodes: ["Q882119"], verified: true });
    const r = resolve("Q882118", [...products, seeded], aliases);

    expect(r.resolverStatus).toBe("needs_review");
    expect(r.nearMatchSuggestion).toBeDefined();
    expect(r.nearMatchSuggestion!.productId).toBe("prod-vendor-match");
  });

  it("TWO candidates within distance <= 1 -> NO suggestion (never guess between them)", () => {
    const seededA = product({ id: "prod-a", name: "Widget A", primarySku: "Q882119", verified: true });
    const seededB = product({ id: "prod-b", name: "Widget B", primarySku: "Q882117", verified: true });
    const r = resolve("Q882118", [...products, seededA, seededB], aliases);

    expect(r.resolverStatus).toBe("needs_review");
    expect(r.productId).toBeNull();
    expect(r.nearMatchSuggestion).toBeUndefined();
  });

  it("non-alpha_sku (pure numeric) codes are unaffected - never get a near-match suggestion", () => {
    // A purely numeric unknown code near a numeric primarySku must not get this treatment; that
    // class (GTIN canonicalization) is handled by Task 4, not here.
    const seeded = product({ id: "prod-numeric", name: "Numeric Widget", primarySku: "882119", verified: true });
    const r = resolve("882118", [...products, seeded], aliases);

    expect(r.codeType).not.toBe("alpha_sku");
    expect(r.nearMatchSuggestion).toBeUndefined();
  });

  it("no suggestion when distance is 2 or more (too far to guess)", () => {
    const seeded = product({ id: "prod-far", name: "Far Widget", primarySku: "Q889999", verified: true });
    const r = resolve("Q882118", [...products, seeded], aliases);

    expect(r.resolverStatus).toBe("needs_review");
    expect(r.nearMatchSuggestion).toBeUndefined();
  });

  it("no suggestion for a short alpha_sku code (len < 5) even with a distance-1 candidate", () => {
    const seeded = product({ id: "prod-short", name: "Short Widget", primarySku: "AB1D", verified: true });
    const r = resolve("AB12", [...products, seeded], aliases); // len 4, distance 1 from AB1D
    expect(r.codeType).toBe("alpha_sku");

    expect(r.nearMatchSuggestion).toBeUndefined();
  });

  it("an UNVERIFIED product's primarySku never produces a suggestion (trust gate applies to suggestions too)", () => {
    const unverified = product({ id: "prod-unverified", name: "Unverified Widget", primarySku: "Q882119", verified: false });
    const r = resolve("Q882118", [...products, unverified], aliases);

    expect(r.nearMatchSuggestion).toBeUndefined();
  });

  it("exact match distance 0 never surfaces as a near-match suggestion (that is a real Known match, handled elsewhere)", () => {
    const seeded = product({ id: "prod-exact", name: "Exact Widget", primarySku: "Q882118", verified: true });
    const r = resolve("Q882118", [...products, seeded], aliases);
    // primarySku match resolves Known via the deterministic matcher tier, not via near-match.
    expect(r.resolverStatus).toBe("known");
    expect(r.nearMatchSuggestion).toBeUndefined();
  });
});
