import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { isTireContext, hasRequiredTireSpecs } from "@/services/ai/tireSpecs";
import { detectScanContextConflict } from "@/services/ai/scanContextFirewall";
import { brandNorm } from "@/services/tire/tirePrefixLookup";
import { detectCodeType } from "@/services/codeTypeDetector";
import type { AiLookupResult } from "@/types";
import { EVAL_DATASET, type EvalLabel } from "@/eval/dataset";
import { FIXTURES, type DecodeFixture } from "@/eval/fixtures";

// Eval harness CORE (pure, no I/O, no live AI). For each labeled barcode it runs the fixture decode INPUT
// through the REAL pipeline decision logic - verifyEvidence -> decideDecode -> firewall -> the store's
// auto-count gate - and scores it against the ground-truth label. Measures: identity accuracy, auto-count
// rate, FALSE-auto-count rate (must be 0), and specs-extracted rate.

export interface EvalRow {
  code: string;
  expectedBrand: string;
  decodedBrand: string;
  decision: string; // verified | suggested | conflict | needs_review
  evidence: string; // strength
  specsOk: boolean;
  autoCount: boolean;
  shouldAutoCount: boolean;
  identityCorrect: boolean;
  falseAutoCount: boolean; // auto-counted when it should NOT have been (poison) - the critical failure
}

export interface EvalSummary {
  total: number;
  tires: number;
  identityAccuracyPct: number; // brand match over tires
  autoCountRatePct: number; // of items that SHOULD auto-count, how many did
  falseAutoCountRatePct: number; // of items that should NOT, how many wrongly did (MUST be 0)
  specsExtractedPct: number; // of tires, how many had full size+load+speed
}

export interface EvalReport {
  rows: EvalRow[];
  summary: EvalSummary;
}

/** Mirror the store auto-count gate (scanStore.ts:1600-1607) for a single decoded source. */
function autoCountGate(code: string, result: AiLookupResult): { autoCount: boolean; specsOk: boolean; decision: string; evidence: string } {
  const codeType = detectCodeType(code);
  const ev = verifyEvidence(
    code,
    codeType,
    { sourceUrls: result.sourceUrls ?? [], sourceSnippets: result.sourceSnippets ?? [], groundingChunks: result.groundingChunks ?? [], fetchedSourceText: result.fetchedSourceText },
    { trustedHosts: ["gs1.org", "gtin.info"] },
  );
  const decision = decideDecode({ codeType, results: [result], evidences: [ev], confidenceThreshold: 0.85, code, scanContext: "tire" });
  const specsOk = isTireContext(result) ? hasRequiredTireSpecs(result) : true;
  const conflict = detectScanContextConflict({ scanContext: "tire", code, codeType, result, brandPrefixHints: [] });
  const autoCount =
    decision.status === "verified" &&
    Boolean(decision.exactCodeEvidenceVerifiedByApp) &&
    (decision.confidence ?? 0) >= 0.9 &&
    isUsableProductName(result.productName) &&
    specsOk &&
    conflict === null;
  return { autoCount, specsOk: isTireContext(result) ? hasRequiredTireSpecs(result) : false, decision: decision.status, evidence: decision.evidenceStrength };
}

function scoreOne(label: EvalLabel, fx: DecodeFixture): EvalRow {
  const r = fx.result;
  // The harness reads evidence from the result's fetchedSourceText (the page the app fetched).
  const result: AiLookupResult = { ...r, fetchedSourceText: fx.fetchedSourceText };
  const g = autoCountGate(label.code, result);
  const decodedBrand = result.brand ?? "";
  const identityCorrect =
    label.expectedType === "tire"
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
    shouldAutoCount: label.shouldAutoCount,
    identityCorrect,
    falseAutoCount: g.autoCount && !label.shouldAutoCount,
  };
}

export function runEval(dataset: EvalLabel[] = EVAL_DATASET, fixtures: Record<string, DecodeFixture> = FIXTURES): EvalReport {
  const rows = dataset.map((label) => {
    const fx = fixtures[label.code];
    if (!fx) throw new Error(`No fixture for ${label.code} (mock mode requires a fixture; use --live for real).`);
    return scoreOne(label, fx);
  });

  const tires = rows.filter((_, i) => dataset[i].expectedType === "tire");
  const shouldAuto = rows.filter((r) => r.shouldAutoCount);
  const shouldNot = rows.filter((r) => !r.shouldAutoCount);
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

  const summary: EvalSummary = {
    total: rows.length,
    tires: tires.length,
    identityAccuracyPct: pct(tires.filter((r) => r.identityCorrect).length, tires.length),
    autoCountRatePct: pct(shouldAuto.filter((r) => r.autoCount).length, shouldAuto.length),
    falseAutoCountRatePct: pct(shouldNot.filter((r) => r.autoCount).length, shouldNot.length),
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
