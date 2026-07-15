import { describe, it, expect } from "vitest";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";

describe("cleanScanCode", () => {
  it("preserves the raw value exactly while trimming the clean value", () => {
    const raw = "  6419440485331 \n";
    const r = cleanScanCode(raw);
    expect(r.rawCode).toBe(raw);
    expect(r.cleanCode).toBe("6419440485331");
  });

  it("strips invisible / zero-width characters", () => {
    const r = cleanScanCode("​﻿6419440485331​");
    expect(r.cleanCode).toBe("6419440485331");
  });

  it("removes line breaks injected by the scanner", () => {
    expect(cleanScanCode("T432119\r\n").cleanCode).toBe("T432119");
  });
});

describe("buildNormalizedCandidates", () => {
  it("creates a before-percent candidate for vendor labels", () => {
    expect(buildNormalizedCandidates("T432119%RU1%")).toEqual(["T432119%RU1%", "T432119"]);
  });

  it("creates both hyphenated and non-hyphenated SKU candidates", () => {
    expect(buildNormalizedCandidates("2881-6861")).toEqual(["2881-6861", "28816861"]);
  });

  it("returns a single candidate when nothing to normalize", () => {
    // 28816861 is 8 digits -> GTIN-shaped (EAN-8/UPC-E range), so a zero-padded canonical/variant
    // form is additively appended (Task 4: GTIN-14 canonicalization). The original candidate stays first.
    const out = buildNormalizedCandidates("28816861");
    expect(out[0]).toBe("28816861");
    expect(out).toContain("000028816861"); // one of gtinVariants' zero-padded (12-digit) forms
  });

  it("is empty for an empty string", () => {
    expect(buildNormalizedCandidates("")).toEqual([]);
  });

  describe("Task 4: GTIN-14 canonicalization (additive, leading-zero equivalence only)", () => {
    it("adds a zero-padded canonical candidate for a 14-digit GTIN so it lines up with a 12-digit UPC", () => {
      const out = buildNormalizedCandidates("00049000028911");
      expect(out[0]).toBe("00049000028911");
      expect(out).toContain("049000028911");
    });

    it("adds a zero-padded variant for a 12-digit UPC so it lines up with a 14-digit GTIN scan", () => {
      const out = buildNormalizedCandidates("049000028911");
      expect(out[0]).toBe("049000028911");
      expect(out).toContain("00049000028911");
    });

    it("does NOT collapse a GTIN-14 case pack (non-zero indicator digit) into the unit UPC", () => {
      // 10049000028918 has indicator digit "1" (case pack), a genuinely different countable product
      // from the unit UPC 049000028911. Canonicalization must never strip that digit.
      const out = buildNormalizedCandidates("10049000028918");
      expect(out).not.toContain("049000028911");
      expect(out).not.toContain("00049000028911");
    });

    it("leaves a non-GTIN-shaped code (SKU / vendor label) untouched", () => {
      expect(buildNormalizedCandidates("T432119")).toEqual(["T432119"]);
    });
  });
});
