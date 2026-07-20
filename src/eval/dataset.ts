// Labeled eval dataset for the decode pipeline. Ground-truth labels: what each barcode SHOULD decode to
// and whether an accurate pipeline SHOULD auto-count it. The 9 real tires the owner scanned + the poison.
// shouldAutoCount=true means "an accurate, safe pipeline auto-counts this"; the poison MUST be false.

export interface EvalLabel {
  code: string;
  expectedBrand: string;
  expectedType: "tire" | "non_tire";
  /** Ground truth: should an accurate + safe pipeline auto-count this without human review? */
  shouldAutoCount: boolean;
  /**
   * Ground truth: the decode STATUS a correct, honest pipeline must produce for this class
   * (P5 Task 4 - golden precision gates). "verified" requires app-verified exact-code evidence
   * (or human/account approval); a bare model/API self-report must score "suggested", never
   * "verified" (D6). Optional so the original 9-tire + poison rows (identity-accuracy fixtures,
   * pre-dating the per-class gate) are unaffected.
   */
  expectedStatus?: "verified" | "suggested" | "conflict" | "needs_review";
  note?: string;
}

export const EVAL_DATASET: EvalLabel[] = [
  { code: "086699205636", expectedBrand: "Michelin", expectedType: "tire", shouldAutoCount: true },
  { code: "051342144969", expectedBrand: "Continental", expectedType: "tire", shouldAutoCount: true },
  { code: "029142712886", expectedBrand: "Cooper", expectedType: "tire", shouldAutoCount: true },
  { code: "029142815167", expectedBrand: "Cooper", expectedType: "tire", shouldAutoCount: true },
  { code: "8807622002083", expectedBrand: "Nexen", expectedType: "tire", shouldAutoCount: true },
  { code: "8807622002649", expectedBrand: "Nexen", expectedType: "tire", shouldAutoCount: true },
  { code: "715459332915", expectedBrand: "Hankook", expectedType: "tire", shouldAutoCount: true },
  { code: "697662123125", expectedBrand: "Goodyear", expectedType: "tire", shouldAutoCount: true },
  { code: "697662036067", expectedBrand: "Goodyear", expectedType: "tire", shouldAutoCount: true },
  // POISON: go-upc says "not a valid UPC" and returns a DIFFERENT code 7451254957818 = Manstel rivet kit.
  { code: "745125495781", expectedBrand: "", expectedType: "non_tire", shouldAutoCount: false, note: "poison: non-matching near-code -> Manstel rivet kit" },
];

// P5 Task 4 (golden precision gates): per-class labeled fixtures proving the D6 demotion (Task 1)
// holds through the REAL production gate (canAutoCount / shouldAutoApplySuggestion), not a
// hand-mirrored copy. Each row's `expectedStatus` is ground truth for its class; the eval harness
// scores the fixture's pre-built decision against it. code values are synthetic class labels (not
// real scanned barcodes) - fixtures.ts supplies a pre-built DecodeDecision per class rather than a
// page-fetch product, since gpt_self_report/learned-tier decisions are never built by decideDecode.
export const CLASS_DATASET: EvalLabel[] = [
  {
    code: "gpt-self-report-verified-should-demote-to-suggested",
    expectedBrand: "Falken",
    expectedType: "tire",
    shouldAutoCount: false, // demoted to suggested -> auto-APPLIES onto the row, never auto-COUNTS as verified
    expectedStatus: "suggested",
    note: "D6: a bare GPT self-report on a public barcode (upc_a) must never mint verified",
  },
  {
    code: "gpt-self-report-on-vendor-shape",
    expectedBrand: "Spitz",
    expectedType: "non_tire",
    shouldAutoCount: false,
    expectedStatus: "suggested",
    note: "T20/code-1225: a GPT self-report on a vendor/SKU (numeric_sku) shape must never mint verified",
  },
  {
    code: "app-verified-exact-should-stay-verified",
    expectedBrand: "Michelin",
    expectedType: "tire",
    shouldAutoCount: true,
    expectedStatus: "verified",
    note: "AC5: app-verified exact-code evidence (fetched_source) must still auto-verify unchanged",
  },
  {
    code: "learned-tier-should-stay-suggested",
    expectedBrand: "Cooper",
    expectedType: "tire",
    shouldAutoCount: false,
    expectedStatus: "suggested",
    note: "learned tier is a suggestion by construction, never verified",
  },
  {
    code: "corpus-retail-hit-should-stay-verified",
    expectedBrand: "Coca-Cola",
    expectedType: "non_tire",
    shouldAutoCount: true,
    expectedStatus: "verified",
    note: "AC5: corpus/retail-corpus hit must still auto-verify unchanged",
  },
];
