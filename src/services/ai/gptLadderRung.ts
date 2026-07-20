// GPT-5.5 "from scratch" ladder rung — pure decision helpers, testable without Next.
// This module NEVER calls fetch/OpenAI itself (that is gptFromScratch.ts) and NEVER reads env
// (that is aiSpendGuard.ts / the route). It only decides (a) whether the rung should run at all,
// and (b) how to translate a GptFromScratchResult into the route's existing decision/result shape.
//
// REBUILT 2026-07-06 per owner order ("no hints, no questioning their answers, no hardcoded
// rules"): the wrapper that second-guessed GPT is DELETED. Gone: the short-code (<10 digit)
// verified->suggested downgrade, the prefix-firewall tier cap (capTierForFirewall), and the
// info_only tier that buried weak guesses with an emptied productName. GPT's answer maps
// straight through: verified auto-counts (owner rule: exactCodeFound + confidence >= 0.8),
// everything else with a productName is a visible suggestion for human review.
import { emptyResult } from "@/services/ai/provider";
import { isVendorLabel } from "@/services/codeTypeDetector";
import type { AiLookupResult, CrossCheckResult, DecodeDecision } from "@/types";
import type { GptFromScratchResult } from "./gptFromScratch";

export interface GptRungInput {
  code: string;
  codeType: string; // from the route's detectCodeType result
  priorStatus: string | undefined; // decision?.status of the ladder so far
  e2e: boolean;
  apiKeyPresent: boolean;
  // LAZY on purpose: checkGptLadderBudget() does a synchronous file read. It must only run once every
  // cheaper/earlier check (prior status, codeType, e2e, api key) has already passed - so this is a
  // thunk, not a pre-computed value, and shouldRunGptRung calls it ONLY when it reaches this check.
  budget: () => { allowed: boolean; spentUsd: number; capUsd: number };
}

export type GptRungDecodePayload = {
  result: AiLookupResult;
  decision: DecodeDecision;
  reasonText: string;
};

/**
 * Decide whether the GPT-5.5 ladder rung should run for this code. Every "no" carries an explicit,
 * distinct reason so the caller can log/report WHY the paid rung was skipped (never a silent skip).
 * Order matters only in that the first matching reason wins; each check is otherwise independent.
 */
export function shouldRunGptRung(i: GptRungInput): { run: boolean; skipReason: string } {
  // The ladder already produced an answer strong enough to act on - the paid rung would be pure
  // waste. A needs_review/conflict prior status is exactly what this rung exists to try to resolve,
  // so those do NOT skip.
  if (i.priorStatus === "verified" || i.priorStatus === "suggested") {
    return { run: false, skipReason: "prior_status_already_decided" };
  }
  // Vendor/warehouse labels (Amazon FNSKU/ASIN, X00.../B0...) are never real product barcodes and
  // must never reach GPT as if they were one. Re-check the raw code shape too (isVendorLabel), not
  // just the caller-supplied codeType, in case a stale/client-supplied codeType disagrees with the
  // actual code (semantic-firewall defense in depth).
  if (i.codeType === "vendor_label" || isVendorLabel(i.code)) {
    return { run: false, skipReason: "non_public_code_type" };
  }
  if (i.e2e) {
    return { run: false, skipReason: "e2e_mode" };
  }
  if (!i.apiKeyPresent) {
    return { run: false, skipReason: "no_api_key" };
  }
  // Cheapest checks above all passed - only NOW pay for the budget guard's sync file read.
  if (!i.budget().allowed) {
    return { run: false, skipReason: "budget_exceeded" };
  }
  return { run: true, skipReason: "" };
}

// BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): these used to name the model
// ("gpt-5.5 from-scratch: ...") in customer-facing decision.reason text. The model name is
// gratuitous here - the honest, token-free wording below still says exactly what matters: the
// identity was self-reported by the exact code, or is a best guess.
//
// D6 core (2026-07-20, decode-trust): a bare model self-report can never mint a "Verified"
// identity - see gptResultToDecodePayload's r.tier === "verified" branch below, which now maps to
// status "suggested". The wording reflects that: this is a suggestion, not an auto-count claim.
const GPT_LADDER_REASON =
  "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.";
const GPT_LADDER_SUGGEST_REASON = "Best guess based on available evidence - review before confirming.";

function crossCheckSingleProvider(confidence: number): CrossCheckResult {
  return {
    decision: "single_provider",
    confidence,
    // Token-free (QA #14 sweep): this crossCheck reason rides in the raw API payload; keep it free
    // of internal rung/model names as defense-in-depth even though no UI currently renders it.
    reason: "single provider - no second source to cross-check",
    brandSimilarity: 0,
    nameSimilarity: 0,
    contradictions: [],
  };
}

/** Populate the identifier fields ONLY when the reported gtin is a plausible 12-14 digit barcode. */
function identifierFieldsFrom(gtin: string): { gtin: string; upc: string; ean: string } {
  const digits = (gtin || "").replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 14) return { gtin: "", upc: "", ean: "" };
  return {
    gtin: digits,
    upc: digits.length === 12 ? digits : "",
    ean: digits.length === 13 ? digits : "",
  };
}

/**
 * Map a GptFromScratchResult onto the route's existing decision/result payload shape,
 * EXACTLY as returned (owner rule): verified auto-counts, anything else with a productName is
 * a plain visible suggestion. Returns null only when tier is "none" (no product name at all -
 * the ladder ends at Needs Review with whatever reason the earlier rungs already set).
 */
export function gptResultToDecodePayload(r: GptFromScratchResult, code: string): GptRungDecodePayload | null {
  if (r.tier === "none") return null;

  const ids = identifierFieldsFrom(r.gtin);
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: r.productName,
    brand: r.brand,
    category: r.category,
    specsShort: r.specs,
    primaryBarcode: code,
    gtin: ids.gtin,
    upc: ids.upc,
    ean: ids.ean,
    sourceUrls: r.sourceUrls,
    confidence: r.confidence,
    verifiedFacts: [],
    guesses: r.basis ? [r.basis] : [],
    needsHumanReview: r.tier !== "verified",
  };

  if (r.tier === "verified") {
    // D6 core (2026-07-20): a bare GPT self-report can never mint "verified" - it is demoted to a
    // suggestion. corroborationPath stays "gpt_self_report" and exactCodeEvidenceVerifiedByApp stays
    // false (both already honest); only the status changes. A high-confidence suggestion still
    // auto-applies its identity onto the counted row via shouldAutoApplySuggestion (scanGates.ts) -
    // this demotion changes the badge/alias decision, never whether the scan appears or counts.
    const decision: DecodeDecision = {
      status: "suggested",
      confidence: r.confidence,
      reason: GPT_LADDER_REASON,
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: crossCheckSingleProvider(r.confidence),
      corroborationPath: "gpt_self_report",
    };
    return { result, decision, reasonText: "" };
  }

  // Everything else with a productName is a suggestion, shown exactly as GPT returned it.
  const decision: DecodeDecision = {
    status: "suggested",
    confidence: r.confidence,
    reason: GPT_LADDER_SUGGEST_REASON,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: crossCheckSingleProvider(r.confidence),
  };
  return { result, decision, reasonText: "" };
}
