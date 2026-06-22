// P2 (2026-06-22): exact CODE-TOKEN matching inside a product's free-text name/blob.
//
// Some legacy products carry their barcode ONLY inside the display name, e.g.
//   "UPC 029142712886 - Discoverer A/T3 E (10 Ply) BW"
// with empty primaryBarcode/upc/gtin fields. Identifier-field dedup then misses them and a re-scan of
// 029142712886 mints a NEW duplicate row. This module finds the scanned code as a WHOLE normalized token
// in the name (NEVER a fuzzy or substring name match), so "029142712886" matches that product but a tire
// size fragment, load index, or model year never will. Wrong identity is a failure; unknown is acceptable
// (CLAUDE.md), so we only ever match a full exact code token.

/** Normalize a code or a name token to compare them: keep alphanumerics only, upper-case. Preserves leading
 *  zeros (no numeric conversion). "029142-712886" -> "029142712886", " 28033503 " -> "28033503". */
export function normCodeToken(s: string): string {
  return (s ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

// Minimum token length to consider a code. Real scannable codes (UPC/EAN/GTIN/part numbers) are >= 6;
// this avoids ever matching a short numeric fragment (load index "120", year "2004", size piece "75R16").
const MIN_CODE_LEN = 6;

/** True if any of `codes` appears as a WHOLE token inside `blob` (e.g. the product name). Exact token match
 *  only: the blob is split on non-alphanumeric boundaries and each token is normalized the same way as the
 *  codes, so a match means the full code literally appears (as in "UPC 029142712886 - ..."). */
export function blobContainsCodeToken(blob: string | undefined, codes: Array<string | undefined>): boolean {
  const wanted = new Set(codes.map((c) => normCodeToken(c ?? "")).filter((c) => c.length >= MIN_CODE_LEN));
  if (wanted.size === 0) return false;
  const tokens = (blob ?? "").split(/[^a-zA-Z0-9]+/).map(normCodeToken).filter(Boolean);
  return tokens.some((t) => wanted.has(t));
}

/** Extract a code from a leading "UPC <code> - " / "GTIN <code> -" / "EAN <code> -" / "Barcode <code> -"
 *  name prefix, for the backfill helper. Returns the raw code string or null if the name has no such prefix.
 *  Only matches a code-shaped token (>= MIN_CODE_LEN alphanumerics) so ordinary names are left untouched. */
export function codeFromNamePrefix(name: string | undefined): string | null {
  const m = /^\s*(?:UPC|EAN|GTIN|BARCODE)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*-\s+/i.exec(name ?? "");
  if (!m) return null;
  const code = m[1];
  return normCodeToken(code).length >= MIN_CODE_LEN ? code : null;
}
