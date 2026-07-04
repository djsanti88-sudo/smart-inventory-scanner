import type { CodeType, EvidenceResult, EvidenceStrength, ProviderEvidence } from "@/types";

// EvidenceVerifier: the APP independently confirms that the exact scanned code actually appears in
// real evidence (snippets, grounding chunks, fetched source, or URLs). The model's own
// `exactCodeEvidence` self-claim is NEVER used to decide truth - only this verifier's output is.
//
// Strength ordering (weak -> strong): none < url_only < snippet < grounding_chunk < fetched_source.
// url_only is treated as NOT verified unless the host is explicitly trusted.

const NUMERIC_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14", "numeric_sku"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `code` appear in `text` as a standalone token? Numeric codes ignore spaces/hyphens. */
function matchInText(text: string, code: string, numeric: boolean): boolean {
  if (!text || !code) return false;
  if (numeric) {
    const collapsed = text.replace(/[\s-]/g, "");
    return new RegExp(`(?<![0-9])${escapeRe(code)}(?![0-9])`).test(collapsed);
  }
  return new RegExp(`(?<![A-Z0-9])${escapeRe(code.toUpperCase())}(?![A-Z0-9])`).test(text.toUpperCase());
}

/** For a numeric UPC/EAN/GTIN, the same product appears with different zero-padding across sources
 *  (UPC-12, GTIN-13, GTIN-14). Generate the equivalent forms so evidence still matches. */
function numericVariants(code: string): string[] {
  const stripped = code.replace(/^0+/, "") || "0";
  const set = new Set<string>([code, stripped]);
  for (const base of [code, stripped]) {
    if (base.length <= 13) set.add(base.padStart(13, "0"));
    if (base.length <= 14) set.add(base.padStart(14, "0"));
    if (base.length <= 12) set.add(base.padStart(12, "0"));
  }
  return [...set].filter((c) => c.length >= 8);
}

// A page that ECHOES the scanned code only to declare it INVALID (and usually suggests a DIFFERENT code)
// is not confirmation that the product exists for THIS code - it is the opposite. go-upc does exactly this
// for 745125495781 ("not a valid UPC ... did you mean 7451254957818 = Manstel rivet kit"). When a text
// channel carries such an invalidation, the code's presence there must NOT count as strong evidence.
const INVALIDATION_RE =
  /\bnot a valid\b|\binvalid (?:upc|ean|gtin|barcode|code|product)\b|\bdid you mean\b|\bisn'?t a valid\b|\bno such (?:upc|product|barcode)\b/i;
function looksInvalidating(text: string): boolean {
  return INVALIDATION_RE.test(text || "");
}

// A barcode-aggregator page that maps the ONE scanned code to MULTIPLE distinct products (a recycled /
// reused / conflated UPC) is unreliable for IDENTITY: upcitemdb lists 078742051451 as a "Velvet Torch
// Womens Lace Strapless Dress" AND two unrelated Calvin Klein shoes under "Product Name Variations".
// Such a page must NOT count as verifying evidence - it can still name a Suggested candidate downstream,
// but it can never auto-verify permanent truth + an approved alias. (Clean single-product pages, which do
// not carry this multi-product marker, are unaffected and still verify.)
// NUTRITION-FACTS DBs are the SINGLE-PRODUCT variant of the same disease (2026-07-04 ladder dry run):
// they index recycled UPCs against the wrong same-brand product - "nutrition facts and analysis" pages
// returned Lay's for a Munchies code and vice versa (identities swapped between two codes in one batch).
// The page text has no self-contradiction to detect, so the page CLASS is distrusted for identity.
const RECYCLED_RE =
  /\bproduct name variations\b|\bhas (?:the )?following product name\b|\b(?:also|other) product name variation|\bnutrition facts and analysis\b|\bnutrition facts for\b/i;
export function looksRecycledUpc(text: string): boolean {
  return RECYCLED_RE.test(text || "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^[a-z]+:\/\/([^/]+)/i);
    return (m?.[1] ?? "").toLowerCase();
  }
}

function isTrustedHost(url: string, trusted: string[]): boolean {
  const host = hostOf(url);
  return trusted.some((t) => host === t.toLowerCase() || host.endsWith("." + t.toLowerCase()));
}

