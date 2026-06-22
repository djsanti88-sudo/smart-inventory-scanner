// P5 (2026-06-22): a customer-facing PRODUCT NAME cleaner. RENDER-ONLY - it never mutates stored data, so
// the platformOwner view keeps the full raw name. A 65+ customer should read "Brand Model Size", not
// "UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet". It strips:
//   - a leading "UPC|EAN|GTIN|Barcode <code> - " identifier prefix, and
//   - a trailing "Fits ..." vehicle-fitment clause.
// Non-matching names pass through unchanged, and it never returns empty (falls back to the raw name).

export function customerDisplayName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  let s = raw;
  // Leading identifier prefix: "UPC 086699205636 - ", "GTIN: 00086699205636 - ", etc. (code >= 6 chars).
  s = s.replace(/^(?:UPC|EAN|GTIN|BARCODE)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]{4,}\s*[-–—]\s+/i, "");
  // Trailing fitment clause: "... Fits 2004 Chevrolet", "... - Fits: Ford F-150". Requires whitespace
  // before "Fits" so it is a separate word (never strips inside "Benefits", "Outfits", etc.).
  s = s.replace(/\s+(?:[-–—]\s*)?Fits[\s:].*$/i, "");
  s = s.trim();
  return s || raw;
}
