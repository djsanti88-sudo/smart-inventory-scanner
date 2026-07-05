// Code-to-product association proof. The question is never "is the code on the page?" but
// "is the code tied to THIS product record?".
//   strong = a normalized variant matches a structured gtin/upc/ean/sku field (JSON-LD or detail table)
//   weak   = a variant appears in page text but is not tied to a product record
//   none   = variant absent, or present ONLY in the URL (url_only is never evidence)
import type { ExtractedProduct } from "./extract";

export type AssociationLevel = "strong" | "weak" | "none";

export interface AssociationProof {
  level: AssociationLevel;
  matchedVariant: string;
  matchedField: string; // e.g. "json_ld.gtin", "detail_table.gtin", "page_text", "url_only"
  product: ExtractedProduct | null;
}

/** Digit-boundary match so 12345678 never matches inside 9912345678001. */
function inText(variant: string, text: string): boolean {
  if (!variant || !text) return false;
  const squashed = text.replace(/[\s-]/g, "");
  if (/^\d+$/.test(variant)) return new RegExp(`(?<![0-9])${variant}(?![0-9])`).test(squashed);
  return new RegExp(`(?<![A-Z0-9])${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Z0-9])`, "i").test(text);
}

function gtinMatches(variant: string, gtin: string): boolean {
  if (!/^\d+$/.test(variant) || !gtin) return false;
  // Compare on zero-padded GTIN-14 so 028400325042 === 0028400325042 === 00028400325042.
  return variant.padStart(14, "0") === gtin.padStart(14, "0");
}

export function proveAssociation(
  variants: string[],
  products: ExtractedProduct[],
  pageText: string,
  url: string,
): AssociationProof {
  const vs = variants.filter(Boolean);

  // strong: structured field match, JSON-LD before detail tables (richer identity).
  const ordered = [...products].sort((a, b) => (a.source === "json_ld" ? -1 : 1) - (b.source === "json_ld" ? -1 : 1));
  for (const p of ordered) {
    for (const v of vs) {
      if (p.gtins.some((g) => gtinMatches(v, g))) {
        return { level: "strong", matchedVariant: v, matchedField: `${p.source}.gtin`, product: p };
      }
      if (p.sku && v.length >= 6 && p.sku.toUpperCase() === v.toUpperCase()) {
        return { level: "strong", matchedVariant: v, matchedField: `${p.source}.sku`, product: p };
      }
    }
  }

  // weak: somewhere in page text (may still ONLY produce suggested/needs_review upstream).
  // Short digit strings collide with order numbers, case ids, and phone numbers (live: 8-digit
  // codes "matched" a pest-control kit and a court filing) - free-text ties need 10+ digits.
  for (const v of vs) {
    if (/^\d+$/.test(v) && v.length < 10) continue;
    if (inText(v, pageText)) {
      return { level: "weak", matchedVariant: v, matchedField: "page_text", product: ordered[0] ?? null };
    }
  }

  // url-only presence is explicitly NOT evidence.
  for (const v of vs) {
    if (inText(v, url)) return { level: "none", matchedVariant: v, matchedField: "url_only", product: null };
  }
  return { level: "none", matchedVariant: "", matchedField: "", product: null };
}
