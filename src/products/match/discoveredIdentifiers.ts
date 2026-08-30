import { normalizeCode } from "@/services/codeNormalizer";
import type { UnknownCodeReview } from "@/types";

/**
 * Collects the discovered identifiers a decode/page-fetch surfaced on a review (extra
 * UPC/EAN/GTIN/SKU/codes), deduped by clean code and excluding the scanned code itself
 * (aliased separately on resolve). These are SUGGESTIONS only - a human selects which to
 * approve; nothing here is trusted or saved automatically until resolveUnknown is called
 * with the selected codes.
 *
 * Shared by NeedsReviewTable's per-row selection UI and scanStore's batchApprove (Build 3),
 * so the default "select all discovered identifiers" behavior can never drift between the
 * single-approve and batch-approve paths.
 */
export function buildDiscoveredIdentifiers(review: UnknownCodeReview): { code: string; label: string }[] {
  const raw: { code: string; label: string }[] = [];
  if (review.suggestedPrimarySku) raw.push({ code: review.suggestedPrimarySku, label: "Suggested SKU / part number" });
  if (review.suggestedUpc) raw.push({ code: review.suggestedUpc, label: "Suggested UPC" });
  if (review.suggestedEan) raw.push({ code: review.suggestedEan, label: "Suggested EAN" });
  if (review.suggestedGtin) raw.push({ code: review.suggestedGtin, label: "Suggested GTIN" });
  for (const a of review.suggestedAliases ?? []) raw.push({ code: a, label: "Suggested code" });
  const scanned = normalizeCode(review.cleanCode).clean;
  const seen = new Set<string>();
  const out: { code: string; label: string }[] = [];
  for (const r of raw) {
    const clean = normalizeCode(r.code).clean;
    if (!clean || clean === scanned || seen.has(clean)) continue;
    seen.add(clean);
    out.push(r);
  }
  return out;
}
