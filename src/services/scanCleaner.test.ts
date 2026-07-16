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
    expect(buildNormalizedCandidates("28816861")).toEqual(["28816861"]);
  });

  it("is empty for an empty string", () => {
    expect(buildNormalizedCandidates("")).toEqual([]);
  });
});

describe("buildNormalizedCandidates - AIM symbology prefix strip (QA fix cluster #3)", () => {
  it("promotes the AIM-prefix-stripped form to the front for ]C1", () => {
    const out = buildNormalizedCandidates("]C1T432119");
    expect(out[0]).toBe("T432119");
    expect(out).toContain("]C1T432119");
  });

  it("strips other common AIM symbology ids: ]C0 ]E0 ]A0 ]I0 ]Q3 ]d2", () => {
    for (const prefix of ["]C0", "]E0", "]A0", "]I0", "]Q3", "]d2"]) {
      const out = buildNormalizedCandidates(`${prefix}T432119`);
      expect(out[0]).toBe("T432119");
    }
  });

  it("never replaces the original candidate, only adds the stripped form", () => {
    const out = buildNormalizedCandidates("]C1T432119");
    expect(out).toContain("]C1T432119");
    expect(out).toContain("T432119");
  });

  it("cleanScanCode preserves rawCode exactly for an AIM-prefixed scan", () => {
    const r = cleanScanCode("]C1T432119");
    expect(r.rawCode).toBe("]C1T432119");
    expect(r.cleanCode).toBe("]C1T432119");
    expect(r.normalizedCandidates[0]).toBe("T432119");
  });

  it("does not strip when the bracket is not followed by a valid AIM prefix shape (letter+alnum)", () => {
    // ']' followed by a symbol (not letter+alnum) is not a recognized AIM prefix; left alone.
    const out = buildNormalizedCandidates("]-T432119");
    expect(out[0]).toBe("]-T432119");
    expect(out).not.toContain("T432119");
  });
});

describe("buildNormalizedCandidates - affix core stays OUT of the auto-count path (owner correction 1)", () => {
  it("does NOT emit a bare affix-stripped core as a deterministic candidate", () => {
    // 762590BH must not silently become 762590: a generic core is discovery-only, not auto-count.
    expect(buildNormalizedCandidates("762590BH")).not.toContain("762590");
    expect(buildNormalizedCandidates("BH762590")).not.toContain("762590");
  });
  it("still emits the exact, lossless variants it always did", () => {
    expect(buildNormalizedCandidates("2881-6861")).toContain("28816861");
  });
});
