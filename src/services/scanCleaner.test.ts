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
