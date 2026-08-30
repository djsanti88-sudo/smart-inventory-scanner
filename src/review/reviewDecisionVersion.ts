import { buildIdempotencyKey, stableIdempotencyFingerprint } from "@/inventory/idempotency";
import type { UnknownCodeReview } from "@/types";

/**
 * Mint the durable payload identity for one review-state transition. Transport fields are excluded
 * from the fingerprint so the embedded and outer idempotency keys can be assigned atomically.
 */
export function versionReviewDecision(
  review: UnknownCodeReview,
  decisionUpdatedAt: string,
): UnknownCodeReview {
  const semanticPayload = { ...review, decisionUpdatedAt } as Record<string, unknown>;
  delete semanticPayload.idempotencyKey;
  delete semanticPayload.syncStatus;
  const idempotencyKey = buildIdempotencyKey(
    review.businessId,
    review.sessionId,
    `${review.id}:review:${stableIdempotencyFingerprint(semanticPayload)}`,
    "SAVE_UNKNOWN_SCAN",
  );
  return { ...review, decisionUpdatedAt, syncStatus: "pending", idempotencyKey };
}
