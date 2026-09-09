import type { AiLookupResult, CodeType, DecodeDecision } from "@/types";
import type { CatalogEntry } from "./catalogTypes";
import { isUsableProductName } from "@/decoding/decode";
import { bestTier, type SourceTier } from "./sourceTrust";
import { findEntry } from "./localCatalogProvider";
import {
  decideAutoVerification,
  type AutoVerifySettings,
  type AutoVerifyStatus,
  type ScoreFlags,
} from "./evidenceScoring";

// Ties the existing decode response (no new network calls) to the deterministic evidence score and
// the catalog state, and decides whether to auto-verify, auto-count, or send to Needs Review. Pure.

export interface AutoVerifyPlan {
  status: AutoVerifyStatus;
  score: number;
  verifiedBy: "trusted_source" | "evidence_score" | null;
  sourceTier: SourceTier;
  reason: string;
  blockingReasons: string[];
  evidenceSummary: string;
}

const normName = (n: string) => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export interface PlanAutoVerifyParams {
  code: string;
  codeType: CodeType;
  decision: Pick<DecodeDecision, "status" | "evidenceStrength" | "exactCodeEvidenceVerifiedByApp" | "crossCheck">;
  best: AiLookupResult | null;
  catalog: CatalogEntry[];
  settings: AutoVerifySettings;
}

export function planAutoVerify(params: PlanAutoVerifyParams): AutoVerifyPlan {
  const { code, codeType, decision, best, catalog, settings } = params;

  const sourceUrls = best?.sourceUrls ?? [];
  const sourceTier = bestTier(sourceUrls); // tier from the cited source URLs (no fetch)
  const name = best?.productName ?? "";
  const usableName = isUsableProductName(name);

  const existing = findEntry(catalog, [code]);
  const conflictsVerifiedCatalog =
    !!existing && existing.verificationStatus === "verified" && normName(existing.name) !== normName(name) && !!name;
  const priorShopConfirmation = !!existing && existing.timesConfirmed > 0;
  const priorCommunityConfirmation = existing?.verifiedBy === "community";

  const flags: ScoreFlags = {
    exactBarcodeEvidence: !!decision.exactCodeEvidenceVerifiedByApp,
    // The decode itself is "verified" and the app independently confirmed the exact code. This is the
    // strong-evidence fast-path signal (decideDecode only returns "verified" with strong app-verified
    // evidence on a public barcode), so it must not be capped away by the Tier-3/single-provider rule.
    appVerifiedStrongEvidence: decision.status === "verified" && !!decision.exactCodeEvidenceVerifiedByApp,
    decodedAProduct: decision.status === "verified" || decision.status === "suggested",
    sourceTier,
    independentAgreement: decision.crossCheck?.decision === "agree",
    usableName,
    hasBrandOrCategory: !!(best?.brand || best?.category),
    aiMatchesEvidence: !!decision.exactCodeEvidenceVerifiedByApp,
    priorShopConfirmation,
    priorCommunityConfirmation,
    conflictingNames: decision.crossCheck?.decision === "conflict" || decision.status === "conflict",
    aiOnlyNoEvidence: decision.evidenceStrength === "none",
    vendorCodeNoAlias: codeType === "vendor_label",
    weakGenericName: false,
    privateDataDetected: false,
    conflictsVerifiedCatalog,
  };

  const decided = decideAutoVerification(flags, settings);
  const evidenceSummary = `${decision.evidenceStrength.replace(/_/g, " ")} evidence; ${sourceTier.replace("_", " ")} source; ${sourceUrls.length} source(s)`;

  return {
    status: decided.status,
    score: decided.score,
    verifiedBy: decided.verifiedBy,
    sourceTier,
    reason: decided.reason,
    blockingReasons: decided.blockingReasons,
    evidenceSummary,
  };
}
