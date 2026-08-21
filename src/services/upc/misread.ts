import { isGtinShaped, isValidCheckDigit, expandUpcE } from "@/services/upc/gtin";

/**
 * A3 (owner-ratified 2026-07-15, narrowed by AM-2): a GTIN-SHAPED code that fails the GS1 check
 * digit is either a scanner misread (dirty label, bad angle, camera blur) OR a legitimate non-GS1
 * shape that fails the plain check digit BY DESIGN (in-store number-system-2 price-embedded UPCs,
 * ITF-14 wrappers, warehouse numerics). This helper cannot and does not try to tell those apart -
 * it only answers "does the check digit fail" so the caller can skip paid decode (a bad
 * check digit dooms every GTIN rung either way) and surface an ADDITIVE, non-terminal reason that
 * names both possibilities (see resolver.ts). The row always stays a normal, aliasable needs_review
 * row - nothing here removes affordance from the review flow.
 *
 * 8-digit codes get one more chance: a failed EAN-8 check may still be a zero-suppressed UPC-E
 * whose expansion validates - that is not a misread of any kind, just a different encoding.
 * NON-GTIN shapes (vendor labels, SKUs) are never misreads - they have no check digit to fail.
 */
export function isLikelyMisreadGtin(code: string): boolean {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  if (isValidCheckDigit(t)) return false;
  if (/^\d{8}$/.test(t) && expandUpcE(t) !== null) return false;
  return true;
}
