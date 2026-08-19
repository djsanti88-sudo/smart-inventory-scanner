// Per-provider/per-source decode outcome types.
//
// HISTORY: this module used to hold `runDecode`, the legacy concurrent Gemini+OpenAI orchestrator that
// the decode ladder (src/server/decode/pipeline.ts) superseded. `runDecode` had no live caller and was
// DELETED by consolidation A1 (2026-08-19) together with the Gemini/OpenAI provider modules it drove.
// What survives is the shared reporting shape below, which the live pipeline still emits and which
// src/services/ai/decodeFallback.ts and src/services/benchmark/benchmarkAnalysis.ts consume.

/** Per-provider/per-source outcome - so failures are SURFACED, never hidden behind a generic message. */
export type ProviderStatusCode = "ok" | "no_match" | "skipped" | "rate_limited" | "timeout" | "error";

export interface ProviderStatus {
  provider: string;
  status: ProviderStatusCode;
  latencyMs: number;
  errorCode?: string; // safe code only (e.g. "429", "timeout", "500") - never a key or stack trace
  sourceUrlsReturned: number;
  exactCodeFound: boolean;
  identityFound: boolean;
}
