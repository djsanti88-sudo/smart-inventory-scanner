// The decode subsystem — single front door (Phase 2 isolation, behavior-preserving).
//
// This barrel RE-EXPORTS the existing pipeline (src/services/ai/*) under one module so the decode
// subsystem can be imported, reasoned about, and swapped as a unit. NOTHING is moved and NO behavior
// changes - existing imports keep working; this is purely an additional, documented entry point. See
// docs/decode/ARCHITECTURE.md for how the pieces fit, and ./contract.ts for the DecodeRequest/DecodeResult
// contract + the Provider port.

// ---- Contract (types only) ----
export type {
  DecodeRequest,
  DecodeResult,
  DecodeProviderPort,
  DecodeEnrichPort,
} from "@/services/decode/contract";

// ---- Orchestration ----
export { runDecode } from "@/services/ai/decodeOrchestrator";
export type { DecodeProvider, DecodeRunParams, DecodeRunResult, DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";

// ---- Decision + verification (the trust core) ----
export { decideDecode, isUsableProductName, cleanProductName } from "@/services/ai/decode";
export type { DecodeParams } from "@/services/ai/decode";
export { crossCheck, brandSimilarity, nameSimilarity } from "@/services/ai/crossCheckEngine";
export { verifyEvidence, strongestEvidence, isStrongEvidence } from "@/services/ai/evidenceVerifier";

// ---- Identity provider PORTS (Gemini, OpenAI, mock; future RAG implements the same AiProvider) ----
export { createGeminiProvider } from "@/services/ai/geminiProvider";
export { createOpenAiProvider } from "@/services/ai/openaiProvider";
export { mockProvider } from "@/services/ai/mockProvider";
export { emptyResult, normalizeResult } from "@/services/ai/provider";
export type { AiProvider, AiLookupRequest } from "@/services/ai/provider";
export { buildLookupPrompt, OUTPUT_SCHEMA, TRUSTED_CONTEXT } from "@/services/ai/prompt";

// ---- Enrich (the app's own page-fetch retrieval) ----
export { enrichWithPageFetch, barcodeDbUrls, looksLikeNotFound } from "@/services/ai/pageFetch";

// ---- Budget / cache / fallback / open-web discovery ----
export { clampDecodeBudgetMs } from "@/services/ai/decodeBudget";
export { withDecodeCache } from "@/services/ai/decodeCache";
export { shouldRunFallback, decodeReasonCode, REASON_TEXT } from "@/services/ai/decodeFallback";
export { raceFinders } from "@/services/ai/fallbackRunner";
export type { Finder } from "@/services/ai/fallbackRunner";
export { discoverViaFirecrawl } from "@/services/ai/firecrawlProvider";