/** FINDING-1 gate (Plan D parallel resolver): does the exact NUMERIC public barcode - including its
 *  GTIN zero-padding variants (UPC-12 / GTIN-13 / GTIN-14) - appear in any of the given source texts
 *  (grounding chunk titles / uris)? Invalidation prose ("not a valid UPC", "did you mean") never
 *  counts as confirmation. Pure and app-side: the model's self-claim is never consulted. */
export function numericCodeInTexts(code: string, texts: string[]): boolean {
  const norm = (code ?? "").trim();
  if (!norm || !texts?.length) return false;
  const candidates = numericVariants(norm);
  return texts.some((t) => candidates.some((c) => matchInText(t, c, true)) && !looksInvalidating(t));
}

export function verifyEvidence(
  code: string,
  codeType: CodeType,
  evidence: ProviderEvidence,
  opts?: { trustedHosts?: string[] },
): EvidenceResult {
  const norm = (code ?? "").trim();
  const numeric = NUMERIC_TYPES.includes(codeType);
  // Numeric codes match across zero-padding variants (UPC-12 vs GTIN-13/14); others match exactly.
  const candidates = numeric ? numericVariants(norm) : [norm];
  const matches = (text: string) => candidates.some((c) => matchInText(text, c, numeric));

  // Check from strongest evidence channel to weakest.
  const tiers: Array<{ strength: EvidenceStrength; texts: string[] }> = [
    { strength: "fetched_source", texts: evidence.fetchedSourceText ? [evidence.fetchedSourceText] : [] },
    { strength: "grounding_chunk", texts: evidence.groundingChunks ?? [] },
    { strength: "snippet", texts: evidence.sourceSnippets ?? [] },
    { strength: "url_only", texts: evidence.sourceUrls ?? [] },
  ];

  for (const tier of tiers) {
    // For prose channels (fetched source / snippet / grounding) a match inside an INVALIDATION page
    // ("not a valid UPC", "did you mean <other code>") is rejected - the code being there is a denial,
    // not a confirmation. url_only is just URLs (no prose), so the filter is a no-op there.
    const matched = tier.texts.filter((t) => matches(t) && (tier.strength === "url_only" || (!looksInvalidating(t) && !looksRecycledUpc(t))));
    if (matched.length === 0) continue;

    if (tier.strength === "url_only") {
      const trusted = opts?.trustedHosts ?? [];
      const trustedMatches = matched.filter((u) => isTrustedHost(u, trusted));
      const verified = trustedMatches.length > 0;
      return {
        verified,
        strength: "url_only",
        matchedCode: norm,
        matchedSources: matched,
        reason: verified
          ? "Exact code found in a URL from an explicitly trusted host."
          : "Exact code appears only in a URL from an untrusted host (treated as weak).",
      };
    }

    return {
      verified: true,
      strength: tier.strength,
      matchedCode: norm,
      matchedSources: matched,
      reason: `Exact code found in ${tier.strength.replace(/_/g, " ")}.`,
    };
  }

  return {
    verified: false,
    strength: "none",
    matchedCode: "",
    matchedSources: [],
    reason: "Exact code was not found in any provided evidence. Model self-claim is not trusted.",
  };
}

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  none: 0,
  url_only: 1,
  snippet: 2,
  grounding_chunk: 3,
  fetched_source: 4,
};

/** Pick the strongest EvidenceResult from a set (e.g. across multiple providers). */
export function strongestEvidence(results: EvidenceResult[]): EvidenceResult {
  if (results.length === 0) {
    return { verified: false, strength: "none", matchedCode: "", matchedSources: [], reason: "No evidence." };
  }
  return results.reduce((best, r) => (STRENGTH_RANK[r.strength] > STRENGTH_RANK[best.strength] ? r : best));
}

export function isStrongEvidence(r: EvidenceResult): boolean {
  // url_only is strong when VERIFIED (= the URL is from an explicitly trusted host: Amazon, Walmart,
  // Target, major retailers, GS1 registries, barcode DBs). An untrusted-host url_only has verified=false
  // and is correctly excluded. Owner rule: "found it on Amazon = that's all it takes."
  return r.verified && (r.strength === "snippet" || r.strength === "grounding_chunk" || r.strength === "fetched_source" || r.strength === "url_only");
}
