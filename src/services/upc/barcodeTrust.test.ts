// src/services/upc/barcodeTrust.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gradeBarcode,
  isPlaceholderBarcode,
  pnDerivedAnnotation,
  PLACEHOLDER_BARCODES,
} from "./barcodeTrust";
import { isValidCheckDigit } from "./gtin";

/** GS1 mod-10 check digit for a payload (all digits EXCEPT the check). */
function checkDigitFor(payload: string): string {
  const digits = payload.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return String((10 - (sum % 10)) % 10);
}
function makeGtin(payload: string): string {
  return payload + checkDigitFor(payload);
}

// The documented Gemini phantom (batch 1): Sailun prefix 884811 + last-6 of SKU BH4120176 + check.
const PHANTOM_8848 = "8848111201761";
// The documented REAL Sailun/Blackhawk UPC (tires.auto structured data, AM-11):
// 695965 + last-6 of SKU 5546800V + check 7.
const REAL_BLACKHAWK = "6959655468007";

// Representative phantom fixture: same construction as the 16 Gemini fakes
// (prefix 884811 + last-6 SKU digits + computed check). The exact 16 from the Gemini
// output can be swapped in verbatim when the owner supplies them; the CONSTRUCTION is identical.
const PHANTOM_SKU_TAILS = [
  "120176", "120177", "120183", "120190", "120204", "120211", "120228", "120235",
  "120242", "120259", "120266", "120273", "120280", "120297", "120303", "120310",
];
const PHANTOM_FIXTURE = PHANTOM_SKU_TAILS.map((tail) => makeGtin("884811" + tail));

describe("check-digit + shape (rejected verdict)", () => {
  it("rejects a GTIN-shaped code with a bad check digit", () => {
    const g = gradeBarcode({ barcode: "8848111201762" }); // last digit off by one
    expect(g.verdict).toBe("rejected");
    expect(g.checkDigitValid).toBe(false);
    expect(g.reason).toMatch(/check digit/i);
  });
  it("rejects a non-GTIN-shaped value", () => {
    const g = gradeBarcode({ barcode: "BH4120176" });
    expect(g.verdict).toBe("rejected");
    expect(g.gtinShaped).toBe(false);
  });
  it("sanity: the fixture check-digit helper matches gtin.ts arithmetic", () => {
    expect(makeGtin("884811120176")).toBe(PHANTOM_8848);
    expect(makeGtin("695965546800")).toBe(REAL_BLACKHAWK);
  });
});

describe("placeholder blocklist (the only structural hard block, AM-11.4)", () => {
  it.each(["123456789012", "0123456789012", "0000000000000", "9999999999999", "00000000"]) (
    "rejects placeholder %s",
    (code) => {
      expect(isPlaceholderBarcode(code)).toBe(true);
      const g = gradeBarcode({ barcode: code });
      expect(g.verdict).toBe("rejected");
      expect(g.placeholder).toBe(true);
    },
  );
  it("does not flag a real barcode as placeholder", () => {
    expect(isPlaceholderBarcode(REAL_BLACKHAWK)).toBe(false);
  });
  it("exports the blocklist for the .mjs drift test", () => {
    expect(PLACEHOLDER_BARCODES.length).toBeGreaterThan(0);
  });

  describe("zero-padded all-same-digit bypass (adversarial finding, CRITICAL)", () => {
    // Each of these is GTIN-shaped with a VALID GS1 check digit, and canonicalizes
    // (zero-strip) to an all-same-digit core - the same junk as a raw placeholder,
    // just zero-padded to dodge the raw /^(\d)\1+$/ regex. A real GS1 allocation never
    // has an all-same-digit significant core, so these must be rejected as placeholders
    // even when a physical_scan ground truth is asserted.
    it.each([
      "000055555555",
      "02222222222222",
      "04444444444444",
      "0555555555555",
      "06666666666666",
      "08888888888888",
      "0000055555555",
      "00000055555555",
      "00555555555555",
    ])("flags zero-padded placeholder %s and rejects even under physical_scan", (code) => {
      expect(isPlaceholderBarcode(code)).toBe(true);
      const g = gradeBarcode({ barcode: code, groundTruth: { kind: "physical_scan" } });
      expect(g.verdict).toBe("rejected");
      expect(g.placeholder).toBe(true);
    });
  });
});

