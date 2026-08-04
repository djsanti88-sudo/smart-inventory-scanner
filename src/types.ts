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

/** Where a record came from. "csv_import" (Task 3.6) = a human-uploaded onboarding CSV row; trusted
 *  like "manual" (aliases from it may be approved: true immediately), but tagged distinctly so the
 *  origin of a mapping stays auditable. */
export type Source = "seed" | "manual" | "scan" | "human_review" | "ai_mock" | "ai_gemini" | "ai_openai" | "catalog" | "csv_import";

/** Operations that get queued for idempotent sync. */
export type SyncOperation =
  | "SAVE_SCAN_EVENT"
  | "INCREMENT_COUNT"
  | "SAVE_UNKNOWN_SCAN"
  | "RESOLVE_ALIAS"
  | "SAVE_PRODUCT"
  | "SAVE_SESSION";

export type PendingItemStatus = "pending" | "syncing" | "synced" | "error" | "quarantined";

export type AiCircuitState = "closed" | "open" | "half_open";

// ----------------------------------------------------------------------------------------------
// Core entities
// ----------------------------------------------------------------------------------------------

// Provenance of a product's identity, from birth. P2's resolver tier interface reads this to rank
// tenant truth vs master truth; Phase 1 defaults every provisional mint to "provisional". Optional
// so older persisted rows (no tier yet) fall back to undefined = treat as lowest trust.
export type ProvenanceTier =
  | "provisional"
  | "ai_suggested"
  | "ladder_verified_strong"
  | "corpus_verified"
  | "human_verified";

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
  /** Phase 3: optional owner-entered per-unit cost for Boss Report inventory value. Platform/owner
   *  scoped - NEVER sent to AI (sanitizer strips it) and never in a customer-safe export/persist path. */
  unitCost?: number;
  status: "active" | "archived";
  source: Source;
  confidence: number; // 0..1
  // True only for trusted identity: seed/manual or human-created. AI never sets this true.
  // The resolver may return "known" from a product identifier ONLY when verified is true.
  verified: boolean;
  // PHASE 2 (Suggested provisional count): true ONLY for a product born from a weak AI suggestion that is
  // counted but unconfirmed (verified:false, NO approved alias). A re-scan increments it deterministically
  // (processScan provMatch) without re-deciding, and it stays in Needs Review until a human confirms it
  // (which flips provisional->false, verified->true, + creates the approved alias). Distinguishes it from an
  // ORPHANED verified product (verified lost on persist reset) which must still re-alias via resolveUnknown.
  provisional?: boolean;
  provenanceTier?: ProvenanceTier;
  /** Opaque server-issued identity used only to coalesce authenticated trusted-exact scan spellings. */
  trustedExactCanonicalId?: string;
  // Build 2 (product-name polish): fields split out of `name` by the deterministic structurer
  // (src/services/polish/structurer.ts) or, as a fallback, the LLM polish path. All optional so
  // older persisted products (no structuring run yet) fall back to `brand` / `name` at display time.
  structuredBrand?: string;
  structuredModel?: string;
  structuredDescription?: string;
  sizeTag?: string; // glued-digits tire size ("2657017") or weight/count/volume tag; "" / undefined = none
  // Who last produced the structured fields above. "human" is a PERMANENT lock: automatic
  // re-structuring (hot path AND the offline backfill) must skip a row stamped "human".
  structuredBy?: "deterministic" | "llm" | "human";
  // The structurer's own confidence (0..1) in the split above. Stamped by structuredFieldsFor
  // whenever it runs (deterministic pass); identifies rows eligible for the LLM backfill fallback
  // (confidence < 0.6, see src/services/polish/backfillLlm.ts). Undefined for a row never structured.
  structuredConfidence?: number;
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
  reason: string; // customer-safe, product-facing explanation (no AI/provider/Settings mechanics)
  decodeNote?: string; // platformOwner-only auto-decode detail (why AI did/didn't run); never shown to customers
  decodeStatus?: FeedDecodeStatus; // live-decode pipeline state for this scan row
  // P5 Task 5 (honest provenance badges, 2026-07-20): honest provenance signal for the feed row's
  // badge (see src/components/badges.tsx DecodeProvenance). Populated ONLY at the primary
  // live-decode write site (runLiveDecodeOnce) where a DecodeDecision is in scope - optional
  // because the ~15 other decodeStatus write sites (relabel/mark-wrong/suggest-link/etc.) do not
  // have a DecodeDecision in scope; full threading is deferred to P6. Display only, never gates
  // counting or identity.
  provenance?: "app_verified" | "ai_self_report" | "db_self_report";
  // Task 9 (owner-ratified 2026-07-14, decode-anything): true when an app-verified exact-code decode
  // counted even though its product domain is off the business scan context (e.g. hot sauce in a tire
  // shop). The category firewall was CLEARED by verification, not skipped - the row still shows an
  // "Off-category item" tag so the operator sees it is not a tire.
  offCategory?: boolean;
  // Task 9b (owner-ratified 2026-07-14): inline suggestion on the counted feed row. A decode whose
  // decision is "suggested" (usable identity, no firewall conflict, not auto-applied, not awaiting the
  // tire background verify) no longer sits in Needs Review - it tags the row "(suggested, NN%)" with
  // pointer-only approve/decline controls. Approve routes through the EXISTING human-approval core
  // (resolveUnknown via batchApprove); decline renames the row to the prefix floor and ONLY THEN
  // creates the open review. Both actions no-op unless status is "pending" (double-tap safe).
  suggestion?: {
    productName: string;
    brand: string;
    confidence: number; // 0..1 decision confidence, shown honestly in the tag
    status: "pending" | "approved" | "declined";
  };
  quantityDelta: number;
  quantityAfterScan: number;
  createdAt: string;
  source: Source;
  notes: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  idempotencyKey: string;
  /** Phase 3: the device that produced this scan (getOrCreateDeviceId). Attribution/debugging only -
   *  never used to decide whether a scan counts (that guarantee is the idempotencyKey/_appliedKeys
   *  transaction, unrelated to this field). Optional: older persisted events lack it. */
  deviceId?: string;
  /** Phase 3: free-text location captured at scan time (defaults to the session's location until
   *  changed - see Task 9). Optional: older persisted events lack it. */
  location?: string;
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
  /** Owner-PIN lock: when true the session is read-only - no new scans land in it and its counts cannot be
   *  edited until it is unlocked with the owner PIN. Optional for back-compat with older persisted sessions. */
  locked?: boolean;
  lockedAt?: string | null;
  /** Phase 3: the device that auto-opened this session (getOrCreateDeviceId). Undefined for
   *  manually-started or pre-Phase-3 sessions - those are never auto-reused (see autoSession.ts). */
  deviceId?: string;
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
  /** Phase 3: the most recent location a scan for this product/session was recorded at. Optional:
   *  older persisted counts lack it. Display-only; never part of the ledger identity. */
  location?: string;
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
  reason: string; // customer-safe, product-facing (no AI/provider/Settings mechanics)
  decodeNote?: string; // platformOwner-only auto-decode detail; never shown to customers
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
  // Prefix intelligence (platformOwner-only display): the brand the barcode prefix maps to, and the
  // anti-hallucination firewall's conflict reason (if any). Hints/evidence only, never identity truth.
  prefixHint?: string;
  prefixConflictReason?: string;
  // platformOwner-only: the proposed product already exists in the shop's catalog under a different code.
  reverseUpcConflictNote?: string;
  // Identity-merge (decode ladder Task 9) suggest_link: a decode that fuzzily matches an existing product
  // (same brand + name similarity, or a plus-generation / tire-size difference on a GTIN match) attaches
  // that product id here so the UI can offer a one-tap "link to existing product?" instead of a duplicate.
  // A suggestion only - it never auto-links or counts. Cleared when the review is resolved.
  suggestedLinkProductId?: string;
  // Confidence-based auto-verify outcome (when a decode was scored but did NOT auto-save).
  autoVerifyScore?: number;
  blockingReasons?: string[];
  // "suggested" (Task 9b, owner-ratified 2026-07-14): a PENDING inline suggestion. The review record
  // is PARKED here (kept for the audit trail + the batch-approve surface) instead of sitting "open" in
  // the Needs Review queue/badge. It is still awaiting a human: resolveUnknown accepts it exactly like
  // "open" (inline approve routes through that same core); decline flips it back to "open" with the
  // decline reason. Additive value - old persisted snapshots only carry the original three.
  status: "open" | "suggested" | "resolved" | "ignored";
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
  // Phase 7: set when this review was reopened by Mark wrong -> the re-decode escalates to the stronger model.
  reopenedFromWrong?: boolean;
  // STABLE-ID FIX (kills prefix-floor placeholder-name collision): the id of the provisional
  // "Unidentified item" / prefix-floor placeholder Product that THIS review's own scan minted via
  // ensureProvisionalCount, captured at review-creation time (the placeholder already exists by then -
  // ensureProvisionalCount runs synchronously before the review is created). resolveUnknown's
  // reload-resilient provOrphanId lookup matches on THIS id first (bulletproof - a local product id,
  // never a barcode/gtin, so it is safe to persist to a customer's disk). The old name-based fallback
  // (provisionalPlaceholderName match) is kept ONLY for reviews created before this field existed,
  // because a prefix-floor name is brand-only ("<Brand> / product unconfirmed") and NOT code-specific -
  // two different unresolved codes sharing a GS1-prefix brand mint the identical name, so the name match
  // can attribute one code's count to the other's review. A plain local id has no such collision.
  provisionalProductId?: string | null;
  /** Phase 4 import-only quantity. Absent for scans and reconcile links. A fuzzy import row keeps
   *  this quantity pending until an explicit human confirmation applies it. Its presence (not undefined)
   *  is also the import-origin marker: NeedsReviewTable hides liveDecode/correctionRecheck for any
   *  review carrying it, because Phase 4 must make zero /api/ai-lookup calls (C4). */
  importQuantity?: number;
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
  /** Salted SHA-256 hash of the owner PIN ("" = no PIN set). Never the plaintext PIN. Locking a session
   *  requires this to be set; unlocking verifies the entered PIN against it. See services/security/pinLock. */
  ownerPinHash: string;
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
  scanContext?: "any" | "tire"; // Phase 8: "tire" enables the category/brand-prefix conflict firewall
  trustedSourceAutoVerifyEnabled: boolean; // default true (Tier 1/2 exact-barcode fast path)
  aiOnlyAutoVerifyAllowed: boolean; // default false (AI w/o exact evidence can never auto-verify)
  autoCountNonPublicWithEvidence: boolean; // Option 3 (owner): default true. A non-public code (SKU/vendor/FNSKU) auto-counts when the app confirmed the exact code in a real/trusted source. Evidence-less guesses still never count.
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
  // QA Task 8 (owner-approved 2026-07-15, review-only near-match SKU suggestion): set ONLY when
  // resolverStatus is "needs_review" for an alpha_sku code (len >= 5) that is within Levenshtein
  // distance <= 1 of EXACTLY ONE verified product's primarySku/vendorCodes or approved alias
  // cleanCode. Two or more candidates within the bound means NO suggestion (never guess between
  // them). This NEVER upgrades resolverStatus, NEVER auto-counts, and NEVER auto-creates an alias -
  // it is purely a "Did you mean <X>?" hint for the Needs Review UI, applied only through the
  // existing human-approved link_existing path.
  nearMatchSuggestion?: {
    productId: string;
    matchedOn: string; // the specific code string it nearly matched (sku/vendorCode/alias)
    distance: number;
  };
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
  // Full text of a page the APP actually fetched and read for this result (page-fetch / firecrawl scrape).
  // This is the STRONGEST evidence channel: the EvidenceVerifier confirms the exact code in this real
  // page text. Kept on the result so its fetched_source provenance survives any re-verification via
  // evidenceOf() (it is never capped/sanitized into a snippet - it stays the raw fetched source).
  fetchedSourceText?: string;
  exactCodeEvidence?: boolean; // model SELF-CLAIM that the exact code appears in a source (untrusted)
  // Phase 9: set TRUE only by the page-fetch step when an INDEPENDENT model read of the SAME fetched page
  // agreed (via crossCheck) with the deterministic title extraction on the normalized tire identity. It is
  // the "page-fetch + one model agreement" corroboration signal; it never bypasses the firewall, the
  // exact-code evidence gate, the tire-spec gate, or the >=0.8 store gate.
  corroboratedByModel?: boolean;
  // Two INDEPENDENT Internet retrievals (grounded search + page fetch) agreed on the tire SIZE. Set by
  // the background size race in the route; consumed by decideDecode's internet_two_source_size branch.
  sizeAgreement?: boolean;
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
  /** Server says decode has a free/local rung (corpus/cache/prefix) before paid provider gates. */
  freeDecodeAvailable?: boolean;
  premiumFallback: boolean; // ENABLE_PREMIUM_MODEL_FALLBACK
  mode: string; // AI_LOOKUP_MODE
  dailyLimit: number; // AI_LOOKUP_DAILY_LIMIT
  missingKeys: string[];
  emergencyStop: boolean;
  lastAttemptAt: string | null;
  lastProvider: string;
  lastFailureReason: string;
  /** GPT-5.5 ladder rung's own daily dollar/call status (Task 6 Settings spend panel). Optional
   *  because it is a newer server field; a stale/mocked GET response without it is still valid. */
  gptLadder?: {
    spentTodayUsd: number;
    capUsd: number;
    callsToday: number;
    enabled: boolean;
  };
  /** Task 8: the real decode ladder order (MASTER BASELINE v1). Gemini is never in it - decode is
   *  corpus -> Go-UPC -> Fetch V2 -> GPT only. Optional because it is a newer server field; a stale
   *  GET response without it is still valid. */
  decodeLadder?: string[];
  /** Task 8: always false. Gemini fields above (geminiEnabled/geminiConfigured/geminiModel) stay for
   *  Settings + refreshAiStatus's gate, but Gemini is permanently out of decode (enrichment only). */
  geminiUsedForDecode?: boolean;
  /** Spec 2 (M1): SERVER kill switch (AI_LOOKUP_KILL_SWITCH env var). Distinct from `emergencyStop`
   *  above, which is a CLIENT preference the shop owner toggles locally - this one reflects a server
   *  operator's total-stop that the shop owner cannot turn off themselves. */
  killSwitchOn: boolean;
  /** Silent-failure fix: true when the most recent refreshAiStatus() could not confirm the server's
   *  kill-switch state (fetch threw, or the GET response was not ok). `killSwitchOn` keeps its
   *  last-known value in that case - it is never silently reset to a false "off" - and the UI must
   *  treat this as "unknown/stale", not as confirmation that AI lookup is fine. */
  killSwitchStatusUnknown?: boolean;
}

/** Which approved corroboration path produced a "verified" decode (for honest reporting). */
export type CorroborationPath =
  | "two_ai_agreement"
  | "single_source"
  | "page_fetch_model_agreement"
  | "deterministic_prefix"
  | "corpus_exact_barcode"
  | "corpus_exact_part_number"
  | "internet_two_source_size"
  | "non_public_trusted_source"
  | "boss_trusted_exact_barcode"
  | "gpt_self_report";

export interface DecodeDecision {
  status: DecodeStatus;
  confidence: number;
  reason: string;
  evidenceStrength: EvidenceStrength;
  exactCodeEvidenceVerifiedByApp: boolean; // set ONLY from EvidenceVerifier output, never the model
  crossCheck: CrossCheckResult;
  corroborationPath?: CorroborationPath; // set only when status === "verified"
  /** Opaque stable identity emitted only by the authenticated server-side trusted-exact path. */
  trustedExactCanonicalProductId?: string;
}
