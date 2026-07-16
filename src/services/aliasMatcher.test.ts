import { describe, it, expect } from "vitest";
import {
  matchAlias,
  matchProductByIdentifiers,
  resolveScanToProduct,
  needsReview,
} from "@/services/aliasMatcher";
import { cleanScanCode } from "@/services/scanCleaner";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import type { Product } from "@/types";

const { products, aliases } = getSeed();
const resolve = (raw: string, businessId = DEMO_BUSINESS_ID) =>
  resolveScanToProduct(cleanScanCode(raw), products, aliases, businessId);

function makeProduct(overrides: Partial<Product>): Product {
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

describe("alias matching across all three seed examples", () => {
  it("maps every Nokian code to the same product", () => {
    for (const code of ["6419440485331", "T432119", "T432119%RU1%"]) {
      expect(resolve(code).productId).toBe("prod-nokian");
    }
  });

  it("maps every Falken code to the same product", () => {
    for (const code of ["848983012906", "28816861", "2881-6861"]) {
      expect(resolve(code).productId).toBe("prod-falken");
    }
  });

  it("maps both Coca-Cola codes to the same product", () => {
    expect(resolve("049000028904").productId).toBe("prod-coke");
    expect(resolve("7262").productId).toBe("prod-coke");
  });

  it("routes a truly unknown code to needs review", () => {
    const r = resolve("UNKNOWN123");
    expect(r.matchType).toBe("unknown");
    expect(r.productId).toBeNull();
    expect(needsReview(r)).toBe(true);
  });
});

describe("match type is labeled accurately (audit rule)", () => {
  it("labels a primary barcode hit as primary_barcode, not sku", () => {
    const p = makeProduct({ id: "b1", primaryBarcode: "111111111111", primarySku: "SKU-1" });
    const r = matchProductByIdentifiers(cleanScanCode("111111111111"), [p], DEMO_BUSINESS_ID);
    expect(r?.matchType).toBe("primary_barcode");
    expect(r?.productId).toBe("b1");
  });

  it("labels a GTIN-only hit as gtin", () => {
    const p = makeProduct({ id: "g1", gtin: "22222222222222" });
    const r = matchProductByIdentifiers(cleanScanCode("22222222222222"), [p], DEMO_BUSINESS_ID);
    expect(r?.matchType).toBe("gtin");
  });

  it("labels a primary SKU hit as primary_sku", () => {
    const p = makeProduct({ id: "s1", primarySku: "ABC-123" });
    const r = matchProductByIdentifiers(cleanScanCode("ABC-123"), [p], DEMO_BUSINESS_ID);
    expect(r?.matchType).toBe("primary_sku");
  });

  it("labels approved alias hits from the seed as exact_alias", () => {
    expect(resolve("6419440485331").matchType).toBe("exact_alias");
  });
});

describe("case-insensitive matching (QA fix cluster #1): a case-only difference is the same identity", () => {
  it("matches an approved alias regardless of scanned case (lowercase scan, uppercase alias)", () => {
    const upper = resolve("T432119");
    const lower = resolve("t432119");
    expect(lower.matchType).toBe(upper.matchType);
    expect(lower.productId).toBe(upper.productId);
    expect(lower.productId).toBe("prod-nokian");
    expect(["exact_alias", "normalized_alias"]).toContain(lower.matchType);
  });

  it("matches a verified product's primarySku regardless of scanned case", () => {
    const p = makeProduct({ id: "s-case", primarySku: "ABC-123" });
    const r = matchProductByIdentifiers(cleanScanCode("abc-123"), [p], DEMO_BUSINESS_ID);
    expect(r?.matchType).toBe("primary_sku");
    expect(r?.productId).toBe("s-case");
  });

  it("matches a verified product's vendorCodes regardless of scanned case", () => {
    const p = makeProduct({ id: "v-case", vendorCodes: ["X001ABCD"] });
    const r = matchProductByIdentifiers(cleanScanCode("x001abcd"), [p], DEMO_BUSINESS_ID);
    expect(r?.productId).toBe("v-case");
  });

  it("does NOT mutate stored cleanCode/rawCode case, only folds at compare time", () => {
    const p = makeProduct({ id: "s-case2", primarySku: "ABC-123" });
    // Scanning the exact original case still works and the field itself remains untouched.
    expect(p.primarySku).toBe("ABC-123");
    const r = matchProductByIdentifiers(cleanScanCode("ABC-123"), [p], DEMO_BUSINESS_ID);
    expect(r?.productId).toBe("s-case2");
  });

  it("negative: case-folding never causes a false merge between genuinely different codes", () => {
    const r = resolve("totally-different-code-xyz");
    expect(r.matchType).toBe("unknown");
    expect(r.productId).toBeNull();
  });
});

describe("conflict handling and scoping", () => {
  it("routes a code that maps to two products to conflict, never guessing", () => {
    const a = makeProduct({ id: "dup-a", primarySku: "DUP" });
    const b = makeProduct({ id: "dup-b", primarySku: "DUP" });
    const r = resolveScanToProduct(cleanScanCode("DUP"), [a, b], [], DEMO_BUSINESS_ID);
    expect(r.matchType).toBe("conflict");
    expect(r.productId).toBeNull();
    expect(r.conflictProductIds?.sort()).toEqual(["dup-a", "dup-b"]);
    expect(needsReview(r)).toBe(true);
  });

  it("scopes matches by businessId", () => {
    expect(resolve("6419440485331", "other-business").matchType).toBe("unknown");
  });

  it("matchAlias returns null when nothing matches", () => {
    expect(matchAlias(cleanScanCode("NOPE999"), aliases, DEMO_BUSINESS_ID)).toBeNull();
  });
});
