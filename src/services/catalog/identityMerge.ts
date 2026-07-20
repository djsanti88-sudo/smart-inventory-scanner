// identityMerge.ts (decode ladder Task 9) - decide whether a freshly decoded product is the SAME
// countable product as one the shop already has, so a second scan links to the existing row (new alias +
// increment) instead of minting a duplicate. Pure service: no React/next imports.
//
// Trust rules (owner-locked, from the plan's Global Constraints + Task 9):
//   auto_link  ONLY on canonical-GTIN equality (via canonicalGtin: case-pack GTIN-14s never collapse to
//              the unit code). This is the one deterministic, exact-identity signal.
//   suggest_link  fuzzy: normalized-brand equality AND name token-Jaccard >= 0.75, surfaced as a one-tap
//              suggestion, NEVER an auto-merge. The plus-generation trap (R8 vs R8+, HDR vs HDR+) is a
//              real DIFFERENT product, so any model token that differs only by a trailing "+" forces
//              suggest and can never auto-link.
//   TIRE rule  when BOTH sides carry a parseable tire size (from name OR specsShort/specsFull),
//              auto_link ADDITIONALLY requires size equality; on the GTIN path a size disagreement
//              downgrades to suggest_link (GTIN anomaly), and on the FUZZY path a size disagreement
//              means DIFFERENT products: no suggestion at all (same model, another size).
//   none  otherwise.

import { canonicalGtin } from "@/services/upc/gtin";
import { tireSizeToken } from "@/services/ai/tireSpecs";

/** Product-identity fields identity-merge reads. Both a stored Product and a decoded suggestion satisfy it. */
export interface IdentityCandidate {
  id: string;
  gtin?: string | null;
  upc?: string | null;
  ean?: string | null;
  primaryBarcode?: string | null;
  brand?: string | null;
  name?: string | null;
  productName?: string | null;
  /** Size usually lives here, NOT in the name (corpus names are slugs like "wrangler_steadfast_ht"). */
  specsShort?: string | null;
  specsFull?: string | null;
}

export interface DecodedIdentity {
  gtin?: string | null;
  upc?: string | null;
  ean?: string | null;
  brand?: string | null;
  name?: string | null;
  productName?: string | null;
  specsShort?: string | null;
  specsFull?: string | null;
}

export type IdentityMergeResult =
  | { kind: "auto_link"; productId: string }
  | { kind: "suggest_link"; productId: string }
  | { kind: "none" };

/** Normalize a brand for equality: lowercase, collapse whitespace, drop non-alphanumeric noise. */
function normBrand(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Tokenize a name into lowercased alphanumeric-with-trailing-plus tokens (the "+" is meaningful: R8 vs R8+).
 *  Exported (Task 5, export-only, no logic change) for reuse by the reconcile identity matcher, which
 *  must reuse this exact tokenizer rather than reimplement it (AM-R5). */
export function nameTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    // keep a trailing "+" attached to its token so "r8+" stays distinct from "r8"
    .replace(/[^a-z0-9+ ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/\++$/, (m) => (m ? "+" : ""))) // collapse "r8++" -> "r8+"
    .filter((t) => t.length > 0 && t !== "+");
}

/** Token Jaccard similarity (intersection / union) over two token sets. 0 when both empty.
 *  Exported (Task 5, export-only, no logic change) for reuse by the reconcile identity matcher (AM-R5). */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Binding Jaccard threshold for Phase 4 (Global Constraints): the single canonical similarity
 *  cutoff for identity-token matching. Both the Stage A matcher (reconcile/identityMatcher.ts) and
 *  the Stage B fuzzy-matching follow-up consume this one export; never redeclare a second literal. */
export const IDENTITY_JACCARD_THRESHOLD = 0.75;

/**
 * The plus-generation guard: true when the two token sets differ ONLY by a trailing "+" on some token
 * (e.g. {dimax, r8} vs {dimax, r8+}). Such a pair is a DIFFERENT product generation and must never
 * auto-link; it can at most be a suggestion. Detected by comparing the sets with every trailing "+"
 * stripped: if they become equal but were NOT equal with the "+" kept, a plus-generation difference exists.
 *
 * Exported (Task 5, export-only, no logic change) for reuse by the reconcile identity matcher (AM-R5).
 */
