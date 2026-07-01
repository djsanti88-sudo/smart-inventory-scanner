import { describe, it, expect } from "vitest";
import { decideDecode } from "@/services/ai/decode";
import { detectScanContextConflict, detectBrandPrefixAdvisory } from "@/services/ai/scanContextFirewall";
import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult, EvidenceResult } from "@/types";

// PLAN C - TASK 2: the brand-prefix conflict is demoted from a HARD BLOCK to ADVISORY guidance.
// A brand-prefix mismatch must NEVER by itself block a verify/count when the app independently confirmed
// the EXACT code in STRONG evidence (grounding/corpus wins over the prefix; GS1 prefixes are many-to-one).
// The CATEGORY / poison guard (wrong product TYPE) MUST STAY a hard block.

const result = (over: Partial<AiLookupResult>): AiLookupResult => ({ ...emptyResult(), confidence: 0.95, ...over });
const strong = (code: string): EvidenceResult => ({
  verified: true,
  strength: "snippet",
  matchedCode: code,
  matchedSources: ["snippet"],
  reason: "exact code in snippet",
});

describe("Plan C Task 2 - (a) POSITIVE: brand-prefix mismatch is advisory, not a block", () => {
  it("decideDecode VERIFIES a public barcode with strong exact-code evidence even when brandPrefixConflict is flagged", () => {
    // ONLY firewall issue is a brand-prefix mismatch; evidence is strong + app-verified + confidence high.
    const d = decideDecode({
      codeType: "upc_a",
      results: [result({ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000028904" })],
      evidences: [strong("049000028904")],
      confidenceThreshold: 0.8,
      code: "049000028904",
      brandPrefixConflict: true, // advisory only now - must not block a strong-evidence verify
    });
    expect(d.status).toBe("verified");
    expect(d.exactCodeEvidenceVerifiedByApp).toBe(true);
  });

  it("detectScanContextConflict no longer BLOCKS on a brand-prefix mismatch (returns null, not brand_prefix_conflict)", () => {
    const r = result({ productName: "Some Snack", brand: "Manstel" });
    const hints = [{ prefix: "0745125", brand: "fortune" }];
    // brand mismatch vs an unambiguous learned prefix used to return "brand_prefix_conflict" (a block).
    expect(
      detectScanContextConflict({ scanContext: "any", code: "745125495781", codeType: "upc_a", result: r, brandPrefixHints: hints }),
    ).toBeNull();
  });

  it("the brand-prefix mismatch is still REPORTED as an advisory flag (never lost, just non-blocking)", () => {
    const r = result({ productName: "Some Snack", brand: "Manstel" });
    const hints = [{ prefix: "0745125", brand: "fortune" }];
    expect(
      detectBrandPrefixAdvisory({ code: "745125495781", codeType: "upc_a", result: r, brandPrefixHints: hints }),
    ).toBe(true);
  });
});

describe("Plan C Task 2 - (b) GUARD STILL HOLDS: the category / poison guard stays a hard block", () => {
  it("a clearly non-tire product in a TIRE scan context STILL blocks (category_context_conflict)", () => {
    const r = result({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm" });
    expect(
      detectScanContextConflict({ scanContext: "tire", code: "745125495781", codeType: "upc_a", result: r, brandPrefixHints: [] }),
    ).toBe("category_context_conflict");
  });

  it("the category guard fires even with a brand-prefix hint present (poison guard is independent of the demoted arm)", () => {
    const r = result({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel" });
    expect(
      detectScanContextConflict({ scanContext: "tire", code: "086699220585", codeType: "upc_a", result: r, brandPrefixHints: [{ prefix: "0086699", brand: "michelin" }] }),
    ).toBe("category_context_conflict");
  });
});
