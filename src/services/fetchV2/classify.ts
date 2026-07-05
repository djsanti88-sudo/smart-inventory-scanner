// Identifier classification for Fetch V2. Wraps the deterministic detectCodeType/barcodeAnatomy
// modules (reused, not rebuilt) and maps their shapes to the richer Fetch V2 identifier set.
// Classification is a HINT for routing lookups - never identity truth.
import { detectCodeType, isVendorLabel } from "@/services/codeTypeDetector";
import { decodeBarcodeStructure } from "@/services/ai/barcodeAnatomy";
import type { FetchV2Identifier, FetchV2IdType } from "./types";

const URL_RE = /^https?:\/\/\S+$/i;
// Tire size embedded anywhere in the value, e.g. 255/40ZR17, 205/55R16, LT265/70R17.
const TIRE_SIZE_RE = /\b(?:LT|P)?\d{3}\/\d{2}\s?Z?R\d{2}\b/i;
const PUBLIC_TYPES = new Set<FetchV2IdType>(["upc_a", "ean_13", "gtin_14"]);

export function classifyIdentifier(raw: string): FetchV2Identifier {
  const trimmed = (raw ?? "").trim();
  const notes: string[] = [];
  let type: FetchV2IdType;

  if (trimmed.length === 0) {
    type = "unknown";
  } else if (URL_RE.test(trimmed)) {
    type = "url";
  } else if (TIRE_SIZE_RE.test(trimmed) && !/^[0-9]+$/.test(trimmed)) {
    type = "tire_code";
  } else if (isVendorLabel(trimmed.toUpperCase())) {
    // Amazon labels: ASIN starts with B0 (public catalog id), FNSKU with X0 (warehouse label).
    type = trimmed.toUpperCase().startsWith("B0") ? "asin" : "fnsku_like";
  } else {
    switch (detectCodeType(trimmed)) {
      case "upc_a": type = "upc_a"; break;
      case "ean_13": type = "ean_13"; break;
      case "gtin_14": type = "gtin_14"; break;
      case "alpha_sku":
      case "numeric_sku": type = "vendor_sku"; break;
      default: type = "raw_text"; break;
    }
  }

  const isPublicBarcode = PUBLIC_TYPES.has(type);
  let checkDigitValid: boolean | null = null;
  let gs1PrefixHint = "";
  if (isPublicBarcode) {
    const s = decodeBarcodeStructure(trimmed, type as "upc_a" | "ean_13" | "gtin_14");
    checkDigitValid = s.checkDigitValid;
    gs1PrefixHint = s.candidateCompanyPrefix ?? "";
    if (s.gs1RegionHint) notes.push(`gs1 region hint: ${s.gs1RegionHint}`);
    if (checkDigitValid === false) notes.push("check digit INVALID for its length");
  }
  return { type, isPublicBarcode, checkDigitValid, gs1PrefixHint, notes };
}
