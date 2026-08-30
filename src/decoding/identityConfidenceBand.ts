import type { DecodeDecision, IdentityConfidenceBand, UnknownCodeReview } from "@/types";

/**
 * THE single confidence-band rule (owner decision 2026-08-19). The product shows an app-derived band,
 * never a raw provider percentage: a provider's self-reported number is uncalibrated and reads as
 * precision the app cannot back. The raw number stays in the data for audit.
 *
 * high   - the APP verified the identity itself: an app-verified exact code, or a decode the app
 *          settled as "verified". A provider self-claim can never reach this band.
 * medium - a suggestion the app already trusts enough to apply onto the counted row without a human:
 *          the same line shouldAutoApplySuggestion uses (confidence >= 0.8 on a non-verified decode),
 *          or a suggestion whose evidence the app actually fetched ("fetched_source").
 * low    - every other guess: weak or no evidence.
 */
export function getIdentityConfidenceBand(
  decision:
    | Partial<Pick<DecodeDecision, "status" | "confidence" | "evidenceStrength" | "exactCodeEvidenceVerifiedByApp">>
    | null
    | undefined,
): IdentityConfidenceBand {
  if (!decision) return "low";
  if (decision.exactCodeEvidenceVerifiedByApp === true || decision.status === "verified") return "high";
  if ((decision.confidence ?? 0) >= 0.8 || decision.evidenceStrength === "fetched_source") return "medium";
  return "low";
}

/** The same rule applied to a review record (the decode's fields the review kept), so a row whose
 *  identity is read from its review bands exactly like a row carrying the decision itself. */
export function getReviewIdentityBand(
  review: Pick<UnknownCodeReview, "decodeStatus" | "confidence" | "evidenceStrength" | "exactCodeEvidenceVerifiedByApp" | "identityBand">,
): IdentityConfidenceBand {
  // A review rehydrated from the customer-safe persist carries the derived band and none of its inputs.
  if (review.identityBand) return review.identityBand;
  return getIdentityConfidenceBand({
    status: review.decodeStatus === "verified" ? "verified" : undefined,
    confidence: review.confidence,
    evidenceStrength: review.evidenceStrength,
    exactCodeEvidenceVerifiedByApp: review.exactCodeEvidenceVerifiedByApp,
  });
}

/** Row copy for an unconfirmed identity, e.g. "Suggested - medium confidence". Never a percentage. */
export function identityBandLabel(band: IdentityConfidenceBand): string {
  return `Suggested - ${band} confidence`;
}

/** The band on its own, for a table cell under a "Confidence" header: "High" / "Medium" / "Low". */
export function identityBandWord(band: IdentityConfidenceBand): string {
  return band.charAt(0).toUpperCase() + band.slice(1);
}
