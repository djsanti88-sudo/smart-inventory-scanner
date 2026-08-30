import { describe, it, expect } from "vitest";
import { normalizeCode } from "./codeNormalizer";

describe("codeNormalizer", () => {
  it("preserves the raw scanned value exactly", () => {
    expect(normalizeCode("2881-6861").raw).toBe("2881-6861");
    expect(normalizeCode("  2881-6861  ").raw).toBe("  2881-6861  "); // raw untouched
  });

  it("produces a no-separator variant for a dashed part number", () => {
    const n = normalizeCode("2881-6861");
    expect(n.noSeparators).toBe("28816861");
    expect(n.searchVariants).toContain("2881-6861");
    expect(n.searchVariants).toContain("28816861"); // <-- the variant that fixes the dash miss
  });

  it("handles spaces and slashes as separators", () => {
    expect(normalizeCode("2881 6861").noSeparators).toBe("28816861");
    expect(normalizeCode("2881/6861").noSeparators).toBe("28816861");
    expect(normalizeCode("2881 6861").searchVariants).toContain("28816861");
  });

  it("uppercases alphanumeric SKUs and keeps an alphanumericOnly key", () => {
    const n = normalizeCode("mich-ps4-2454018");
    expect(n.uppercase).toBe("MICH-PS4-2454018");
    expect(n.alphanumericOnly).toBe("MICHPS42454018");
    expect(n.searchVariants).toContain("MICH-PS4-2454018");
  });

  it("extracts digitsOnly for a barcode", () => {
    const n = normalizeCode("0 49000 02890 4");
    expect(n.digitsOnly).toBe("049000028904");
    expect(n.searchVariants).toContain("049000028904");
  });

  it("search variants are de-duplicated and non-empty", () => {
    const n = normalizeCode("28816861");
    expect(new Set(n.searchVariants).size).toBe(n.searchVariants.length);
    expect(n.searchVariants.every((v) => v.length > 0)).toBe(true);
  });
});
