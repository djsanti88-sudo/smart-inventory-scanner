import type { Alias, CleanedCode, Product, ResolverResult } from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";
import { detectCodeType } from "@/services/codeTypeDetector";
import { resolveScanToProductTiered } from "@/services/aliasMatcher";
import { isLikelyMisreadGtin } from "@/services/upc/misread";
import { levenshteinWithin } from "@/services/textDistance";

// QA Task 8 (owner-approved 2026-07-15): review-only near-match SKU suggestion. A typo like
// T432118 scanned when the shop's real SKU is T432119 should not sit as a bare "unknown" - but it
// must NEVER be guessed into a match. This surfaces a "Did you mean <X>?" hint ONLY when exactly
// one verified product/approved-alias code is within Levenshtein distance 1, and only ever as an
// optional field the Needs Review UI can act on through the EXISTING human-approved link_existing
// path (see NeedsReviewTable's suggestedLinkProductId "Link to <product>" pattern). It never
// changes resolverStatus, never auto-counts, never auto-creates an alias.
const NEAR_MATCH_MAX_DISTANCE = 1;
const NEAR_MATCH_MIN_CODE_LENGTH = 5;

function findNearMatchSuggestion(
  cleanCode: string,
  products: Product[],
  aliases: Alias[],
  businessId: string,
): ResolverResult["nearMatchSuggestion"] {
  type Candidate = { productId: string; matchedOn: string; distance: number };
  const candidates: Candidate[] = [];

  const consider = (productId: string, code: string) => {
    if (!code) return;
    const distance = levenshteinWithin(cleanCode, code, NEAR_MATCH_MAX_DISTANCE);
    if (distance !== null && distance > 0) {
      candidates.push({ productId, matchedOn: code, distance });
    }
  };

  // Only VERIFIED products and APPROVED aliases participate - same trust gate as a real Known
  // match. An AI-guessed or unverified product must never seed a suggestion either.
  for (const p of products) {
    if (p.businessId !== businessId || p.status === "archived" || !p.verified) continue;
    consider(p.id, p.primarySku);
    for (const vc of p.vendorCodes ?? []) consider(p.id, vc);
  }
  for (const a of aliases) {
    if (a.businessId !== businessId || !a.approved) continue;
    consider(a.productId, a.cleanCode);
  }

  // Reduce to distinct products (a product may have several near-miss codes; count it once at its
  // best distance) before requiring EXACTLY one candidate overall.
  const byProduct = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = byProduct.get(c.productId);
    if (!existing || c.distance < existing.distance) byProduct.set(c.productId, c);
  }

  if (byProduct.size !== 1) return undefined; // 0 or >=2 distinct products -> never guess.

  const only = [...byProduct.values()][0];
  return { productId: only.productId, matchedOn: only.matchedOn, distance: only.distance };
}

// The ProductResolver. DETERMINISTIC ONLY. It never calls AI and never returns a "suggested" or
// "mock" identity. It returns "known" exclusively when the deterministic matcher hits an APPROVED
// alias or a VERIFIED product identifier (both gates enforced in aliasMatcher). Everything else is
// "needs_review" (unknown, weak, vendor label) or "conflict" (ambiguous). AI suggestions are a
// separate, review-only concern and are never produced here.
//
// Trust hierarchy (high -> low):
//   1. Approved local alias            -> known
//   2. Verified product identifier      -> known
//   3. (AI suggestion)                  -> handled elsewhere, Suggested only, needs approval
//   4. Unknown / vendor label / weak     -> needs_review
//   5. Ambiguous                         -> conflict

// Mirrors csvImport.ts's MAX_FIELD_LENGTH. An unusually long scanned string is almost certainly a
// scanner glitch (e.g. a stuck key repeating) rather than a real code, but the law is absolute: it
// still MUST appear on the feed and count if unmatched, never be dropped. This only adds an honest,
// additive reason - it never blocks resolution, never truncates the stored rawCode.
const SCAN_LENGTH_CAP = 500;

