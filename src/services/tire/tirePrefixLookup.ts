// tirePrefixLookup.ts - pure, deterministic lookup over the tire brand/prefix HINT table. No AI, no
// network. A hint may only SUGGEST/BOOST a brand: it never marks a scan known/verified, auto-counts, or
// overrides the firewall. Its only firewall role is to SUPPRESS a false brand conflict between corporate
// siblings that share a GS1 company prefix (a "brand family").

import { TIRE_PREFIX_HINTS, type PrefixHint } from "@/services/tire/tirePrefixHints";

export type { PrefixHint } from "@/services/tire/tirePrefixHints";
export type PrefixMatch = { prefix: string; brands: PrefixHint[] };

/** Normalize a public barcode to its 13-digit GTIN base (zero-padded). null for anything else. */
function normalizeToGtin13(code: string): string | null {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length === 12) return "0" + d; // UPC-A -> GTIN-13
  if (d.length === 13) return d; // EAN-13 / GTIN-13
  if (d.length === 14) return d.slice(1); // GTIN-14 -> embedded GTIN-13
  return null;
}

/**
 * Longest-prefix-wins lookup of a brand family for a scanned barcode. Handles the CSV's leading-zero
 * variance: a stored prefix matches whether it aligns at the GTIN-13 start OR one zero in (US UPC 6-digit
 * prefixes are written without the GTIN-13 leading zero). Returns null when nothing maps (never guesses).
 */
export function lookupTirePrefix(code: string, table: Record<string, PrefixHint[]> = TIRE_PREFIX_HINTS): PrefixMatch | null {
  const g = normalizeToGtin13(code);
  if (!g) return null;
  let best: { prefix: string; direct: boolean } | null = null;
  for (const prefix of Object.keys(table)) {
    const direct = g.startsWith(prefix);
    const shifted = !direct && g.startsWith("0" + prefix);
    if (!direct && !shifted) continue;
    // More prefix digits = more specific. On a length tie, a direct (no leading-zero shift) match wins.
    if (!best || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && direct && !best.direct)) {
      best = { prefix, direct };
    }
  }
  return best ? { prefix: best.prefix, brands: table[best.prefix] } : null;
}

/** Normalize a brand for comparison: drop parenthetical qualifiers + non-alphanumerics, lowercase. */
export function brandNorm(brand: string): string {
  return (brand ?? "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]/g, "");
}

/**
 * True when `brand` belongs to the brand family of the scanned barcode's prefix. Used by the firewall to
 * avoid a FALSE brand conflict between corporate siblings (e.g. Michelin / BFGoodrich on 086699). Never
 * creates a conflict on its own; only suppresses one.
 */
export function isBrandInPrefixFamily(code: string, brand: string, table: Record<string, PrefixHint[]> = TIRE_PREFIX_HINTS): boolean {
  const nb = brandNorm(brand);
  if (!nb) return false;
  const m = lookupTirePrefix(code, table);
  if (!m) return false;
  return m.brands.some((h) => {
    const hn = brandNorm(h.brand);
    return !!hn && (hn === nb || hn.includes(nb) || nb.includes(hn));
  });
}
