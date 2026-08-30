import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { isTireContext, hasRequiredTireSpecs } from "@/services/ai/tireSpecs";
import { detectScanContextConflict } from "@/services/ai/scanContextFirewall";
import { brandNorm } from "@/products/tires/tirePrefixLookup";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { canAutoCount, shouldAutoApplySuggestion, isPublicBarcodeShape, type AutoCountDecision } from "@/stores/scanGates";
import type { AiLookupResult, DecodeDecision } from "@/types";
import { EVAL_DATASET, CLASS_DATASET, type EvalLabel } from "@/eval/dataset";
import { FIXTURES, type DecodeFixture } from "@/eval/fixtures";

// Eval harness CORE (pure, no I/O, no live AI). For each labeled barcode it runs the fixture decode INPUT
// through the REAL pipeline decision logic - verifyEvidence -> decideDecode (or a pre-built decision,
// P5 Task 4) -> firewall -> the REAL production auto-count/auto-apply gate (canAutoCount /
// shouldAutoApplySuggestion from @/stores/scanGates, no hand-mirror) - and scores it against the
// ground-truth label. Measures: identity accuracy, auto-count rate, FALSE-auto-count rate (must be 0),
// FALSE-auto-VERIFIED rate (must be 0 - the D6 class-battery invariant), suggested precision, and
// specs-extracted rate.

export interface EvalRow {
  code: string;
  expectedBrand: string;
  decodedBrand: string;
  decision: string; // verified | suggested | conflict | needs_review
  evidence: string; // strength
  specsOk: boolean;
  autoCount: boolean;
  autoApplySuggested: boolean;
  shouldAutoCount: boolean;
  expectedStatus?: string;
  identityCorrect: boolean;
  falseAutoCount: boolean; // auto-counted when it should NOT have been (poison) - the critical failure
  /** Scored "verified" when the ground-truth expectedStatus says it should NOT be (D6 class battery). */
  falseAutoVerified: boolean;
}

export interface EvalSummary {
  total: number;
  tires: number;
  identityAccuracyPct: number; // brand match over tires
  autoCountRatePct: number; // of items that SHOULD auto-count, how many did
  falseAutoCountRatePct: number; // of items that should NOT, how many wrongly did (MUST be 0)
  /** Of labeled rows with an expectedStatus, how many were wrongly scored "verified" (MUST be 0). */
  falseAutoVerifiedRatePct: number;
  /** Denominator behind falseAutoVerifiedRatePct: count of rows with an expectedStatus. Exposed so a
   *  pct()-based 0% invariant can be asserted non-vacuous (pct(n,0) === 0, so an empty labeled set would
   *  otherwise silently "pass" the falseAutoVerifiedRatePct === 0 gate even with zero rows scored). */
  labeledClassCount: number;
  /** Of labeled rows whose expectedStatus is "suggested", how many the gate scored as "suggested" too. */
  suggestedPrecisionPct: number;
  specsExtractedPct: number; // of tires, how many had full size+load+speed
}

export interface EvalReport {
  rows: EvalRow[];
  summary: EvalSummary;
}

/** Named floor for the labeled-class suggested-precision invariant (P5 Task 4). Fixtures are
 *  ground-truth-labeled by construction, so 100% is the defensible floor on this set - any drop
 *  below it means the real production gate (canAutoCount/shouldAutoApplySuggestion) scored a
 *  known-suggested class as something else. */
export const SUGGESTED_PRECISION_FLOOR_PCT = 100;

/** Derive the decode decision for a fixture: use the pre-built decision when supplied (P5 Task 4
 *  class fixtures), otherwise derive it via the real verifyEvidence -> decideDecode pipeline
 *  (the original page-fetch tire/poison fixtures). */
function decisionFor(code: string, result: AiLookupResult, fx: DecodeFixture): DecodeDecision {
  if (fx.decision) return fx.decision;
  const codeType = detectCodeType(code);
  const ev = verifyEvidence(
    code,
    codeType,
    { sourceUrls: result.sourceUrls ?? [], sourceSnippets: result.sourceSnippets ?? [], groundingChunks: result.groundingChunks ?? [], fetchedSourceText: result.fetchedSourceText },
    { trustedHosts: ["gs1.org", "gtin.info"] },
  );
  return decideDecode({ codeType, results: [result], evidences: [ev], confidenceThreshold: 0.85, code, scanContext: "tire" });
}

/** Score one fixture through the REAL production gate (canAutoCount / shouldAutoApplySuggestion),
 *  never a hand-mirrored copy - so this harness cannot silently drift from production behavior. */
function autoCountGate(
  code: string,
  result: AiLookupResult,
): { autoCount: boolean; autoApplySuggested: boolean; specsOk: boolean; decision: string; evidence: string } {
  const codeType = detectCodeType(code);
  const decision = decisionFor(code, result, FIXTURES[code]);
  const specsOk = isTireContext(result) ? hasRequiredTireSpecs(result) : true;
  const contextConflict = detectScanContextConflict({ scanContext: "tire", code, codeType, result, brandPrefixHints: [] });
  const productNameUsable = isUsableProductName(result.productName);
  const tireOk = isTireContext(result) ? specsOk : true;

  const gateDecision: AutoCountDecision = {
    status: decision.status,
    corroborationPath: decision.corroborationPath,
    confidence: decision.confidence,
    exactCodeEvidenceVerifiedByApp: decision.exactCodeEvidenceVerifiedByApp,
  };
  const countResult = canAutoCount({
    codeType,
    decision: gateDecision,
    productName: result.productName,
    tireOk,
    contextConflict,
    productNameUsable,
  });
  const autoApplySuggested = shouldAutoApplySuggestion({
    autoAddOn: true,
    contextConflict,
    productNameUsable,
    confidence: decision.confidence ?? 0,
    status: decision.status,
    exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
  });
  void isPublicBarcodeShape; // re-exported for callers that need the shape check; unused directly here

  return {
    autoCount: countResult.allowed,
    autoApplySuggested,
    specsOk: isTireContext(result) ? hasRequiredTireSpecs(result) : false,
    decision: decision.status,
    evidence: decision.evidenceStrength,
  };
}

