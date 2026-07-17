// Plan C Task 3 - PREFIX FLOOR: a counted-but-unidentified provisional row must never be a bare
// "Unidentified item (barcode X)" when the scanned code's GS1 company prefix maps to a known
// brand/manufacturer. Instead it is named "<Brand> / product unconfirmed" - the BRAND is stated with
// confidence (from the general, client-safe prefix->company index), the PRODUCT stays explicitly
// unconfirmed, and NO specific product/model is ever fabricated from the prefix alone. If the prefix
// maps to nothing (or isn't a public barcode), callers keep the existing "Unidentified item" fallback.
// A prefix-floor row must NEVER be marked verified - it is a naming aid only, not an identity claim.

import type { CodeType } from "@/types";
import { decodeBarcodeStructure } from "@/services/ai/barcodeAnatomy";
import { lookupPrefix } from "@/services/catalog/prefixIndex";
import { familyLabelFor } from "@/services/catalog/brandFamilies";
import { isLikelyMisreadGtin } from "@/services/upc/misread";
import { isExampleOrTestRow } from "@/services/ai/decode";

export interface PrefixFloorResult {
  /** Display name for the provisional row, e.g. "Coca-Cola / product unconfirmed", or with a corporate
   *  family annotation when the brand is a family member, e.g. "General (Continental family) / product unconfirmed". */
  name: string;
  /** The resolved brand/manufacturer only (no "product unconfirmed" suffix). */
  brand: string;
  /** P5: the corporate-family label ("<Leader> family") when the brand is a NON-LEADER member of a
   *  curated family; undefined for a leader or an independent brand. Naming aid only, never an identity claim. */
  familyLabel?: string;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a prefix->brand floor name for an unresolved scan. Returns null when the code is not a
 * public barcode (no candidate company prefix) or the prefix has no confident dominant candidate -
 * callers must fall back to the existing safe "Unidentified item" placeholder in that case.
 */
export function prefixFloorName(code: string, codeType: CodeType): PrefixFloorResult | null {
  // QA ROUND-2 SEAM 3 (live-proven bypass, 2026-07-16): the prefix floor must give NO brand to a
  // scanner-MISREAD GTIN (bad GS1 check digit) or a textbook GS1 EXAMPLE / demo / test barcode. Both
  // classes previously leaked a confident fabricated brand ("Healthyholics / product unconfirmed")
  // onto every surface (count row, scan feed, review, decline) because this is the single chokepoint
  // all five scanStore call sites funnel through. Wrong identity is FAILURE; unknown is acceptable -
  // so we fall through to null here and the caller keeps its honest "Unidentified item" placeholder
  // (the code still appears + counts, it just carries no brand). isExampleOrTestRow is checked on the
  // code alone (no decode result yet, so name/brand are ""); it catches the exact-value example
  // blocklist and degenerate barcode shapes. Both helpers are pure and client-safe (misread.ts has no
  // deps beyond gtin.ts; decode.ts is already client-imported by scanStore for isUsableProductName).
  if (isLikelyMisreadGtin(code) || isExampleOrTestRow(code, "", "")) return null;
  const struct = decodeBarcodeStructure(code, codeType);
  if (!struct.candidateCompanyPrefix) return null;
  const entry = lookupPrefix(code);
  const rawBrand = entry?.dominant?.name?.trim();
  if (!rawBrand) return null;
  const brand = titleCase(rawBrand);
  // P5 (Task 8): annotate the corporate family when the resolved brand is a NON-LEADER family member,
  // so the floor reads "General (Continental family) / product unconfirmed". A leader / independent
  // brand keeps the plain "<Brand> / product unconfirmed" form. Still a naming aid, never verified.
  const familyLabel = familyLabelFor(brand) ?? undefined;
  const name = familyLabel ? `${brand} (${familyLabel}) / product unconfirmed` : `${brand} / product unconfirmed`;
  return { name, brand, familyLabel };
}
