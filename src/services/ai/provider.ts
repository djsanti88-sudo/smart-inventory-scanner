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
    confidence,
    // The 0.85 rule: anything below is forced to human review regardless of provider claim.
    needsHumanReview: confidence < 0.85 ? true : Boolean(raw.needsHumanReview),
  };
}
