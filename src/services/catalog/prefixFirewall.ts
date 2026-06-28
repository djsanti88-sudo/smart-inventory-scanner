import { normalizeBrand } from "@/services/catalog/brandPrefixGeneral";
import type { PrefixEntry } from "@/services/catalog/prefixIndex";

// EVIDENCE-WEIGHTED anti-hallucination firewall. A prefix-owner mismatch is a STRONG CONFLICT SIGNAL,
// NOT final proof: it blocks auto-verify and forces Needs Review, but it is overridden by official
// exact-code evidence and it must NOT create false rejects for legitimate private-label / multi-prefix /
// multi-UPC products. The key escape hatch is CATEGORY COMPATIBILITY: a retail-brand difference alone
// (e.g. "The Home Depot" on a United Solutions prefix) is normal private label and is NOT a conflict.

export interface FirewallCandidate {
  brand?: string;
  manufacturer?: string;
  category?: string;
}

export interface FirewallInput {
  code: string;
  prefix: PrefixEntry | null; // from lookupPrefix(code)
  candidate: FirewallCandidate; // the AI-proposed identity
  candidateKnownUpcs?: string[]; // the candidate's known UPC SET from our own catalog/corpus (reverse guard)
  exactCodeVerifiedByApp?: boolean; // official exact-code evidence -> overrides the firewall
}

export interface FirewallVerdict {
  conflict: boolean; // true => block auto-verify, force Needs Review (candidate still SHOWN as a suggestion)
  kind: "none" | "prefix_manufacturer_conflict" | "reverse_upc_conflict";
  weight: number; // 0..1 strength of the veto
  overriddenByEvidence: boolean;
  reason: string; // platformOwner-only diagnostic; never customer-facing
}

function catTokens(s: string | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3);
}

/** true / false / null(unknown) - does the candidate's category overlap the prefix's category mix? */
function categoryCompatible(category: string | undefined, prefix: PrefixEntry | null): boolean | null {
  if (!prefix) return null;
  const tokens = catTokens(category);
  if (tokens.length === 0) return null; // unknown candidate category
  const prefCats = new Set<string>();
  for (const k of Object.keys(prefix.categoryDist)) for (const t of catTokens(k)) prefCats.add(t);
  for (const c of prefix.candidates) for (const cc of c.categories ?? []) for (const t of catTokens(cc)) prefCats.add(t);
  return tokens.some((t) => prefCats.has(t));
}

/** Does the candidate's manufacturer/brand match ANY of the prefix's candidate owners (token-tolerant)? */
function candidateMatchesPrefix(candidate: FirewallCandidate, prefix: PrefixEntry): boolean {
  const names = [candidate.manufacturer, candidate.brand].map(normalizeBrand).filter(Boolean);
  if (names.length === 0) return false;
  for (const pc of prefix.candidates) {
    const pn = normalizeBrand(pc.name);
    if (!pn) continue;
    for (const n of names) {
      if (n === pn) return true;
      const n0 = n.split(" ")[0];
      const p0 = pn.split(" ")[0];
      if (n0 && pn.includes(n0)) return true;
      if (p0 && n.includes(p0)) return true;
    }
  }
  return false;
}

/** GTIN-equivalent normalization for UPC-set membership (UPC-12 vs GTIN-13 differ by a leading zero). */
function normCode(s: string | undefined): string {
  return (s || "").replace(/\D/g, "").replace(/^0+/, "");
}

export function evaluatePrefixFirewall(input: FirewallInput): FirewallVerdict {
  const { code, prefix, candidate } = input;
  const strongExact = input.exactCodeVerifiedByApp === true;

  const catCompatible = categoryCompatible(candidate.category, prefix); // true | false | null
  const mfrMatch = !!prefix && candidateMatchesPrefix(candidate, prefix);
  const prefixWeight = prefix ? prefix.confidence * (1 - prefix.ambiguity) : 0;

  // Prefix conflict: a CONFIDENT prefix whose owner the candidate does NOT match, in an INCOMPATIBLE
  // category. Category compatibility (or unknown) spares private-label/multi-prefix cases.
  const prefixConfident = !!prefix && prefix.confidence >= 0.5 && prefix.ambiguity <= 0.5;
  const prefixConflict = prefixConfident && !mfrMatch && catCompatible === false;

  // Reverse known-UPC: the candidate's own established UPC SET excludes the scanned code. Only blocks
  // when the category is NOT compatible - otherwise it is a legitimate multi-prefix / multi-UPC product
  // and excluding it would be a false reject.
  const scan = normCode(code);
  const set = (input.candidateKnownUpcs ?? []).map(normCode).filter(Boolean);
  const reverseExcludes = set.length > 0 && !set.includes(scan);
  const reverseConflict = reverseExcludes && catCompatible !== true;

  const rawConflict = prefixConflict || reverseConflict;
  const overriddenByEvidence = rawConflict && strongExact;
  const conflict = rawConflict && !strongExact;
  const kind: FirewallVerdict["kind"] = !conflict
    ? "none"
    : reverseConflict
      ? "reverse_upc_conflict"
      : "prefix_manufacturer_conflict";
  const weight = !rawConflict ? 0 : reverseConflict ? Math.max(0.85, prefixWeight) : prefixWeight;

  let reason = "";
  if (overriddenByEvidence) {
    reason = `Prefix/UPC conflict present but OVERRIDDEN: the app verified the exact code in strong evidence.`;
  } else if (kind === "reverse_upc_conflict") {
    reason = `Candidate "${candidate.manufacturer || candidate.brand || "?"}" has a known UPC set that excludes this code, and its category does not match the barcode prefix owner (${prefix?.dominant?.name ?? "unknown"}). Blocked auto-verify -> Needs Review.`;
  } else if (kind === "prefix_manufacturer_conflict") {
    reason = `Barcode prefix maps to ${prefix?.dominant?.name ?? "unknown"} (${Object.keys(prefix?.categoryDist ?? {}).join("/")}); candidate is a different manufacturer + category (${candidate.manufacturer || candidate.brand || "?"} / ${candidate.category || "?"}). Weighted conflict -> Needs Review.`;
  }

  return { conflict, kind, weight, overriddenByEvidence, reason };
}
