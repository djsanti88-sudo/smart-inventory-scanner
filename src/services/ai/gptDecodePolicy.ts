import { emptyResult } from "@/services/ai/provider";
import { isVendorLabel } from "@/products/match/codeTypeDetector";
import type { AiLookupResult, CrossCheckResult, DecodeDecision } from "@/types";
import type { GptDecodeResult } from "./gptDecodeClient";

export interface GptDecodeGateInput {
  code: string;
  codeType: string;
  apiKeyPresent: boolean;
  /** Lazy so a rejected code or missing key never performs a storage read. */
  budget: () => Promise<{ allowed: boolean; spentUsd: number; capUsd: number }>;
}

export interface GptDecodePayload {
  result: AiLookupResult;
  decision: DecodeDecision;
  reasonText: string;
}

/** Decide whether the one paid provider may run. Free tiers and E2E fixture handling live upstream. */
export async function shouldRunGptDecode(input: GptDecodeGateInput): Promise<{ run: boolean; skipReason: string }> {
  if (input.codeType === "vendor_label" || isVendorLabel(input.code)) {
    return { run: false, skipReason: "non_public_code_type" };
  }
  if (!input.apiKeyPresent) {
    return { run: false, skipReason: "no_api_key" };
  }
  if (!(await input.budget()).allowed) {
    return { run: false, skipReason: "budget_exceeded" };
  }
  return { run: true, skipReason: "" };
}

const EXACT_SELF_REPORT_REASON =
  "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.";
const BEST_GUESS_REASON = "Best guess based on available evidence - review before confirming.";

function singleProviderCrossCheck(confidence: number): CrossCheckResult {
  return {
    decision: "single_provider",
    confidence,
    reason: "single provider - no second source to cross-check",
    brandSimilarity: 0,
    nameSimilarity: 0,
    contradictions: [],
  };
}

function identifierFields(gtin: string): { gtin: string; upc: string; ean: string } {
  const digits = (gtin || "").replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 14) return { gtin: "", upc: "", ean: "" };
  return {
    gtin: digits,
    upc: digits.length === 12 ? digits : "",
    ean: digits.length === 13 ? digits : "",
  };
}

/** Map every non-empty model identity to a reviewable suggestion. GPT never verifies truth. */
export function mapGptDecodeResult(result: GptDecodeResult, scannedCode: string): GptDecodePayload | null {
  if (result.tier === "none") return null;

  const identifiers = identifierFields(result.gtin);
  const identity: AiLookupResult = {
    ...emptyResult(),
    productName: result.productName,
    brand: result.brand,
    category: result.category,
    specsShort: result.specs,
    primaryBarcode: scannedCode,
    ...identifiers,
    sourceUrls: result.sourceUrls,
    confidence: result.confidence,
    guesses: result.basis ? [result.basis] : [],
    needsHumanReview: true,
  };
  const exactSelfReport = result.tier === "verified";
  const decision: DecodeDecision = {
    status: "suggested",
    confidence: result.confidence,
    reason: exactSelfReport ? EXACT_SELF_REPORT_REASON : BEST_GUESS_REASON,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: singleProviderCrossCheck(result.confidence),
    ...(exactSelfReport ? { corroborationPath: "gpt_self_report" as const } : {}),
  };
  return { result: identity, decision, reasonText: "" };
}
