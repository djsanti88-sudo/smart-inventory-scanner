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

export interface PrefixFloorResult {
  /** Display name for the provisional row, e.g. "Coca-Cola / product unconfirmed". */
  name: string;
  /** The resolved brand/manufacturer only (no "product unconfirmed" suffix). */
  brand: string;
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
  const struct = decodeBarcodeStructure(code, codeType);
  if (!struct.candidateCompanyPrefix) return null;
  const entry = lookupPrefix(code);
  const rawBrand = entry?.dominant?.name?.trim();
  if (!rawBrand) return null;
  const brand = titleCase(rawBrand);
  return { name: `${brand} / product unconfirmed`, brand };
}
