// GPT-5.5 "from scratch" ladder rung — pure decision helpers, testable without Next.
// This module NEVER calls fetch/OpenAI itself (that is gptFromScratch.ts) and NEVER reads env
// (that is aiSpendGuard.ts / the route). It only decides (a) whether the rung should run at all,
// and (b) how to translate a GptFromScratchResult into the route's existing decision/result shape.
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
  budget: { allowed: boolean; spentUsd: number; capUsd: number };
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
  if (!i.budget.allowed) {
    return { run: false, skipReason: "budget_exceeded" };
  }
  return { run: true, skipReason: "" };
}

const GPT_LADDER_REASON = "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)";

function crossCheckSingleProvider(confidence: number): CrossCheckResult {
  return {
    decision: "single_provider",
    confidence,
    reason: "gpt-5.5 ladder rung: single provider, no second AI to cross-check",
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
 * Map a GptFromScratchResult onto the route's existing decision/result payload shape.
 * Returns null when tier is "none" (nothing usable to apply - the ladder ends at Needs Review
 * with whatever reason the earlier rungs already set).
 */
export function gptResultToDecodePayload(r: GptFromScratchResult, code: string): GptRungDecodePayload | null {
  if (r.tier === "none") return null;

  const ids = identifierFieldsFrom(r.gtin);
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: r.productName,
    brand: r.brand,
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
    const decision: DecodeDecision = {
      status: "verified",
      confidence: r.confidence,
      reason: GPT_LADDER_REASON,
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: crossCheckSingleProvider(r.confidence),
      corroborationPath: "gpt_self_report",
    };
    return { result, decision, reasonText: "" };
  }

  if (r.tier === "suggested") {
    const decision: DecodeDecision = {
      status: "suggested",
      confidence: r.confidence,
      reason: GPT_LADDER_REASON,
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: crossCheckSingleProvider(r.confidence),
    };
    return { result, decision, reasonText: "" };
  }

  // tier === "info_only": background info, never auto-count-worthy. Prefixed reasonText lets the
  // client (Task 5) route this distinctly from a normal needs_review with no lead at all.
  const reasonText = `background info only: ${r.basis || r.productName}`;
  const decision: DecodeDecision = {
    status: "needs_review",
    confidence: r.confidence,
    reason: reasonText,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: crossCheckSingleProvider(r.confidence),
  };
  return { result, decision, reasonText };
}

/**
 * The catalog-derived brand-prefix firewall still gates AUTO-COUNT even for a GPT self-report:
 * a "verified" payload whose brand conflicts with the barcode's known prefix owner is downgraded to
 * "suggested" (never silently dropped - the human still sees the lead, just not auto-counted).
 * Never upgrades anything; a no-conflict or already-non-verified payload passes through unchanged.
 */
export function capTierForFirewall(payload: GptRungDecodePayload | null, conflict: boolean): GptRungDecodePayload | null {
  if (!payload || !conflict || payload.decision.status !== "verified") return payload;
  return {
    ...payload,
    result: { ...payload.result, needsHumanReview: true },
    decision: {
      ...payload.decision,
      status: "suggested",
      reason: `${payload.decision.reason} | prefix-firewall conflict: auto-count blocked`,
      corroborationPath: undefined,
    },
  };
}
