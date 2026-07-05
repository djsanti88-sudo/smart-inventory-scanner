// Code-to-product association proof. The question is never "is the code on the page?" but
// "is the code tied to THIS product record?".
//   strong = a normalized variant matches a structured gtin/upc/ean/sku field (JSON-LD or detail table)
//   weak   = a variant appears in page text but is not tied to a product record
//   none   = variant absent, or present ONLY in the URL (url_only is never evidence)
import type { ExtractedProduct } from "./extract";

export type AssociationLevel = "strong" | "weak" | "none";

// A number is only a BARCODE when it sits in a barcode position. Label words within a small
// window qualify it; ledger/listing/contact contexts disqualify it (owner rule 2026-07-05:
// "not just anything that has that number").
const LABEL_RE = /\b(upc|ean|gtin|barcode|c[oó]digo de barras|strichcode|code-barres)\b/i;
const NEGATIVE_RE = /\b(mls|case no\.?|listing|order|invoice|phone|tel|zip|p\.?o\.?|item\s*#|sku\s*#|ref\.?)\b/i;
const WINDOW = 24;

function contextWindow(text: string, variant: string): string | null {
  const squashedIdx = (text ?? "").replace(/[\s-]/g, "").indexOf(variant);
  if (squashedIdx < 0) return null;
  // Map back approximately: search the raw text for the variant allowing separators.
  const re = new RegExp(variant.split("").join("[\\s-]?"));
  const m = (text ?? "").match(re);
  if (!m || m.index === undefined) return null;
  return text.slice(Math.max(0, m.index - WINDOW), m.index + m[0].length + WINDOW);
}

export function hasBarcodeLabelContext(text: string, variant: string): boolean {
  const w = contextWindow(text, variant);
  return !!w && LABEL_RE.test(w);
}

export function hasNegativeContext(text: string, variant: string): boolean {
  const w = contextWindow(text, variant);
  return !!w && NEGATIVE_RE.test(w);
}

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

// Search-style URLs (e.g. go-upc.com/search?q=CODE) echo the queried code back onto the page,
// sometimes inside a table-like element. A detail_table "gtin" match on such a URL is that echo,
// not proof the code belongs to the page's product - it must never count as strong evidence.
function isQueryEcho(url: string, variant: string): boolean {
  if (!variant) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const needle = variant.replace(/[\s-]/g, "");
  for (const value of parsed.searchParams.values()) {
    if (value.replace(/[\s-]/g, "").includes(needle)) return true;
  }
  return false;
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
  let echoCandidate: AssociationProof | null = null;
  for (const p of ordered) {
    for (const v of vs) {
      if (p.gtins.some((g) => gtinMatches(v, g))) {
        // A detail-table "gtin" on a search-style URL (?q=CODE) is the page echoing the query
        // back, not a structured product record - it can never be strong. JSON-LD matches on the
        // same URL are unaffected: structured product data is not an echo.
        if (p.source === "detail_table" && isQueryEcho(url, v)) {
          echoCandidate ??= { level: "weak", matchedVariant: v, matchedField: "detail_table_echo", product: p };
          continue;
        }
        return { level: "strong", matchedVariant: v, matchedField: `${p.source}.gtin`, product: p };
      }
      if (p.sku && v.length >= 6 && p.sku.toUpperCase() === v.toUpperCase()) {
        return { level: "strong", matchedVariant: v, matchedField: `${p.source}.sku`, product: p };
      }
    }
  }
  if (echoCandidate) return echoCandidate;

  // weak: somewhere in page text (may still ONLY produce suggested/needs_review upstream).
  // Short digit strings collide with order numbers, case ids, and phone numbers (live: 8-digit
  // codes "matched" a pest-control kit and a court filing) - free-text ties need 10+ digits.
  for (const v of vs) {
    if (/^\d+$/.test(v) && v.length < 10) continue;
    if (inText(v, pageText) && hasBarcodeLabelContext(pageText, v) && !hasNegativeContext(pageText, v)) {
      return { level: "weak", matchedVariant: v, matchedField: "page_text", product: ordered[0] ?? null };
    }
  }

  // url-only presence is explicitly NOT evidence.
  for (const v of vs) {
    if (inText(v, url)) return { level: "none", matchedVariant: v, matchedField: "url_only", product: null };
  }
  return { level: "none", matchedVariant: "", matchedField: "", product: null };
}
