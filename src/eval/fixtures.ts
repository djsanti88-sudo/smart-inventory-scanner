import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult } from "@/types";

// MOCK/OFFLINE fixtures for the eval harness — NO live AI. Each fixture represents the decode INPUT the
// pipeline realistically produces today: a SINGLE-provider page-fetch result (brand + title + specs) plus
// the fetched page text the EvidenceVerifier reads. This mirrors the observed live reality (see
// docs/decode/ARCHITECTURE.md s4: within budget usually only the page-fetch returns). The harness feeds
// these through the REAL verifyEvidence + decideDecode + firewall, so it measures the actual decision
// logic - not a hand-picked outcome.
//
// HONESTY NOTE: these are REPRESENTATIVE fixtures (real brands/codes + plausible specs), not captured live
// transcripts - capturing 10 live transcripts would spend AI tokens, which the money-safety rules forbid
// by default. Run `npm run eval-decode -- --live` (manual, capped) to measure the real live extraction.

export interface DecodeFixture {
  /** The single source the pipeline got back (page-fetch product). */
  result: AiLookupResult;
  /** The REAL page text the EvidenceVerifier reads (must contain the EXACT scanned code to verify). */
  fetchedSourceText: string;
}

function tire(over: Partial<AiLookupResult>, code: string): AiLookupResult {
  return { ...emptyResult(), confidence: 0.92, sourceUrls: [`https://www.upcitemdb.com/upc/${code}`], ...over };
}

export const FIXTURES: Record<string, DecodeFixture> = {
  // Full specs (size + load + speed) + brand in title -> brand inferred -> corroboration CAN fire.
  "086699205636": {
    result: tire({ productName: "Michelin Defender LTX M/S 275/55R20 113T", brand: "Michelin", specsShort: "275/55R20 113T", category: "Tire" }, "086699205636"),
    fetchedSourceText: "Michelin Defender LTX M/S 275/55R20 113T. UPC 086699205636. All-season tire.",
  },
  "051342144969": {
    result: tire({ productName: "Continental TerrainContact A/T 265/70R17 115T", brand: "Continental", specsShort: "265/70R17 115T", category: "Tire" }, "051342144969"),
    fetchedSourceText: "Continental TerrainContact A/T 265/70R17 115T. UPC 051342144969.",
  },
  "029142712886": {
    result: tire({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R", category: "Tire" }, "029142712886"),
    fetchedSourceText: "Cooper Discoverer A/T3 LT245/75R16 120R. UPC 029142712886. Light truck all-terrain tire.",
  },
  // Realistic DEGRADED case: barcode-DB title truncated the speed rating -> incomplete specs. The gate
  // MUST withhold auto-count (size + load + SPEED required). Demonstrates correct withholding.
  "029142815167": {
    result: tire({ productName: "Cooper Discoverer AT3 4S 255/70R18", brand: "Cooper", specsShort: "255/70R18", category: "Tire" }, "029142815167"),
    fetchedSourceText: "Cooper Discoverer AT3 4S 255/70R18. UPC 029142815167.",
  },
  "8807622002083": {
    result: tire({ productName: "Nexen Roadian GTX 235/65R18 106V", brand: "Nexen", specsShort: "235/65R18 106V", category: "Tire" }, "8807622002083"),
    fetchedSourceText: "Nexen Roadian GTX 235/65R18 106V. EAN 8807622002083.",
  },
  "8807622002649": {
    result: tire({ productName: "Nexen N'Fera Sport 245/45R18 100Y", brand: "Nexen", specsShort: "245/45R18 100Y", category: "Tire" }, "8807622002649"),
    fetchedSourceText: "Nexen N'Fera Sport 245/45R18 100Y. EAN 8807622002649.",
  },
  "715459332915": {
    result: tire({ productName: "Hankook Dynapro AT2 RF11 265/70R17 115T", brand: "Hankook", specsShort: "265/70R17 115T", category: "Tire" }, "715459332915"),
    fetchedSourceText: "Hankook Dynapro AT2 RF11 265/70R17 115T. UPC 715459332915.",
  },
  "697662123125": {
    result: tire({ productName: "Goodyear Wrangler TrailRunner AT 275/60R20 115T", brand: "Goodyear", specsShort: "275/60R20 115T", category: "Tire" }, "697662123125"),
    fetchedSourceText: "Goodyear Wrangler TrailRunner AT 275/60R20 115T. UPC 697662123125.",
  },
  "697662036067": {
    result: tire({ productName: "Goodyear Assurance MaxLife 225/65R17 102H", brand: "Goodyear", specsShort: "225/65R17 102H", category: "Tire" }, "697662036067"),
    fetchedSourceText: "Goodyear Assurance MaxLife 225/65R17 102H. UPC 697662036067.",
  },
  // POISON: go-upc says the scanned code is not valid and points at a DIFFERENT code (Manstel rivet kit).
  // The page text contains the DIFFERENT code + an invalidation phrase -> verifyEvidence(745125495781)
  // returns none, decideDecode never verifies, and the firewall blocks the non-tire product.
  "745125495781": {
    result: tire({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit", brand: "Manstel", specsShort: "", category: "Hardware", confidence: 0.9, sourceUrls: ["https://go-upc.com/7451254957818"] }, "745125495781"),
    fetchedSourceText: "Sorry, 745125495781 is not a valid UPC. Did you mean GTIN 7451254957818 (Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit)?",
  },
};
