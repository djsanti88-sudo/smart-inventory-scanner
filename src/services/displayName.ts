// P5 (2026-06-22): a customer-facing PRODUCT NAME cleaner. RENDER-ONLY - it never mutates stored data, so
// the platformOwner view keeps the full raw name. A 65+ customer should read "Brand Model Size", not
// "UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet". It strips:
//   - a leading "UPC|EAN|GTIN|Barcode <code> - " identifier prefix, and
//   - a trailing "Fits ..." vehicle-fitment clause.
// Non-matching names pass through unchanged, and it never returns empty (falls back to the raw name).
import { splitLegacyIdentifierPrefix } from "@/services/productDedup";

export function customerDisplayName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  // Leading identifier prefix: "UPC 086699205636 - ", "GTIN: 00086699205636 - ", etc. One shared matcher
  // with the dedup/backfill side (productDedup.ts) so render and data logic never disagree on what a
  // legacy identifier prefix is.
  let s = splitLegacyIdentifierPrefix(raw)?.rest ?? raw;
  // Trailing fitment clause: "... Fits 2004 Chevrolet", "... - Fits: Ford F-150". Requires whitespace
  // before "Fits" so it is a separate word (never strips inside "Benefits", "Outfits", etc.).
  s = s.replace(/\s+(?:[-–—]\s*)?Fits[\s:].*$/i, "");
  s = s.trim();
  return s || raw;
}
