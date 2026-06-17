import { describe, it, expect } from "vitest";
import {
  deriveGs1RegionHint,
  formatGs1Hint,
  GS1_HINT_DISCLAIMER,
  ARCHITECTURE_VERSION,
} from "@/services/gs1Prefixes";

describe("gs1Prefixes.deriveGs1RegionHint", () => {
  it("maps a US UPC-A (incl. the known live decode code 855724007602) to US/Canada", () => {
    expect(deriveGs1RegionHint("855724007602", "upc_a")).toMatch(/United States and Canada/);
    expect(deriveGs1RegionHint("049000028904", "upc_a")).toMatch(/United States and Canada/);
  });

  it("maps an EAN-13 by its leading 3-digit prefix (641 -> Finland)", () => {
    expect(deriveGs1RegionHint("6419440485331", "ean_13")).toBe("Finland");
  });

  it("maps France (300-379), Germany (400-440) and China (690-699)", () => {
    expect(deriveGs1RegionHint("3001234567890", "ean_13")).toMatch(/France/);
    expect(deriveGs1RegionHint("4001234567894", "ean_13")).toMatch(/Germany/);
    expect(deriveGs1RegionHint("6901234567890", "ean_13")).toMatch(/China/);
  });

  it("handles GTIN-14 by dropping the leading packaging-indicator digit", () => {
    // indicator '1' + GTIN-13 base starting 004... -> US/Canada
    expect(deriveGs1RegionHint("10049000028904", "gtin_14")).toMatch(/United States and Canada/);
  });

  it("flags restricted/internal-distribution ranges (200-299) rather than guessing a country", () => {
    expect(deriveGs1RegionHint("2001234567890", "ean_13")).toMatch(/Restricted distribution/);
  });

  it("maps the ISBN/ISSN bookland special ranges", () => {
    expect(deriveGs1RegionHint("9781234567897", "ean_13")).toMatch(/Books/);
    expect(deriveGs1RegionHint("9771234567898", "ean_13")).toMatch(/ISSN/);
  });

  it("returns null for non-public code types (never guesses a region for SKU/vendor/messy/empty)", () => {
    expect(deriveGs1RegionHint("X004DY7YUT", "vendor_label")).toBeNull();
    expect(deriveGs1RegionHint("ABC-123", "alpha_sku")).toBeNull();
    expect(deriveGs1RegionHint("12345", "numeric_sku")).toBeNull();
    expect(deriveGs1RegionHint("@@@", "messy")).toBeNull();
    expect(deriveGs1RegionHint("", "empty")).toBeNull();
  });

  it("returns null for malformed length or an unmapped/omitted prefix", () => {
    expect(deriveGs1RegionHint("12345", "upc_a")).toBeNull(); // too short for UPC-A
    // 390 is intentionally omitted (uncertain allocation) -> null, not a guess
    expect(deriveGs1RegionHint("3901234567890", "ean_13")).toBeNull();
  });
});

describe("gs1Prefixes.formatGs1Hint", () => {
  it("combines region + mandated disclaimer for a public barcode", () => {
    const hint = formatGs1Hint("855724007602", "upc_a");
    expect(hint).toContain("GS1 prefix region:");
    expect(hint).toContain("United States and Canada");
    expect(hint).toContain(GS1_HINT_DISCLAIMER);
  });

  it("returns null when no region applies (so callers emit nothing)", () => {
    expect(formatGs1Hint("X004DY7YUT", "vendor_label")).toBeNull();
  });
});

describe("gs1Prefixes mandated labeling + version", () => {
  it("states the exact non-authoritative disclaimer", () => {
    expect(GS1_HINT_DISCLAIMER).toContain("GS1 numbering authority region only");
    expect(GS1_HINT_DISCLAIMER).toContain("not country of manufacture");
    expect(GS1_HINT_DISCLAIMER).toContain("not brand");
    expect(GS1_HINT_DISCLAIMER).toContain("not product identity");
  });

  it("uses a normal hyphen, never an em/en dash (user-copy convention)", () => {
    expect(GS1_HINT_DISCLAIMER).not.toMatch(/[–—]/);
  });

  it("stamps Architecture Version v1.0.0", () => {
    expect(ARCHITECTURE_VERSION).toBe("1.0.0");
  });
});
