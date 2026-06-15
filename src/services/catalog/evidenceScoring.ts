import type { SourceTier } from "./sourceTrust";
import { isTrustedTier } from "./sourceTrust";

// Deterministic, lightweight (synchronous, no I/O) confidence scoring. It scores EVIDENCE, not the
// model's self-reported confidence. Built to auto-approve strong evidence-backed matches and route
// only genuinely weak/risky ones to review.

export interface ScoreFlags {
  exactBarcodeEvidence: boolean; // app independently confirmed the exact code in real evidence
  // The decode decision is "verified" AND the app independently confirmed the exact code in STRONG
  // evidence. This is the trust signal that carries the fast path - it must not be capped away by the
  // Tier-3/single-provider heuristic (that heuristic is a proxy for "is the evidence real"; here the
  // app already confirmed it directly).
  appVerifiedStrongEvidence: boolean;
  // The decode returned a real product candidate (status verified or suggested). Trust-the-AI gate:
  // a usable product is auto-added; only genuinely-bad cases go to review.
  decodedAProduct: boolean;
  sourceTier: SourceTier;
  independentAgreement: boolean; // 2+ independent sources/providers agree on identity
  usableName: boolean;
  hasBrandOrCategory: boolean;
  aiMatchesEvidence: boolean;
  priorShopConfirmation: boolean;
  priorCommunityConfirmation: boolean;
  // negatives
  conflictingNames: boolean;
  aiOnlyNoEvidence: boolean;
  vendorCodeNoAlias: boolean;
  weakGenericName: boolean;
  privateDataDetected: boolean;
  conflictsVerifiedCatalog: boolean;
}

export interface AutoVerifySettings {
  autoCatalogLearningEnabled: boolean;
  autoVerifyConfidenceThreshold: number;
  trustedSourceAutoVerifyEnabled: boolean;
  aiOnlyAutoVerifyAllowed: boolean;
}

export type AutoVerifyStatus = "auto_verify" | "auto_count" | "needs_review";

export interface AutoVerifyDecision {
  status: AutoVerifyStatus;
  score: number;
  verifiedBy: "trusted_source" | "evidence_score" | null;
  reason: string;
  blockingReasons: string[];
}

const TIER_POINTS: Record<SourceTier, number> = {
  authoritative: 60,
  strong_commercial: 45,
  supporting: 20,
  weak: 0,
};

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/** Pure 0-100 evidence score. `trustedSourceBonus=false` removes the tier-1/2 boost (so a trusted
 *  source can't shortcut auto-verify when the owner disables trusted-source auto-verify). */
export function scoreCatalogCandidate(flags: ScoreFlags, opts?: { trustedSourceBonus?: boolean }): number {
  const trustedBonus = opts?.trustedSourceBonus !== false;
  // When trusted-source auto-verify is disabled, a trusted source is treated as merely "supporting"
  // for BOTH points and caps - so it can no longer shortcut auto-verify on its own.
  const effectiveTier: SourceTier =
    !trustedBonus && isTrustedTier(flags.sourceTier) ? "supporting" : flags.sourceTier;
  let score = 0;

  if (flags.exactBarcodeEvidence) score += 40;
  else score -= 40;

  score += TIER_POINTS[effectiveTier];

  // App-confirmed strong evidence is a major positive signal (folds evidence STRENGTH into the score).
  if (flags.appVerifiedStrongEvidence) score += 30;
  if (flags.independentAgreement) score += 20;
  if (flags.usableName) score += 10;
  else score -= 40; // junk/unusable name
  if (flags.hasBrandOrCategory) score += 10;
  if (flags.aiMatchesEvidence) score += 10;
  if (flags.priorShopConfirmation) score += 15;
  if (flags.priorCommunityConfirmation) score += 10;

  if (flags.conflictingNames) score -= 35;
  if (flags.aiOnlyNoEvidence) score -= 30;
  if (flags.vendorCodeNoAlias) score -= 30;
  if (flags.weakGenericName) score -= 20;
  if (flags.sourceTier === "weak") score -= 50;
  if (flags.privateDataDetected) score -= 50;

  // Caps that prevent over-trusting thin evidence (use the effective tier). The Tier-3 single-provider
  // cap does NOT apply when the app independently confirmed the exact code in strong evidence.
  if (flags.aiOnlyNoEvidence) score = Math.min(score, 60);
  if (effectiveTier === "supporting" && !flags.independentAgreement && !flags.appVerifiedStrongEvidence) {
    score = Math.min(score, 79);
  }
  if (effectiveTier === "weak") score = Math.min(score, 50);

  return clamp(score);
}

/**
 * TRUST-THE-AI gate. If the decode returned a usable product, auto-add + count it. Only the genuinely
 * bad cases go to review: no usable product, provider/catalog conflict, vendor/internal code, or
 * private data. Source tier / single-provider / "junk-looking" URLs / a low score NEVER block a real
 * product - they only decide catalog metadata. The score is informational, not a gate.
 */
export function decideAutoVerification(flags: ScoreFlags, settings: AutoVerifySettings): AutoVerifyDecision {
  const score = scoreCatalogCandidate(flags, { trustedSourceBonus: settings.trustedSourceAutoVerifyEnabled });

  const blockingReasons: string[] = [];
  if (!flags.decodedAProduct || !flags.usableName) {
    blockingReasons.push(
      flags.exactBarcodeEvidence && !flags.usableName
        ? "Exact barcode evidence was found, but no usable product identity was returned"
        : "No usable product was returned by the decode",
    );
  }
  if (flags.conflictsVerifiedCatalog) blockingReasons.push("Conflicts with a verified catalog entry");
  if (flags.conflictingNames) blockingReasons.push("Providers disagree on the product identity");
  if (flags.vendorCodeNoAlias) blockingReasons.push("Vendor/internal code without an approved alias");
  if (flags.privateDataDetected) blockingReasons.push("Private/shop data detected");

  if (blockingReasons.length > 0) {
    return { status: "needs_review", score, verifiedBy: null, reason: blockingReasons[0], blockingReasons };
  }

  // Trusted product -> auto-save + count. Catalog is marked VERIFIED only with app-confirmed exact
  // evidence; otherwise the product is still counted + aliased locally with a PENDING catalog entry
  // (verifiedBy null signals the caller to write a pending, not verified, global catalog entry).
  const verifiedBy: AutoVerifyDecision["verifiedBy"] = flags.exactBarcodeEvidence
    ? settings.trustedSourceAutoVerifyEnabled && isTrustedTier(flags.sourceTier)
      ? "trusted_source"
      : "evidence_score"
    : null;
  return {
    status: settings.autoCatalogLearningEnabled ? "auto_verify" : "auto_count",
    score,
    verifiedBy,
    reason: flags.exactBarcodeEvidence
      ? `App-confirmed exact barcode evidence (score ${score}).`
      : `AI product accepted (score ${score}).`,
    blockingReasons: [],
  };
}
