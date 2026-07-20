import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult, DecodeDecision } from "@/types";

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
  /**
   * P5 Task 4 (golden precision gates): an OPTIONAL pre-built DecodeDecision. When present, the
   * harness scores this decision directly (through the real canAutoCount/shouldAutoApplySuggestion
   * gate) instead of deriving one via verifyEvidence + decideDecode. Needed for classes whose
   * decision is never built by decideDecode - gpt_self_report (gptLadderRung.ts) and the Go-UPC /
   * corpus / retail / learned-tier payload builders each hand-build their own DecodeDecision.
   */
  decision?: DecodeDecision;
}

// Phase 9: accurate tire fixtures now carry corroboratedByModel=true, modeling the new pipeline where the
// page-fetch + an independent model read of the same page agree on the tire identity (path 2). The poison
// overrides this to false (it is non-tire and its page declares the code invalid, so the real enrich never
// sets it). This lets the harness measure the path-2 unlock; the LIVE run (--live) measures real agreement.
function tire(over: Partial<AiLookupResult>, code: string): AiLookupResult {
  return { ...emptyResult(), confidence: 0.92, corroboratedByModel: true, sourceUrls: [`https://www.upcitemdb.com/upc/${code}`], ...over };
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
    result: tire({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit", brand: "Manstel", specsShort: "", category: "Hardware", confidence: 0.9, corroboratedByModel: false, sourceUrls: ["https://go-upc.com/7451254957818"] }, "745125495781"),
    fetchedSourceText: "Sorry, 745125495781 is not a valid UPC. Did you mean GTIN 7451254957818 (Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit)?",
  },

  // --- P5 Task 4: per-class labeled fixtures (CLASS_DATASET) -----------------------------------
  // Each supplies a pre-built `decision` (bypassing decideDecode) mirroring exactly what the named
  // production payload builder emits post-D6-demotion, so the harness proves the REAL gate
  // (canAutoCount/shouldAutoApplySuggestion) scores each class per its ground-truth expectedStatus.

  // Mirrors gptLadderRung.ts gptResultToDecodePayload's r.tier === "verified" branch (post-D6): a bare
  // GPT self-report on a public barcode (upc_a) is demoted to "suggested" - never verified.
  "gpt-self-report-verified-should-demote-to-suggested": {
    result: { ...emptyResult(), productName: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", specsShort: "265/70R17 115T", category: "Tire", confidence: 0.9, sourceUrls: ["https://www.tirerack.com/x"] },
    fetchedSourceText: "",
    decision: {
      status: "suggested",
      confidence: 0.9,
      reason: "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.",
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      corroborationPath: "gpt_self_report",
      crossCheck: { decision: "single_provider", confidence: 0.9, reason: "single provider - no second source to cross-check", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  },
  // T20/code-1225: a GPT self-report on a NON-public-barcode shape (numeric_sku) must never mint
  // verified either - mirrors the same gptResultToDecodePayload branch on a vendor part number.
  "gpt-self-report-on-vendor-shape": {
    result: { ...emptyResult(), productName: "Spitz Vorosafonya Cranberry Juice", brand: "Spitz", category: "Beverage", confidence: 0.9, sourceUrls: [] },
    fetchedSourceText: "",
    decision: {
      status: "suggested",
      confidence: 0.9,
      reason: "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.",
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      corroborationPath: "gpt_self_report",
      crossCheck: { decision: "single_provider", confidence: 0.9, reason: "single provider - no second source to cross-check", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  },
  // AC5 fence: app-verified exact-code evidence (the app itself fetched + matched the code) must
  // still auto-verify exactly as before - decideDecode's canVerify/singleSourceVerified path.
  "app-verified-exact-should-stay-verified": {
    result: { ...emptyResult(), productName: "Michelin Defender LTX M/S 275/55R20 113T", brand: "Michelin", specsShort: "275/55R20 113T", category: "Tire", confidence: 0.95, sourceUrls: ["https://www.upcitemdb.com/upc/086699205636"] },
    fetchedSourceText: "Michelin Defender LTX M/S 275/55R20 113T. UPC 086699205636.",
    decision: {
      status: "verified",
      confidence: 0.95,
      reason: "app-verified exact code match on fetched page",
      evidenceStrength: "fetched_source",
      exactCodeEvidenceVerifiedByApp: true,
      corroborationPath: "single_source",
      crossCheck: { decision: "single_provider", confidence: 0.95, reason: "single provider - no second source to cross-check", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  },
  // Learned tier is a suggestion by construction (never verified) regardless of confidence.
  "learned-tier-should-stay-suggested": {
    result: { ...emptyResult(), productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R", category: "Tire", confidence: 0.85, sourceUrls: [] },
    fetchedSourceText: "",
    decision: {
      status: "suggested",
      confidence: 0.85,
      reason: "learned tier: previously human-approved for a similar code, not app-verified this time",
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0.85, reason: "single provider - no second source to cross-check", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  },
  // AC5 fence: corpus/retail-corpus hit must still auto-verify exactly as before.
  "corpus-retail-hit-should-stay-verified": {
    result: { ...emptyResult(), productName: "Coca-Cola Classic 12oz Can", brand: "Coca-Cola", category: "Beverage", confidence: 0.98, sourceUrls: [] },
    fetchedSourceText: "",
    decision: {
      status: "verified",
      confidence: 0.98,
      reason: "corpus exact barcode match",
      evidenceStrength: "fetched_source",
      exactCodeEvidenceVerifiedByApp: true,
      corroborationPath: "corpus_exact_barcode",
      crossCheck: { decision: "single_provider", confidence: 0.98, reason: "single provider - no second source to cross-check", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  },
};