function scoreOne(label: EvalLabel, fx: DecodeFixture): EvalRow {
  const r = fx.result;
  // The harness reads evidence from the result's fetchedSourceText (the page the app fetched).
  const result: AiLookupResult = { ...r, fetchedSourceText: fx.fetchedSourceText };
  const g = autoCountGate(label.code, result);
  const decodedBrand = result.brand ?? "";
  const identityCorrect =
    label.expectedStatus !== undefined
      ? g.decision === label.expectedStatus
      : label.expectedType === "tire"
        ? !!brandNorm(decodedBrand) && (brandNorm(decodedBrand) === brandNorm(label.expectedBrand) || brandNorm(decodedBrand).includes(brandNorm(label.expectedBrand)) || brandNorm(label.expectedBrand).includes(brandNorm(decodedBrand)))
        : !g.autoCount; // for the poison, "correct" = it did NOT auto-count
  return {
    code: label.code,
    expectedBrand: label.expectedBrand || "(none)",
    decodedBrand: decodedBrand || "(none)",
    decision: g.decision,
    evidence: g.evidence,
    specsOk: g.specsOk,
    autoCount: g.autoCount,
    autoApplySuggested: g.autoApplySuggested,
    shouldAutoCount: label.shouldAutoCount,
    expectedStatus: label.expectedStatus,
    identityCorrect,
    falseAutoCount: g.autoCount && !label.shouldAutoCount,
    falseAutoVerified: label.expectedStatus !== undefined && label.expectedStatus !== "verified" && g.decision === "verified",
  };
}

export function runEval(
  dataset: EvalLabel[] = [...EVAL_DATASET, ...CLASS_DATASET],
  fixtures: Record<string, DecodeFixture> = FIXTURES,
): EvalReport {
  const rows = dataset.map((label) => {
    const fx = fixtures[label.code];
    if (!fx) throw new Error(`No fixture for ${label.code} (mock mode requires a fixture; use --live for real).`);
    return scoreOne(label, fx);
  });

  const tires = rows.filter((_, i) => dataset[i].expectedType === "tire");
  const shouldAuto = rows.filter((r) => r.shouldAutoCount);
  const shouldNot = rows.filter((r) => !r.shouldAutoCount);
  const labeledClasses = rows.filter((r) => r.expectedStatus !== undefined);
  const shouldBeSuggested = labeledClasses.filter((r) => r.expectedStatus === "suggested");
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

  const summary: EvalSummary = {
    total: rows.length,
    tires: tires.length,
    identityAccuracyPct: pct(tires.filter((r) => r.identityCorrect).length, tires.length),
    autoCountRatePct: pct(shouldAuto.filter((r) => r.autoCount).length, shouldAuto.length),
    falseAutoCountRatePct: pct(shouldNot.filter((r) => r.autoCount).length, shouldNot.length),
    falseAutoVerifiedRatePct: pct(labeledClasses.filter((r) => r.falseAutoVerified).length, labeledClasses.length),
    labeledClassCount: labeledClasses.length,
    suggestedPrecisionPct: pct(shouldBeSuggested.filter((r) => r.decision === "suggested").length, shouldBeSuggested.length),
    specsExtractedPct: pct(tires.filter((r) => r.specsOk).length, tires.length),
  };
  return { rows, summary };
}

/** Render the baseline as a printable markdown report. */
export function formatReport(report: EvalReport): string {
  const { rows, summary } = report;
  const head = "| code | expected | decoded | decision | evidence | specs | auto-count | want | ok |";
  const sep = "|------|----------|---------|----------|----------|-------|------------|------|----|";
  const body = rows
    .map((r) => {
      const ok = r.falseAutoCount ? "FALSE+" : r.autoCount === r.shouldAutoCount ? "ok" : "miss";
      return `| ${r.code} | ${r.expectedBrand} | ${r.decodedBrand} | ${r.decision} | ${r.evidence} | ${r.specsOk ? "Y" : "-"} | ${r.autoCount ? "Y" : "-"} | ${r.shouldAutoCount ? "Y" : "-"} | ${ok} |`;
    })
    .join("\n");
  const s = summary;
  const summaryBlock = [
    "",
    "BASELINE (mock/offline fixtures — representative single-provider page-fetch, NOT live):",
    `  items:                 ${s.total} (${s.tires} tires + ${s.total - s.tires} poison)`,
    `  identity accuracy:     ${s.identityAccuracyPct}%  (decoded brand matches expected, over tires)`,
    `  auto-count rate:       ${s.autoCountRatePct}%  (of items that SHOULD auto-count)`,
    `  FALSE auto-count rate: ${s.falseAutoCountRatePct}%  (of items that should NOT — MUST be 0)`,
    `  specs extracted:       ${s.specsExtractedPct}%  (full size+load+speed, over tires)`,
  ].join("\n");
  return `${head}\n${sep}\n${body}\n${summaryBlock}\n`;
}