export function resolveScan(
  cleaned: CleanedCode,
  products: Product[],
  aliases: Alias[],
  businessId: string,
): ResolverResult {
  const codeType = detectCodeType(cleaned.cleanCode);
  // P5/D5: route through the cross-tier-conflict-aware resolver. Master slot is empty here on
  // purpose (GC2: this module stays pure/sync, no I/O). Phase 5b (Task 4) wired the real
  // tenant-vs-master feed into the ASYNC path only: scanStore.ts cloudCatalogResolve (~:2460),
  // after a master-catalog entry is fetched, via services/catalog/masterCandidates.ts. This sync
  // call site is unaffected and stays masterCandidates: [] (GC10: the server path is also unwired
  // this phase - documented gap, not an oversight).
  const resolution = resolveScanToProductTiered(cleaned, { products, aliases, masterCandidates: [] }, businessId);

  const base = {
    rawCode: cleaned.rawCode,
    cleanCode: cleaned.cleanCode,
    normalizedCandidates: cleaned.normalizedCandidates,
    codeType,
  };

  if (resolution.matchType === "conflict") {
    return {
      ...base,
      resolverStatus: "conflict",
      matchType: "conflict",
      productId: null,
      confidence: 0,
      reason: "This code maps to more than one product. A human must pick the correct one.",
      conflictProductIds: resolution.conflictProductIds,
    };
  }

  if (resolution.productId) {
    const product = products.find((p) => p.id === resolution.productId);
    const via =
      resolution.matchType === "exact_alias" || resolution.matchType === "normalized_alias"
        ? "an approved alias"
        : `a verified ${resolution.matchType.replace(/_/g, " ")}`;
    return {
      ...base,
      resolverStatus: "known",
      matchType: resolution.matchType,
      productId: resolution.productId,
      confidence: 1,
      reason: `Matched ${product?.name ?? "a product"} via ${via}.`,
    };
  }

  // No deterministic match -> Needs Review (unknown is acceptable; wrong identity is not).
  // P4 (Task 8) - FNSKU honesty: an X00-prefixed vendor label is an Amazon FULFILLMENT label (FNSKU),
  // NOT a public product barcode, so it can never be decoded from the open web - it must be resolved
  // against the seller's own Amazon inventory. B0 (ASIN) and other vendor labels keep the generic copy.
  const isFnsku = codeType === "vendor_label" && cleaned.cleanCode.trim().toUpperCase().startsWith("X0");
  // A3/AM-2 (owner-ratified 2026-07-15): a GTIN-shaped code whose GS1 check digit fails is either a
  // scanner misread OR a legitimate non-GS1 shape (in-store number-system-2 price-embedded UPC,
  // ITF-14 wrapper, warehouse numeric) that fails the plain check digit BY DESIGN. The reason is
  // ADDITIVE, never terminal - it names BOTH possibilities and the row stays a normal, aliasable
  // needs_review row exactly like any other unknown code (no affordance removed).
  const misread = isLikelyMisreadGtin(cleaned.cleanCode);
  // #8 (QA fix cluster): an over-cap length is an honest, ADDITIVE flag - it never replaces the
  // normal reason, never blocks resolution, and never drops the scan (law: still appears + counts).
  const isTooLong = cleaned.cleanCode.length > SCAN_LENGTH_CAP;
  const lengthFlag = isTooLong
    ? ` Unusually long code (over ${SCAN_LENGTH_CAP} characters) - may be a scan error.`
    : "";
  const reason =
    (isFnsku
      ? "Amazon fulfillment label (FNSKU). Not a public barcode - resolve via your Amazon inventory."
      : misread
        ? "Barcode check digit fails - this may be a scanner misread (rescan to confirm) or a store-internal code. You can still link it to a product."
        : codeType === "vendor_label"
          ? "Vendor/Amazon label. Link it to a product once and it will count automatically after that."
          : "No approved alias or verified product matches this code yet.") + lengthFlag;

  // QA Task 8: only alpha_sku codes of length >= 5 are eligible for a near-match suggestion. Purely
  // numeric codes (UPC/EAN/GTIN/numeric_sku) are unaffected - that class is handled by Task 4's
  // GTIN canonicalization, not here (a numeric typo class has different failure modes and no such
  // guessing rule was approved for it).
  const nearMatchSuggestion =
    codeType === "alpha_sku" && cleaned.cleanCode.length >= NEAR_MATCH_MIN_CODE_LENGTH
      ? findNearMatchSuggestion(cleaned.cleanCode, products, aliases, businessId)
      : undefined;

  return {
    ...base,
    resolverStatus: "needs_review",
    matchType: "unknown",
    productId: null,
    confidence: 0,
    reason,
    ...(nearMatchSuggestion ? { nearMatchSuggestion } : {}),
  };
}

/** Convenience wrapper that cleans the raw input first. */
export function resolveRawScan(
  rawInput: string,
  products: Product[],
  aliases: Alias[],
  businessId: string,
): ResolverResult {
  return resolveScan(cleanScanCode(rawInput), products, aliases, businessId);
}