describe("pnDerived annotation is ADVISORY and never changes the verdict (AM-11)", () => {
  it("flags the phantom 8848 pattern as pn_derived - and still grades it suggested, not rejected", () => {
    const g = gradeBarcode({ barcode: PHANTOM_8848, partNumber: "BH4120176" });
    expect(g.pnDerived).toBe("pn_derived");
    expect(g.verdict).toBe("suggested"); // NOT rejected: structure never denies trust
  });
  it("flags the REAL Blackhawk UPC as pn_derived too (Sailun's real scheme) - the false-positive regression", () => {
    const g = gradeBarcode({ barcode: REAL_BLACKHAWK, partNumber: "5546800V" });
    expect(g.pnDerived).toBe("pn_derived");
    expect(g.verdict).toBe("suggested"); // same annotation, same verdict: evidence decides, not structure
  });
  it("returns cannot_assess for a PN with fewer than 5 digits", () => {
    expect(pnDerivedAnnotation(REAL_BLACKHAWK, "HT4")).toBe("cannot_assess");
    expect(pnDerivedAnnotation(REAL_BLACKHAWK, "BLACKHAWK-HT")).toBe("cannot_assess");
  });
  it("returns clean when no 5+ digit PN run appears in the payload", () => {
    expect(pnDerivedAnnotation(makeGtin("003653112905"), "9876543")).toBe("clean");
  });
  it("matches the PN run against the canonical (zero-stripped) form too", () => {
    // 0-padded EAN-13 of a UPC whose payload embeds the PN run
    const upcPayload = "69596554680"; // 11-digit payload -> UPC-A
    const upc = makeGtin(upcPayload);
    const ean13 = "0" + upc;
    expect(pnDerivedAnnotation(ean13, "5546800V")).toBe("pn_derived");
  });
  it("padding zeros in the canonical form never match a PN zero-run (EAN-8 false-positive guard)", () => {
    expect(pnDerivedAnnotation("40123455", "PN-000005")).toBe("clean");
    expect(pnDerivedAnnotation("40123455", "00000")).toBe("clean");
  });
});

describe("pnDerivedAnnotation is bounded against algorithmic DoS (adversarial finding, IMPORTANT)", () => {
  it("returns cannot_assess (not pn_derived/clean) for a non-GTIN-shaped barcode, without the O(n^2) scan", () => {
    // Not GTIN-shaped: gradeBarcode rejects it anyway, so the annotation is meaningless here.
    expect(pnDerivedAnnotation("1".repeat(10000), "2".repeat(10000))).toBe("cannot_assess");
  });
  it("returns cannot_assess for an oversized part number (no real PN has 64+ digits)", () => {
    const validGtin = "6959655468007";
    expect(pnDerivedAnnotation(validGtin, "9".repeat(65))).toBe("cannot_assess");
  });
  it(
    "gradeBarcode with a 10k-digit barcode and 10k-digit partNumber completes fast and rejects (DoS guard)",
    () => {
      const start = performance.now();
      const g = gradeBarcode({ barcode: "1".repeat(10000), partNumber: "2".repeat(10000) });
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(500);
      expect(g.verdict).toBe("rejected");
    },
    60000,
  );
});

