// Smart Inventory Scanner - data model.
// Flexible enough for many business types (tires, supplements, tools, retail, medical, etc.).
// Every record carries a businessId so this can become multi-tenant SaaS later.

// ----------------------------------------------------------------------------------------------
// Shared unions
// ----------------------------------------------------------------------------------------------

/**
 * How a scan was matched to a product. The matcher MUST label this accurately and never
 * collapse everything into "sku" (audit rule). "conflict" means a code mapped to more than
 * one product and was routed to Needs Review instead of guessed.
 */
export type MatchType =
  | "exact_alias"
  | "normalized_alias"
  | "primary_barcode"
  | "primary_sku"
  | "gtin"
  | "upc"
  | "ean"
  | "unknown"
  | "conflict";

/** Lifecycle status of a single scan event. */
export type ScanStatus = "known" | "unknown" | "needs_review" | "resolved" | "ignored" | "conflict";

/** Sync state shared by entities that get pushed to the (mock) database. */
export type SyncStatus = "synced" | "pending" | "error";

/** Detected shape of a scanned code (a hint, not an authority). */
export type CodeType =
  | "upc_a"
  | "ean_13"
  | "gtin_14"
  | "numeric_sku"
  | "alpha_sku"
  | "vendor_label" // X00.../B0... Amazon FNSKU/ASIN and similar vendor labels - NOT a product barcode
  | "messy"
  | "empty";

/**
 * Trust status produced by the deterministic resolver and carried on scan events.
 *  - known        : matched a verified product identifier or an approved alias (countable)
 *  - needs_review : unknown / weak / vendor label / unverified - goes to the review queue
 *  - conflict     : the code maps to more than one product (never guessed)
 *  - suggested    : an AI/mock suggestion attached to a review item (NEVER trusted/counted)
 *  - resolved     : a human approved a mapping for this code
 */
export type ResolverStatus = "known" | "needs_review" | "conflict" | "suggested" | "resolved";

/** Type of an alias, so we know how a code relates to its product. */
export type AliasType =
  | "barcode"
  | "gtin"
  | "upc"
  | "ean"
  | "sku"
  | "vendor_code"
  | "internal_code"
  | "messy_label"
  | "shelf_code";

/** Where a record came from. */
export type Source = "seed" | "manual" | "scan" | "human_review" | "ai_mock" | "ai_gemini" | "ai_openai" | "catalog";

/** Operations that get queued for idempotent sync. */
export type SyncOperation =
  | "SAVE_SCAN_EVENT"
  | "INCREMENT_COUNT"
  | "SAVE_UNKNOWN_SCAN"
  | "RESOLVE_ALIAS"
  | "SAVE_PRODUCT"
  | "SAVE_SESSION";

export type PendingItemStatus = "pending" | "syncing" | "synced" | "error";

export type AiCircuitState = "closed" | "open" | "half_open";

// ----------------------------------------------------------------------------------------------
// Core entities
// ----------------------------------------------------------------------------------------------

