// The decode subsystem's CONTRACT (Phase 2 isolation). This file is the single, documented boundary for
// the pipeline that turns a scanned code into a trust decision. It is TYPE-ONLY: it adds no behavior and
// changes none - it names the existing shapes so the subsystem is swappable and testable as a unit. The
// runtime pieces are re-exported from ./index.ts (a barrel over the existing src/services/ai/* modules).
//
// The pipeline already works exactly like this today (see docs/DECODER_ARCHITECTURE.md); this contract just
// gives it one front door:
//
//   DecodeRequest  --(providers + enrich + verify + cross-check + decide)-->  DecodeResult
//
// A Provider PORT lets identity sources be swapped: Gemini, OpenAI, the local mock, and a FUTURE RAG
// provider all implement the same `AiProvider` interface, so adding retrieval-grounded identity is a new
// provider, not a rewrite. The page-fetch step is the separate `EnrichPort`.

import type { AiProvider, AiLookupRequest } from "@/services/ai/provider";
import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult } from "@/types";
import type { DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";

/** Canonical INPUT to the decode subsystem (superset built by the /api/ai-lookup route). */
export interface DecodeRequest {
  /** The exact scanned code (already cleaned + sanitized). Identity truth is verified against THIS. */
  code: string;
  codeType: CodeType;
  /** Business scan context; "tire" enables the deterministic tire-corroboration path. */
  scanContext?: "any" | "tire";
  /** Min provider self-confidence to consider a decode (store gate adds the >=0.9 auto-count floor). */
  confidenceThreshold?: number;
  /** Hard wall-clock budget for the whole concurrent fast path (clamped 5-20s server-side). */
  budgetMs?: number;
  allowImageSuggestions?: boolean;
  /** NON-AUTHORITATIVE prompt hints (never identity truth). */
  gs1RegionHint?: string;
  brandPrefixHint?: string;
}

/** Canonical OUTPUT of the decode subsystem (matches the /api/ai-lookup decode payload). */
export interface DecodeResult {
  /** The trust decision: verified | suggested | conflict | needs_review (decideDecode). */
  decision: DecodeDecision;
  /** Every source's product result, in priority order (page-fetch first, then providers). */
  results: AiLookupResult[];
  /** App-independent evidence verdict per result (exact code in real text?). */
  evidences: EvidenceResult[];
  providerNames: string[];
  providerStatuses: ProviderStatus[];
  timedOut: boolean;
  debug?: Record<string, unknown>;
}

/**
 * Provider PORT for IDENTITY sources. Gemini, OpenAI, the mock, and a future RAG provider all implement
 * this (`AiProvider`: { name, lookup(req, signal) -> AiLookupResult }). To add retrieval-grounded identity,
 * implement this and register it in the route's provider list - no pipeline change required.
 */
export type DecodeProviderPort = AiProvider;
export type { AiLookupRequest, AiLookupResult };

/**
 * ENRICH PORT for the app's own page-fetch (the deterministic, non-model retrieval step that opens the
 * candidate pages and confirms the exact code in the REAL page text -> the strongest `fetched_source`
 * evidence). Returns a product (or null) + its evidence. A RAG retriever could also implement this shape.
 */
export type DecodeEnrichPort = (signal: AbortSignal) => Promise<DecodeEnrich>;
export type { DecodeEnrich, ProviderStatus, DecodeDecision, EvidenceResult, CodeType };
