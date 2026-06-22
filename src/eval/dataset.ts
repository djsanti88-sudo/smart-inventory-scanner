// Labeled eval dataset for the decode pipeline. Ground-truth labels: what each barcode SHOULD decode to
// and whether an accurate pipeline SHOULD auto-count it. The 9 real tires the owner scanned + the poison.
// shouldAutoCount=true means "an accurate, safe pipeline auto-counts this"; the poison MUST be false.

export interface EvalLabel {
  code: string;
  expectedBrand: string;
  expectedType: "tire" | "non_tire";
  /** Ground truth: should an accurate + safe pipeline auto-count this without human review? */
  shouldAutoCount: boolean;
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