export interface Product {
  id: string;
  businessId: string;
  name: string;
  brand: string;
  category: string;
  specsShort: string;
  specsFull: string;
  primarySku: string;
  primaryBarcode: string;
  gtin: string;
  upc: string;
  ean: string;
  vendorCodes: string[];
  aliases: string[]; // denormalized clean codes for quick display; Alias[] is the source of truth
  imageUrl: string;
  productUrl: string;
  location: string;
  notes: string;
  status: "active" | "archived";
  source: Source;
  confidence: number; // 0..1
  // True only for trusted identity: seed/manual or human-created. AI never sets this true.
  // The resolver may return "known" from a product identifier ONLY when verified is true.
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface Alias {
  id: string;
  businessId: string;
  productId: string;
  rawCodeExample: string;
  cleanCode: string;
  normalizedCode: string;
  aliasType: AliasType;
  source: Source;
  confidence: number; // 0..1
  // True only for human-approved or verified seed aliases. AI never sets this true.
  // The resolver returns "known" from an alias ONLY when approved is true.
  approved: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  lastSeenAt: string;
  syncStatus: SyncStatus;
  idempotencyKey: string;
}

export interface ScanEvent {
  id: string;
  businessId: string;
  sessionId: string;
  rawCode: string;
  cleanCode: string;
  normalizedCandidates: string[];
  matchedProductId: string | null;
  matchType: MatchType;
  status: ScanStatus;
  resolverStatus: ResolverStatus; // trust outcome of the deterministic resolver
  codeType: CodeType;
  reason: string; // human-readable explanation of why this status was chosen
  decodeStatus?: FeedDecodeStatus; // live-decode pipeline state for this scan row
  quantityDelta: number;
  quantityAfterScan: number;
  createdAt: string;
  source: Source;
  notes: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  idempotencyKey: string;
}

export interface InventorySession {
  id: string;
  businessId: string;
  name: string;
  location: string;
  status: "active" | "completed";
  startedAt: string;
  completedAt: string | null;
  createdBy: string;
  notes: string;
  syncStatus: SyncStatus;
}

export interface InventoryCount {
  id: string;
  businessId: string;
  sessionId: string;
  productId: string;
  quantity: number;
  lastScannedAt: string;
  aliasesSeen: string[];
  scanEventIds: string[]; // dedupe ledger: an event id present here has already been counted
  createdAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  appliedIdempotencyKeys: string[];
}

export interface UnknownCodeReview {
  id: string;
  businessId: string;
  sessionId: string;
  rawCode: string;
  cleanCode: string;
  normalizedCandidates: string[];
  suggestedProductName: string;
  suggestedBrand: string;
  suggestedCategory: string;
  suggestedSpecsShort: string;
  suggestedSpecsFull: string;
  suggestedPrimarySku: string;
  suggestedPrimaryBarcode: string;
  suggestedGtin: string;
  suggestedUpc: string;
  suggestedEan: string;
  suggestedImageUrl: string;
  suggestedProductUrl: string;
  suggestedAliases: string[];
  sourceUrls: string[];
  verifiedFacts: string[];
  guesses: string[];
  reason: string;
  providerName: string;
  confidence: number; // 0..1
  // Whether an AI/mock suggestion has been attached (display as "Suggested", never trusted).
  hasSuggestion: boolean;
  // Decode pipeline output (display only; never bypasses human approval to count by default).
  decodeStatus: FeedDecodeStatus;
  evidenceStrength: EvidenceStrength;
  exactCodeEvidenceVerifiedByApp: boolean; // set ONLY by the app's EvidenceVerifier
  crossCheckDecision: string;
  // Per-provider summaries (e.g. Gemini result, OpenAI result) shown in the review.
  decodeProviderSummaries?: { provider: string; productName: string; sources: number }[];
  // Confidence-based auto-verify outcome (when a decode was scored but did NOT auto-save).
  autoVerifyScore?: number;
  blockingReasons?: string[];
  status: "open" | "resolved" | "ignored";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionAction: ResolutionAction | null;
  syncStatus: SyncStatus;
  idempotencyKey: string;
  // Phase 6 correction recheck (Gemini Pro, correction-only). Display/diagnostic; never auto-saves or counts.
  correctionRecheckStatus?: "requested" | "verified_correction" | "insufficient_evidence" | "conflict" | "unavailable";
  correctionRecheckedAt?: string | null;
  correctionRecheckMissingKeys?: string[];
}

export type ResolutionAction =
  | "link_existing"
  | "create_new"
  | "ignore"
  | "add_alias"
  | "reject_suggestion";

export interface AiLookupLog {
  id: string;
  businessId: string;
  rawCode: string;
  cleanCode: string;
  providerName: string;
  status: "success" | "error" | "blocked_offline" | "blocked_cap" | "cache_hit";
  confidence: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  cacheHit: boolean;
  circuitBreakerState: AiCircuitState;
  createdAt: string;
}

export interface PendingSyncItem {
  id: string;
  businessId: string;
  sessionId: string;
  entityType: "ScanEvent" | "InventoryCount" | "Alias" | "UnknownCodeReview" | "Product" | "CountSession";
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  status: PendingItemStatus;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  scanEventId: string | null;
}

export interface Settings {
  businessId: string;
  aiLookupEnabled: boolean;
  primaryProvider: "mock" | "gemini" | "openai";
  fallbackProvider: "mock" | "gemini" | "openai";
  dailyLookupLimit: number;
  dailyLookupCount: number;
  lastResetDate: string;
  requireHumanApprovalForMerges: boolean;
  allowImageSuggestions: boolean;
  allowProductUrlSuggestions: boolean;
  scannerSubmitMode: "enter" | "debounce" | "both";
  scannerDebounceMs: number;
  enablePendingSyncQueue: boolean;
  enableIdempotentSync: boolean;
  // When true, AI is queried automatically for unknown codes (still only as a SUGGESTION that a
  // human must approve - it never auto-saves). Default false to keep AI manual and cheap.
  autoSuggestUnknowns: boolean;
  // When true, a "verified" decode (app-verified strong evidence + provider agreement, public
  // barcode only) is auto-approved. Default FALSE - a human still approves even verified decodes.
  autoAcceptVerifiedDecodes: boolean;
  // When true, ANY decoded product (verified OR suggested-with-sources) is auto-added to the count -
  // only a provider conflict or a total no-result goes to Needs Review. Default TRUE (owner choice).
  autoAddDecodedProducts: boolean;
  // Hard time budget (ms) for a live decode. Owner-configurable in Settings; the server clamps it to
  // a safe range [5000, 20000]. Older persisted settings may lack it - read with a default.
  decodeBudgetMs: number;
  // Confidence-based auto-catalog learning. Strong evidence-backed matches auto-save to the verified
  // catalog (no owner approval); weak/conflicting/unsafe go to Needs Review. Safety gates always apply.
  autoCatalogLearningEnabled: boolean; // default true
  autoVerifyConfidenceThreshold: number; // default 80 (UI 70-95); lowering it cannot bypass safety
  trustedSourceAutoVerifyEnabled: boolean; // default true (Tier 1/2 exact-barcode fast path)
  aiOnlyAutoVerifyAllowed: boolean; // default false (AI w/o exact evidence can never auto-verify)
}

// ----------------------------------------------------------------------------------------------
// Service-level value objects
// ----------------------------------------------------------------------------------------------

/** Output of the deterministic code cleaner. Raw is preserved forever. */
export interface CleanedCode {
  rawCode: string;
  cleanCode: string;
  normalizedCandidates: string[];
}

/** Result of resolving a scan to a product (or not). */
export interface ScanResolution {
  matchType: MatchType;
  productId: string | null;
  matchedOn: string | null; // the specific code string that matched
  conflictProductIds?: string[];
}

/**
 * Full deterministic resolver output. AI is NEVER part of this - the resolver only ever returns
 * known/needs_review/conflict from verified local data. AI suggestions live on UnknownCodeReview.
 */
export interface ResolverResult {
  rawCode: string;
  cleanCode: string;
  normalizedCandidates: string[];
  codeType: CodeType;
  resolverStatus: "known" | "needs_review" | "conflict";
  matchType: MatchType;
  productId: string | null;
  confidence: number; // 1 for a verified known match; 0 otherwise (deterministic only)
  reason: string;
  conflictProductIds?: string[];
}

/** Structured AI lookup result (also the JSON contract the AI provider must return). */
export interface AiLookupResult {
  productName: string;
  brand: string;
  category: string;
  specsShort: string;
  specsFull: string;
  primarySku: string;
  primaryBarcode: string;
  gtin: string;
  upc: string;
  ean: string;
  aliases: string[];
  imageUrl: string;
  productUrl: string;
  sourceUrls: string[];
  confidence: number; // 0..1
  verifiedFacts: string[];
  guesses: string[];
  needsHumanReview: boolean;
  // Evidence channels (optional). The app verifies these independently - the model's claims here
  // are NOT trusted as truth.
  sourceSnippets?: string[]; // text snippets from sources / web-search results
  groundingChunks?: string[]; // Gemini grounding chunk text
  exactCodeEvidence?: boolean; // model SELF-CLAIM that the exact code appears in a source (untrusted)
}

// --- Evidence verification (the app independently verifies the exact code in real evidence) ---

export type EvidenceStrength = "none" | "url_only" | "snippet" | "grounding_chunk" | "fetched_source";

export interface ProviderEvidence {
  sourceUrls: string[];
  sourceSnippets: string[];
  groundingChunks: string[];
  fetchedSourceText?: string;
  exactCodeEvidence?: boolean; // model self-claim - NOT used to decide truth
}

export interface EvidenceResult {
  verified: boolean;
  strength: EvidenceStrength;
  matchedCode: string;
  matchedSources: string[];
  reason: string;
}

// --- Cross-check between providers ---

export type CrossCheckDecision = "agree" | "conflict" | "single_provider" | "weak";

export interface CrossCheckResult {
  decision: CrossCheckDecision;
  confidence: number;
  reason: string;
  brandSimilarity: number;
  nameSimilarity: number;
  contradictions: string[];
}

// --- Final decode decision (combines evidence + cross-check + gates) ---

export type DecodeStatus = "verified" | "suggested" | "conflict" | "needs_review";

/** Decode-pipeline status shown on a scan feed row (includes the transient "decoding"). */
export type FeedDecodeStatus =
  | "none"
  | "decoding"
  | "verified"
  | "suggested"
  | "conflict"
  | "needs_review"
  | "vendor_label";

/**
 * Live-AI availability/status reported by the server (no secrets) + local runtime flags.
 * Drives whether an unknown scan auto-runs the live decode pipeline and what Settings shows.
 */
export interface AiStatus {
  liveEnabled: boolean; // ENABLE_LIVE_AI_LOOKUP
  autoDecodeOnScan: boolean; // ENABLE_AUTO_DECODE_ON_SCAN
  geminiEnabled: boolean; // ENABLE_GEMINI_LOOKUP
  openaiEnabled: boolean; // ENABLE_OPENAI_LOOKUP
  geminiConfigured: boolean; // GEMINI_API_KEY present (server-side)
  openaiConfigured: boolean; // OPENAI_API_KEY present (server-side)
  premiumFallback: boolean; // ENABLE_PREMIUM_MODEL_FALLBACK
  mode: string; // AI_LOOKUP_MODE
  dailyLimit: number; // AI_LOOKUP_DAILY_LIMIT
  missingKeys: string[];
  emergencyStop: boolean;
  lastAttemptAt: string | null;
  lastProvider: string;
  lastFailureReason: string;
}

export interface DecodeDecision {
  status: DecodeStatus;
  confidence: number;
  reason: string;
  evidenceStrength: EvidenceStrength;
  exactCodeEvidenceVerifiedByApp: boolean; // set ONLY from EvidenceVerifier output, never the model
  crossCheck: CrossCheckResult;
}
