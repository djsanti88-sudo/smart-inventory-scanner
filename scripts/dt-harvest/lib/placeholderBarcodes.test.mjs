// scripts/dt-harvest/lib/placeholderBarcodes.test.mjs
// Runs in the "unit" vitest project (scripts/**/*.test.mjs, node env) - see the guardRow tests in
// merge.test.mjs and the brandFamilies.mjs pattern this file mirrors.
import { describe, it, expect } from "vitest";
import { isPlaceholderBarcode, PLACEHOLDER_BARCODES } from "./placeholderBarcodes.mjs";

describe("isPlaceholderBarcode (dt-harvest .mjs mirror)", () => {
  it("flags the enumerated placeholder/dummy barcodes", () => {
    expect(isPlaceholderBarcode("123456789012")).toBe(true);
    expect(isPlaceholderBarcode("0123456789012")).toBe(true);
    expect(isPlaceholderBarcode("1234567890128")).toBe(true);
    expect(isPlaceholderBarcode("01234567890128")).toBe(true);
  });

  it("flags all-same-digit codes regardless of length", () => {
    expect(isPlaceholderBarcode("0000000000000")).toBe(true);
    expect(isPlaceholderBarcode("9999999999999")).toBe(true);
    expect(isPlaceholderBarcode("00000000")).toBe(true);
  });

  it("flags zero-padded all-same-digit codes (hardened check, adversarial finding)", () => {
    // "000055555555" zero-strips to "55555555" - all-same-digit significant core.
    expect(isPlaceholderBarcode("000055555555")).toBe(true);
    // "02222222222222" zero-strips to "2222222222222" - all-same-digit significant core.
    expect(isPlaceholderBarcode("02222222222222")).toBe(true);
  });

  it("does not flag a real barcode as placeholder", () => {
    expect(isPlaceholderBarcode("6959655468007")).toBe(false);
    expect(isPlaceholderBarcode("848983006257")).toBe(false);
  });

  it("exports a non-empty blocklist", () => {
    expect(PLACEHOLDER_BARCODES.length).toBeGreaterThan(0);
  });
});
