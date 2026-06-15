import type { CodeType } from "@/types";

// Deterministic, best-effort classification of a scanned code's shape.
// This is a HINT used for labeling and alias typing, never an authority on identity.

const DIGITS_ONLY = /^[0-9]+$/;
const ALNUM_SKU = /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/; // letters/digits with simple separators

// Amazon FNSKU (X00...) and ASIN (B0...) labels: 10 uppercase alphanumerics starting with X0/B0.
// These are vendor/warehouse labels, NOT product barcodes - they must never be treated as a
// UPC/EAN/GTIN and must route to Needs Review unless a human has approved an alias for them.
const VENDOR_LABEL = /^(?:X0|B0)[0-9A-Z]{8}$/;

/** True for X00/Amazon-FNSKU/ASIN-style vendor labels. */
export function isVendorLabel(code: string): boolean {
  return VENDOR_LABEL.test((code ?? "").trim().toUpperCase());
}

export function detectCodeType(code: string): CodeType {
  const c = (code ?? "").trim();
  if (c.length === 0) return "empty";

  // Vendor labels are checked BEFORE the SKU/digit rules so X004DY7YUT is never misread as a SKU.
  if (isVendorLabel(c)) return "vendor_label";

  if (DIGITS_ONLY.test(c)) {
    if (c.length === 12) return "upc_a";
    if (c.length === 13) return "ean_13";
    if (c.length === 14) return "gtin_14";
    return "numeric_sku";
  }

  // Has at least one letter (or simple separators) but no exotic symbols -> SKU-like.
  if (ALNUM_SKU.test(c)) return "alpha_sku";

  // Percent signs, slashes, spaces, or other symbols -> messy vendor/label string.
  return "messy";
}

/**
 * Map a detected code shape to the AliasType used when an alias is created from a scan.
 * Identifier columns (gtin/upc/ean) are decided by the matcher when it knows WHICH product
 * field matched; this is only the fallback shape-based classification for new aliases.
 */
export function codeTypeToAliasType(
  type: CodeType,
): "barcode" | "sku" | "messy_label" | "internal_code" | "vendor_code" {
  switch (type) {
    case "upc_a":
    case "ean_13":
    case "gtin_14":
      return "barcode";
    case "alpha_sku":
      return "sku";
    case "numeric_sku":
      return "internal_code";
    case "vendor_label":
      return "vendor_code";
    case "messy":
    case "empty":
    default:
      return "messy_label";
  }
}