export function plusGenerationDiff(a: string[], b: string[]): boolean {
  const strip = (t: string) => t.replace(/\+$/, "");
  const setEq = (x: string[], y: string[]) => {
    const sx = new Set(x);
    const sy = new Set(y);
    if (sx.size !== sy.size) return false;
    for (const t of sx) if (!sy.has(t)) return false;
    return true;
  };
  const withPlus = setEq(a, b);
  const withoutPlus = setEq(a.map(strip), b.map(strip));
  return !withPlus && withoutPlus;
}

function nameOf(c: IdentityCandidate | DecodedIdentity): string {
  return (c.name ?? c.productName ?? "").toString();
}

/** Canonical tire size for a candidate, parsed from its name AND its specs fields (corpus product
 *  names are slugs with no size - the size lives in specsShort/specsFull). "" when none found. */
function sizeOf(c: (IdentityCandidate | DecodedIdentity) & { specsShort?: string | null; specsFull?: string | null }): string {
  const text = [nameOf(c), c.specsShort ?? "", c.specsFull ?? ""].join(" ");
  return tireSizeToken({ productName: text, brand: c.brand ?? undefined });
}

/** First canonical GTIN found among a candidate's identity codes (gtin/upc/ean/primaryBarcode), or null. */
function canonicalOf(c: { gtin?: string | null; upc?: string | null; ean?: string | null; primaryBarcode?: string | null }): string | null {
  for (const raw of [c.gtin, c.upc, c.ean, c.primaryBarcode]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const canon = canonicalGtin(v);
    if (canon) return canon;
  }
  return null;
}

/**
 * Decide whether `decoded` is the same product as one already in `existing`.
 * See the trust rules at the top of this file. Returns the FIRST matching existing product (auto_link
 * preferred over suggest_link when both would apply to different rows).
 */
export function findIdentityMerge(existing: IdentityCandidate[], decoded: DecodedIdentity): IdentityMergeResult {
  const decodedCanon = canonicalOf(decoded);
  const decodedTireSize = sizeOf(decoded);
  const decodedBrand = normBrand(decoded.brand);
  const decodedTokens = nameTokens(nameOf(decoded));

  let suggestion: IdentityMergeResult | null = null;

  for (const p of existing) {
    if (!p?.id) continue;

    const existingTireSize = sizeOf(p);
    // TIRE rule: if BOTH sides carry a parseable size, they must agree for an auto_link. A disagreement
    // downgrades even a GTIN match to a suggestion (the plan's "GTIN match anomalies" clause).
    const bothHaveTireSize = !!decodedTireSize && !!existingTireSize;
    const tireSizeAgrees = !bothHaveTireSize || decodedTireSize === existingTireSize;

    // 1) Canonical-GTIN equality -> auto_link (subject to the tire size-agreement rule).
    const existingCanon = canonicalOf(p);
    if (decodedCanon && existingCanon && decodedCanon === existingCanon) {
      if (tireSizeAgrees) return { kind: "auto_link", productId: p.id };
      // GTIN equal but tire sizes disagree -> never auto; offer as a suggestion instead.
      suggestion ??= { kind: "suggest_link", productId: p.id };
      continue;
    }

    // 2) Fuzzy: same normalized brand + name Jaccard >= 0.75 -> suggest_link (never auto).
    if (decodedBrand && normBrand(p.brand) === decodedBrand) {
      // SIZE-DISTINCT rule (2026-07-10): when BOTH sides carry a derivable tire size and the sizes
      // DIFFER, they are DIFFERENT countable products (same model, another size) - do not suggest a
      // link at all. Without this, a same-brand burst collapses every additional size of a model into
      // Needs Review ("Unidentified item"), which is exactly the 59/100 defect proven on the preview.
      if (bothHaveTireSize && !tireSizeAgrees) continue;
      const existingTokens = nameTokens(nameOf(p));
      const sim = jaccard(decodedTokens, existingTokens);
      const plusDiff = plusGenerationDiff(decodedTokens, existingTokens);
      if (sim >= IDENTITY_JACCARD_THRESHOLD || plusDiff) {
        // plusDiff (R8 vs R8+) always routes to suggest, never auto - even at Jaccard 1.0 with "+" stripped.
        suggestion ??= { kind: "suggest_link", productId: p.id };
      }
    }
  }

  return suggestion ?? { kind: "none" };
}
