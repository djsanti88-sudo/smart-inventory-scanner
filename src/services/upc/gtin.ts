// src/services/upc/gtin.ts
// GTIN utilities for the decode ladder. Pure, no imports. One product = one canonical key,
// so cache/corpus/billing never pay twice for the same product in two encodings.
//
// GTIN-14 semantics: a GTIN-14 with indicator digit >= 1 is a CASE PACK, a different
// countable product from the unit GTIN. ONLY leading-ZERO padding (UPC-A <-> zero-padded
// EAN-13/GTIN-14) is equivalence. So canonicalization strips leading ZEROS only, then
// pads back to a fixed width: a non-zero indicator digit survives and never collapses
// into the unit GTIN.

export function isGtinShaped(code: string): boolean {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}

/** GS1 mod-10 check digit over the full code (last digit is the check). */
export function isValidCheckDigit(code: string): boolean {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  const digits = t.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // weights 3,1,3,... from the RIGHTMOST payload digit
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Canonical form: strip leading ZEROS, then left-pad with zeros back to 14 digits.
 * Two encodings that differ ONLY by leading-zero padding collapse to the same key;
 * a GTIN-14 case pack (indicator digit >= 1) keeps that digit and stays distinct
 * from its unit GTIN. Returns null for non-GTIN input.
 */
export function canonicalGtin(code: string): string | null {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return null;
  const stripped = t.replace(/^0+/, "");
  // stripped is the significant-digit core (leading zeros carry no product meaning).
  // Pad to a fixed 14-wide key so padding differences disappear but the indicator survives.
  return stripped.padStart(14, "0");
}

/** Zero-pad variants (12/13/14) - same scheme retailKnowledgeIndex.barcodeVariants uses. */
export function gtinVariants(code: string): string[] {
  const t = (code ?? "").trim();
  const stripped = t.replace(/^0+/, "") || "0";
  const out = new Set([t, stripped]);
  for (const base of [t, stripped]) {
    if (base.length <= 14) out.add(base.padStart(14, "0"));
    if (base.length <= 13) out.add(base.padStart(13, "0"));
    if (base.length <= 12) out.add(base.padStart(12, "0"));
  }
  return [...out].filter((c) => c.length >= 8 && c.length <= 14);
}

/**
 * UPC-E -> UPC-A expansion (GS1 zero-suppression rules). An 8-digit code is ambiguous
 * (EAN-8 vs UPC-E): callers must FIRST accept a valid-check-digit EAN-8 as-is and only
 * try expansion when the 8-digit check fails (see lookupCandidates). Number systems 0/1 only.
 */
export function expandUpcE(code: string): string | null {
  const t = (code ?? "").trim();
  if (!/^[01]\d{7}$/.test(t)) return null;
  const ns = t[0];
  const body = t.slice(1, 7);
  const check = t[7];
  const last = body[5];
  let mfr: string, prod: string;
  if (last === "0" || last === "1" || last === "2") {
    mfr = body.slice(0, 2) + last + "00";
    prod = "00" + body.slice(2, 5);
  } else if (last === "3") {
    mfr = body.slice(0, 3) + "00";
    prod = "000" + body.slice(3, 5);
  } else if (last === "4") {
    mfr = body.slice(0, 4) + "0";
    prod = "0000" + body[4];
  } else {
    mfr = body.slice(0, 5);
    prod = "0000" + last;
  }
  const upcA = ns + mfr + prod + check;
  return isValidCheckDigit(upcA) ? upcA : null;
}

/**
 * THE single variant source for every barcode lookup (corpus, caches, doors).
 * Order: raw first, then UPC-E expansion (only when the raw 8-digit check digit FAILS as
 * EAN-8 - a valid EAN-8 stays EAN-8), then gtinVariants (stripped + 12/13/14 pads).
 * Non-GTIN-shaped codes pass through untouched as [code].
 */
export function lookupCandidates(code: string): string[] {
  const t = (code ?? "").trim();
  if (!t) return [];
  if (!isGtinShaped(t)) return [t];
  const out: string[] = [t];
  if (/^\d{8}$/.test(t) && !isValidCheckDigit(t)) {
    const expanded = expandUpcE(t);
    if (expanded) out.push(...gtinVariants(expanded));
  }
  out.push(...gtinVariants(t));
  return [...new Set(out)];
}
