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
    const matched = tier.texts.filter((t) => matches(t));
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
  return r.verified && (r.strength === "snippet" || r.strength === "grounding_chunk" || r.strength === "fetched_source");
}
