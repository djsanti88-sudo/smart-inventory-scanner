// Architecture Version: v1.0.0
//
// barcodeAnatomy.ts (Phase 8) - structured, NON-AUTHORITATIVE decomposition of a scanned barcode, plus
// learned brand<-company-prefix hints derived ONLY from the owner-approved business catalog. None of
// this is identity truth: the GS1 region is the numbering-authority region (not country of make/brand),
// and the company prefix is variable-length so we expose a CANDIDATE slice only.

import type { Alias, CodeType, Product } from "@/types";
import { deriveGs1RegionHint, GS1_HINT_DISCLAIMER } from "@/products/barcodes/gs1Prefixes";
import { detectCodeType } from "@/products/match/codeTypeDetector";

export interface BarcodeStructure {
  normalizedCode: string;
  codeType: CodeType;
  gs1RegionHint: string | null;
  checkDigitValid: boolean | null; // null when not a checkable public barcode
  candidateCompanyPrefix: string | null; // CANDIDATE only - real GS1 company-prefix length is variable
  itemReference: string | null;
  disclaimer: string;
}

const PUBLIC: CodeType[] = ["upc_a", "ean_13", "gtin_14"];

/** Zero-pad/strip to the embedded 13-digit GTIN-13 base so the leading digits are the GS1 prefix. */
function gtin13(code: string, codeType: CodeType): string | null {
  const d = (code ?? "").replace(/\D/g, "");
  if (codeType === "upc_a" && d.length === 12) return "0" + d;
  if (codeType === "ean_13" && d.length === 13) return d;
  if (codeType === "gtin_14" && d.length === 14) return d.slice(1);
  return null;
}

/** GS1 mod-10 check-digit validation over the full digit string (last digit is the check). */
function mod10Valid(digits: string): boolean {
  const n = digits.length;
  if (n < 8) return false;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const dig = Number(digits[n - 2 - i]); // walk right-to-left over the data digits
    if (Number.isNaN(dig)) return false;
    sum += i % 2 === 0 ? dig * 3 : dig;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[n - 1]);
}

export function decodeBarcodeStructure(code: string, codeType: CodeType): BarcodeStructure {
  const digits = (code ?? "").replace(/\D/g, "");
  const base = { normalizedCode: digits || (code ?? ""), codeType, disclaimer: GS1_HINT_DISCLAIMER };
  if (!PUBLIC.includes(codeType)) {
    return { ...base, gs1RegionHint: null, checkDigitValid: null, candidateCompanyPrefix: null, itemReference: null };
  }
  const g13 = gtin13(code, codeType);
  const expectedLen = codeType === "upc_a" ? 12 : codeType === "ean_13" ? 13 : 14;
  const checkDigitValid = digits.length === expectedLen ? mod10Valid(digits) : null;
  // Candidate company prefix: GS1 prefix (3) + a conventional company block. EXPOSED AS A CANDIDATE
  // because the true GS1 company-prefix length varies; used only as a consistency key for learning.
  const candidateCompanyPrefix = g13 ? g13.slice(0, 7) : null;
  const itemReference = g13 ? g13.slice(7, 12) : null;
  return {
    ...base,
    gs1RegionHint: deriveGs1RegionHint(code, codeType),
    checkDigitValid,
    candidateCompanyPrefix,
    itemReference,
  };
}

// --- W2: learned brand <- candidate-prefix hints, from APPROVED business catalog data ONLY ----------
export interface BrandPrefixHint {
  prefix: string;
  brand: string;
}

/**
 * Learn brand <- candidate company-prefix ONLY from approved aliases whose product has a brand. A prefix
 * mapped to more than one brand is AMBIGUOUS and excluded (never a brand hint). Never learns from AI
 * suggestions, unapproved aliases, Needs Review items, or scraped/global data.
 */
export function deriveBrandPrefixHints(products: Product[], aliases: Alias[]): BrandPrefixHint[] {
  const productById = new Map(products.map((p) => [p.id, p]));
  const prefixToBrands = new Map<string, Set<string>>();
  for (const a of aliases) {
    if (!a.approved) continue;
    const brand = (productById.get(a.productId)?.brand ?? "").trim().toLowerCase();
    if (!brand) continue;
    const ct = detectCodeType(a.cleanCode);
    if (!PUBLIC.includes(ct)) continue;
    const prefix = decodeBarcodeStructure(a.cleanCode, ct).candidateCompanyPrefix;
    if (!prefix) continue;
    const set = prefixToBrands.get(prefix) ?? new Set<string>();
    set.add(brand);
    prefixToBrands.set(prefix, set);
  }
  const hints: BrandPrefixHint[] = [];
  for (const [prefix, brands] of prefixToBrands) {
    if (brands.size === 1) hints.push({ prefix, brand: [...brands][0] });
  }
  return hints;
}
