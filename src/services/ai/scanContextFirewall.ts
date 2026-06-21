// Architecture Version: v1.0.0
//
// scanContextFirewall.ts (Phase 8) - exact-code evidence is NECESSARY but NOT SUFFICIENT. A public UPC
// source can be wrong (e.g. go-upc.com maps tire UPC 745125495781 to an aluminum-rivet kit). When the
// decoded product's domain contradicts the business scan context, or a learned brand-prefix hint, the
// decode must NOT auto-count - it routes to Needs Review with a safe, product-facing reason.

import type { AiLookupResult, CodeType } from "@/types";
import { isTireContext, type IdentityText } from "@/services/ai/tireSpecs";
import { decodeBarcodeStructure, type BrandPrefixHint } from "@/services/ai/barcodeAnatomy";
import { isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";

export type ScanContext = "any" | "tire";
export type ConflictKind = "category_context_conflict" | "brand_prefix_conflict";

// Obvious NON-tire product signals (fasteners, tools, consumables, etc.). Used only to flag a CLEAR
// domain mismatch; ambiguous names stay "unknown" and never raise a false conflict.
const NON_TIRE_RE =
  /\b(rivet|screw|bolt|nut|washer|fastener|anchor|drill|bit|wrench|socket|hammer|tool|cable|wire|bulb|battery|charger|hose|spark\s?plug|supplement|vitamin|capsule|tablet|food|snack|candy|drink|beverage|cola|soda|juice|shampoo|soap|lotion|cigarette|lighter)\b/i;

export function classifyProductDomain(r: IdentityText | null | undefined): "tire" | "non_tire" | "unknown" {
  if (!r) return "unknown";
  if (isTireContext(r)) return "tire";
  const t = [r.productName, r.category, r.specsShort, r.specsFull].filter(Boolean).join(" ");
  if (NON_TIRE_RE.test(t)) return "non_tire";
  return "unknown";
}

/**
 * Phase 8C - the firewall must ALSO guard the deterministic count path: an approved alias or a verified
 * product that already carries a poisoned barcode would otherwise auto-count with NO AI call and NO
 * firewall (the original firewall only ran inside the AI decode path). This check takes a stored
 * product/catalog identity (Product.name OR a catalog hit's name maps to productName). Only the
 * category/context guard applies here - there is no provider result to brand-check. Returns the conflict
 * kind to BLOCK the auto-count, or null.
 */
export function detectIdentityContextConflict(
  scanContext: ScanContext,
  identity:
    | { productName?: string; name?: string; brand?: string; category?: string; specsShort?: string; specsFull?: string }
    | null
    | undefined,
): ConflictKind | null {
  if (!identity) return null;
  const text: IdentityText = {
    productName: identity.productName ?? identity.name ?? "",
    brand: identity.brand ?? "",
    category: identity.category ?? "",
    specsShort: identity.specsShort ?? "",
    specsFull: identity.specsFull ?? "",
  };
  if (scanContext === "tire" && classifyProductDomain(text) === "non_tire") return "category_context_conflict";
  return null;
}

/**
 * Returns a conflict kind that must BLOCK auto-count (route to Needs Review), or null. Category conflict
 * is checked first (the poisoned-source guard). It never deletes evidence - the caller keeps it for review.
 */
export function detectScanContextConflict(params: {
  scanContext: ScanContext;
  code: string;
  codeType: CodeType;
  result: AiLookupResult | null | undefined;
  brandPrefixHints: BrandPrefixHint[];
}): ConflictKind | null {
  const { scanContext, code, codeType, result, brandPrefixHints } = params;
  if (!result) return null;
  const domain = classifyProductDomain(result);

  // 1. Category/context conflict: a tire business scanning a clearly non-tire product (source poisoning).
  if (scanContext === "tire" && domain === "non_tire") return "category_context_conflict";

  // 2. Brand-prefix conflict: an UNAMBIGUOUS learned brand for this code's candidate prefix that the
  //    decoded result contradicts (different brand, or a clearly non-tire product for a tire-brand prefix).
  const prefix = decodeBarcodeStructure(code, codeType).candidateCompanyPrefix;
  if (prefix) {
    const hint = brandPrefixHints.find((h) => h.prefix === prefix);
    if (hint) {
      const decodedBrand = (result.brand ?? "").trim().toLowerCase();
      const learned = hint.brand.toLowerCase();
      const brandMismatch = !!decodedBrand && !decodedBrand.includes(learned) && !learned.includes(decodedBrand);
      // Brand-FAMILY guard: corporate siblings share a GS1 company prefix (e.g. Michelin / BFGoodrich /
      // Uniroyal on 086699). A decode of any brand in the prefix family is NOT a real conflict. The hint
      // table can only SUPPRESS a conflict here - it never creates one and never auto-trusts.
      if (brandMismatch && !isBrandInPrefixFamily(code, result.brand ?? "")) return "brand_prefix_conflict";
    }
  }
  return null;
}

/** Safe, product-facing reason for a blocked decode (no provider/source internals). */
export function conflictReason(kind: ConflictKind): string {
  return kind === "category_context_conflict"
    ? "Needs Review: category conflict - this product does not match the tire scan context (the public code source may be wrong)."
    : "Needs Review: brand conflict - the decoded brand contradicts the learned brand for this code.";
}
