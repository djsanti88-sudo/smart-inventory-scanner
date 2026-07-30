import type { AiLookupResult } from "@/types";
import { capSnippets } from "@/services/ai/snippetCap";

// AI provider abstraction. The app only ever calls a provider for UNKNOWN codes, after the
// deterministic matcher has missed and the input has been sanitized. Providers return the strict
// AiLookupResult JSON contract and NEVER make inventory-count decisions.

export interface AiLookupRequest {
  // Already sanitized by the caller (PII + cost masked). Providers must not assume otherwise.
  rawCodeSanitized: string;
  cleanCodeSanitized: string;
  contextSanitized?: string;
  allowImageSuggestions?: boolean;
  // W3 (v1.0.0): app-derived GS1 numbering-authority region hint (public barcodes only). Injected into
  // the TRUSTED prompt context as a NON-AUTHORITATIVE hint; never resolver/alias/evidence truth.
  gs1RegionHint?: string;
  // Phase 8B: app-derived, NON-AUTHORITATIVE prompt hints (advisory only; the firewall is the hard gate).
  scanContext?: "any" | "tire";
  brandPrefixHint?: string;
}

export interface AiProvider {
  name: string;
  lookup(req: AiLookupRequest, signal?: AbortSignal): Promise<AiLookupResult>;
}

/** A safe empty result used when a provider cannot or should not return data. */
export function emptyResult(): AiLookupResult {
  return {
    productName: "",
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    aliases: [],
    imageUrl: "",
    productUrl: "",
    sourceUrls: [],
    confidence: 0,
    verifiedFacts: [],
    guesses: [],
    needsHumanReview: true,
    sourceSnippets: [],
    groundingChunks: [],
    exactCodeEvidence: false,
  };
}

/** Clamp/repair a provider response into a valid AiLookupResult (defensive against bad JSON). */
export function normalizeResult(raw: Partial<AiLookupResult> | null | undefined): AiLookupResult {
  const base = emptyResult();
  if (!raw || typeof raw !== "object") return base;
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  return {
    ...base,
    ...raw,
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [],
    verifiedFacts: Array.isArray(raw.verifiedFacts) ? raw.verifiedFacts : [],
    guesses: Array.isArray(raw.guesses) ? raw.guesses : [],
    // W4 (v1.0.0): cap each AI-bound snippet/grounding chunk to MAX_AI_SNIPPET_CHARS. The full fetched
    // page text used by the EvidenceVerifier is a separate ProviderEvidence field and is never capped.
    sourceSnippets: capSnippets(Array.isArray(raw.sourceSnippets) ? raw.sourceSnippets : []),
    groundingChunks: capSnippets(Array.isArray(raw.groundingChunks) ? raw.groundingChunks : []),
    exactCodeEvidence: Boolean(raw.exactCodeEvidence),
    // sizeAgreement is an APP-owned corroboration flag, set ONLY by the route's two-source size race
    // (sizeRace.ts). A provider JSON must never inject it, so discard any raw value here - the route sets
    // the real app-computed value AFTER normalizeResult, and decideDecode's internet_two_source_size path
    // trusts only that. This makes the "app-computed only" invariant structural, not positional.
    sizeAgreement: undefined,
    // App-owned corpus provenance: external/provider JSON cannot claim it. The deterministic corpus
    // provider attaches it after this normalization boundary.
    trustedStructuredModel: undefined,
    confidence,
    // The 0.85 rule: anything below is forced to human review regardless of provider claim.
    needsHumanReview: confidence < 0.85 ? true : Boolean(raw.needsHumanReview),
  };
}
