// Server-side decode policy clamps. The client sends a confidenceThreshold as a UX preference, but a
// hand-crafted request must never be able to force every decode to "verified" (threshold 0) or to
// "needs_review" (threshold >1). Mirrors the clampDecodeBudgetMs pattern already used for budgetMs.

export const DEFAULT_THRESHOLD = 0.8;
export const MIN_THRESHOLD = 0.6; // never auto-verify below strong app-verified evidence policy
export const MAX_THRESHOLD = 0.95; // never make verification effectively impossible from the client

export function clampConfidenceThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(Math.max(value, MIN_THRESHOLD), MAX_THRESHOLD);
}