describe("verdicts with ground truth (AM-3: re-checkable artifacts only)", () => {
  it("valid + no ground truth -> suggested", () => {
    expect(gradeBarcode({ barcode: REAL_BLACKHAWK }).verdict).toBe("suggested");
  });
  it("physical_scan -> verified", () => {
    expect(
      gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("verified");
  });
  it("evidence_verified at fetched_source strength -> verified", () => {
    expect(
      gradeBarcode({
        barcode: REAL_BLACKHAWK,
        groundTruth: { kind: "evidence_verified", strength: "fetched_source" },
      }).verdict,
    ).toBe("verified");
  });
  it("evidence_verified at WEAK strength (url_only / snippet / none) stays suggested", () => {
    for (const strength of ["none", "url_only", "snippet"] as const) {
      expect(
        gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "evidence_verified", strength } })
          .verdict,
      ).toBe("suggested");
    }
  });
  it("corpus_trusted -> verified (grandfathering, AM-5)", () => {
    expect(
      gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "corpus_trusted" } }).verdict,
    ).toBe("verified");
  });
  it("ground truth NEVER rescues a bad check digit or a placeholder", () => {
    expect(
      gradeBarcode({ barcode: "8848111201762", groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("rejected");
    expect(
      gradeBarcode({ barcode: "0000000000000", groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("rejected");
  });
});

describe("the 16-phantom fixture: inert without evidence (AM-11.6)", () => {
  it("every phantom grades suggested + pn_derived - never verified, never rejected-for-structure", () => {
    for (const [i, code] of PHANTOM_FIXTURE.entries()) {
      const g = gradeBarcode({ barcode: code, partNumber: "BH4" + PHANTOM_SKU_TAILS[i] });
      expect(g.verdict).toBe("suggested");
      expect(g.pnDerived).toBe("pn_derived");
      expect(g.checkDigitValid).toBe(true);
    }
  });
});

describe("UPC-E expansion validates 8-digit labels (audit finding I2)", () => {
  // "04252614" is a REAL zero-suppressed UPC-E: its raw 8-digit GS1 check digit FAILS
  // (isValidCheckDigit("04252614") === false, verified by node probe), but expandUpcE("04252614")
  // returns "042100005264" (a valid-check UPC-A) - so the code IS legitimately GTIN-shaped, its
  // check digit only validates after zero-suppression expansion, exactly the case gtin.ts's
  // lookupCandidates already documents and handles for lookup. gradeBarcode must not reject it.
  it("an 8-digit code whose raw check fails but expands via UPC-E grades suggested, checkDigitValid true", () => {
    const g = gradeBarcode({ barcode: "04252614" });
    expect(g.verdict).toBe("suggested");
    expect(g.checkDigitValid).toBe(true);
    expect(g.gtinShaped).toBe(true);
  });
  it("a truly invalid 8-digit code (raw check fails AND UPC-E expansion fails) still rejects", () => {
    // "12345678": isValidCheckDigit false as raw EAN-8, expandUpcE also returns null (verified by
    // node probe) - there is no legitimate reading of this code, so it must still be rejected.
    const g = gradeBarcode({ barcode: "12345678" });
    expect(g.verdict).toBe("rejected");
    expect(g.checkDigitValid).toBe(false);
  });
  it("an 8-digit code with a VALID raw EAN-8 check digit stays graded as EAN-8 (regression, no UPC-E override)", () => {
    // Payload "4006381" + computed GS1 check digit = "40063812": a valid EAN-8 whose leading
    // digit (4) is outside the UPC-E number-system range (0/1), so it is unambiguously EAN-8,
    // never eligible for UPC-E expansion in the first place.
    const validEan8 = "40063812";
    expect(isValidCheckDigit(validEan8)).toBe(true);
    const g = gradeBarcode({ barcode: validEan8 });
    expect(g.verdict).toBe("suggested");
    expect(g.checkDigitValid).toBe(true);
  });
});

describe("GTIN-14 case pack preserves the indicator digit (audit finding I3)", () => {
  it("a valid-check GTIN-14 with indicator digit 1 (case pack) grades suggested and keeps the full 14-digit canonical form", () => {
    const g = gradeBarcode({ barcode: "10012345678902" });
    expect(g.verdict).toBe("suggested");
    expect(g.placeholder).toBe(false);
    expect(g.checkDigitValid).toBe(true);
    // NOT collapsed to the unit GTIN ("00012345678905" or similar) - the indicator digit survives.
    expect(g.canonicalGtin).toBe("10012345678902");
  });
});

describe("edge-case pins (audit findings M2/M3)", () => {
  it("gradeBarcode({barcode: ''}) does not throw and rejects with a non-empty reason", () => {
    expect(() => gradeBarcode({ barcode: "" })).not.toThrow();
    const g = gradeBarcode({ barcode: "" });
    expect(g.verdict).toBe("rejected");
    expect(g.reason.length).toBeGreaterThan(0);
  });
});

describe("placeholder blocklist drift guard (.mjs mirror)", () => {
  // scripts/dt-harvest/lib/placeholderBarcodes.mjs is a hand-maintained mirror of this file's
  // PLACEHOLDER_BARCODES (plain node cannot import this TS module into the harvest pipeline - see
  // brandFamilies.mjs for the established pattern). This test keeps the two lists byte-for-byte
  // identical so a future edit to one without the other fails loudly instead of silently drifting.
  it("the .mjs mirror contains exactly the same list", () => {
    const mjs = readFileSync(
      join(__dirname, "../../../scripts/dt-harvest/lib/placeholderBarcodes.mjs"),
      "utf8",
    );
    for (const code of PLACEHOLDER_BARCODES) {
      expect(mjs).toContain(`"${code}"`);
    }
    // and no extras: count the quoted 8-14 digit literals in the mirror's list block
    const listBlock = mjs.slice(mjs.indexOf("PLACEHOLDER_BARCODES"), mjs.indexOf("]"));
    const literals = listBlock.match(/"\d{8,14}"/g) ?? [];
    expect(literals.length).toBe(PLACEHOLDER_BARCODES.length);
  });
});
