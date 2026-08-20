"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Alias,
  AiLookupLog,
  AiLookupResult,
  DecodeDecision,
  InventoryCount,
  InventorySession,
  PendingSyncItem,
  Product,
  ProvenanceTier,
  ResolverResult,
  ScanEvent,
  Settings,
  SyncOperation,
  UnknownCodeReview,
} from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";
import { normalizeCode } from "@/services/codeNormalizer";
import { evaluateMismatch, type MismatchVerdict } from "@/services/productMismatchGuard";
import { detectCodeType, codeTypeToAliasType } from "@/services/codeTypeDetector";
import { resolveScan } from "@/services/resolver";
import { isLikelyMisreadGtin } from "@/services/upc/misread";
import { gradeBarcode } from "@/services/upc/barcodeTrust";
import { canonicalGtin } from "@/services/upc/gtin";
import { clampDecodeBudgetMs, DECODE_BUDGET_DEFAULT_MS } from "@/services/ai/decodeBudget";
import { fetchWithBackoff } from "@/services/net/fetchWithBackoff";
import { hashPin, verifyPin, isValidPinFormat } from "@/services/security/pinLock";
import { isPlatformOwnerClient } from "@/services/security/roleAccess";
import { isCloudBackendEnabled } from "@/services/config/backend";
import type { DatabaseService } from "@/services/db/databaseService";
import { resolveScanToProductTiered } from "@/services/aliasMatcher";
import { blobContainsCodeToken, codeFromNamePrefix, normCodeToken } from "@/services/productDedup";
import { incrementInventoryCount } from "@/services/inventory";
import { buildIdempotencyKey } from "@/services/idempotency";
import { MockDb, getMockDb, type IncrementPayload, type SyncResult } from "@/services/mockDb";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import { auditRepository, catalogRepository } from "@/services/db/firebase/repositories";
import { getDb } from "@/lib/firebaseClient";
import { getSession } from "@/lib/auth";
import { postTelemetry } from "@/lib/telemetry";
import {
  evaluateAiGate,
  initBreaker,
  recordFailure,
  recordSuccess,
  canRequest,
  isDailyCapReached,
  type AiGateReason,
  type BreakerState,
} from "@/services/circuitBreaker";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { sanitizeCustomerReason, MISS_REASON_TEXT } from "@/services/ai/decodeFallback";
import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { getIdentityConfidenceBand } from "@/services/ai/identityConfidenceBand";
import { buildCleanupRecommendations } from "@/services/cleanup/recommendations";
import type { CatalogEntry, CatalogHit, ShopOverride } from "@/services/catalog/catalogTypes";
import { decideLookup, upsertVerified, applyAiCandidate, observeScan } from "@/services/catalog/localCatalogProvider";
import { planAutoVerify } from "@/services/catalog/catalogAutoVerify";
import { shopReverseUpcConflict, type UpcRecord } from "@/services/catalog/candidateUpcSet";
import { isTireContext, hasRequiredTireSpecs, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
import { extractTireFields } from "@/services/tire/extractTireFields";
import { collectGroundedIdentifiers, discoverableIdentifiers } from "@/services/aliasDiscovery";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";
import { deriveBrandPrefixHints, decodeBarcodeStructure } from "@/services/ai/barcodeAnatomy";
import { prefixFloorName, type PrefixFloorResult } from "@/services/catalog/prefixFloor";
import { fetchPrefixFloorEnrichment, isBareUnidentifiedLabel, brandIsOnlyFloorGuess, isFloorGuessOnlyLabel } from "@/services/catalog/prefixFloorEnrich";
import { detectScanContextConflict, detectOffCategoryAdvisory, detectIdentityContextConflict, conflictReason } from "@/services/ai/scanContextFirewall";
import { isCatalogWritable, toMasterAwareStoreEntry } from "@/services/catalog/sanitizeCatalog";
import { findIdentityMerge } from "@/services/catalog/identityMerge";
import { enrichProductIdentity } from "@/services/catalog/enrichProductIdentity";
import { toMasterCandidates } from "@/services/catalog/masterCandidates";
import {
  canAutoCount,
  shouldAutoApplySuggestion,
  decodeCorroborated as decodeCorroboratedGate,
} from "@/stores/scanGates";
import type { CatalogSourceTier, CatalogVerifiedBy } from "@/services/catalog/catalogTypes";
import { appendFeedback, type FeedbackEvent, type FeedbackEventType } from "@/services/feedback/feedback";
import type { CountSnapshot } from "@/services/reports/varianceReport";
import {
  buildSessionHistoryEntry,
  appendSessionHistory,
  type SessionHistoryEntry,
} from "@/services/sessions/sessionHistory";
import { toAuditEvent } from "@/services/audit/audit";
import { parseCsv, buildProductImport, type ImportConflict } from "@/services/csvImport";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { createCoalescedFailSoftPersistStorage, createAsyncCoalescedFailSoftPersistStorage } from "@/stores/scanPersistStorage";
import { createIdbBacking } from "@/stores/idbBacking";
import { emptyTenantState } from "@/stores/scanReset";
import { clearSelectedBusinessId } from "@/lib/selectedBusiness";
import {
  persistKeyForUid,
  migrateLegacyBlobOnce,
  migrateLegacyBlobOnceAsync,
  removePersistedKeyEverywhere,
  hasMeaningfulLegacyBlobAsync,
  LEGACY_PERSIST_KEY,
} from "@/stores/scanPersistNamespace";
import { getOrCreateDeviceId } from "@/services/deviceIdentity";
import { shouldReuseSession, buildAutoSessionName } from "@/services/sessions/autoSession";
import { buildDiscoveredIdentifiers } from "@/services/discoveredIdentifiers";
import { safeStructuredFieldsFor } from "@/services/polish/structuredFields";
import { backfillProducts } from "@/services/polish/backfillProducts";
import type { AiStatus } from "@/types";
import type { ImportPreviewRow, ImportReviewContext, UniversalImportApplySummary } from "@/services/importSchema";

/** Result summary of a CSV product import (shown in the UI). */
export interface CsvImportSummary {
  rowsParsed: number;
  productsCreated: number;
  aliasesCreated: number;
  duplicates: number;
  conflicts: ImportConflict[];
  /**
   * QA Task 7 (owner decision, catalog semantics): count of existing-barcode rows whose product had
   * its descriptive fields (name/brand/category/specsShort/location) refreshed from the row. Never
   * implies a quantity change - InventoryCount is untouched by a catalog re-import.
   */
  refreshed: number;
}

const UNIT_COST_HEADERS = ["unit_cost", "unit cost", "cost", "unitcost"];

function parseUnitCost(row: Record<string, string>): number | undefined {
  for (const key of Object.keys(row)) {
    if (UNIT_COST_HEADERS.includes(key.trim().toLowerCase())) {
      const raw = row[key]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

function importedRowCodes(row: Record<string, string>): Set<string> {
  const vendorRaw = row.vendor_codes || row.vendor || row.vendor_code || "";
  const values = [
    row.sku,
    row.primary_sku,
    row.barcode,
    row.primary_barcode,
    row.gtin,
    row.upc,
    row.ean,
    ...vendorRaw.split(/[|;]/),
  ];
  const codes = new Set<string>();
  for (const raw of values) {
    if (!raw?.trim()) continue;
    const cleaned = cleanScanCode(raw);
    if (cleaned.cleanCode) codes.add(cleaned.cleanCode);
    for (const candidate of cleaned.normalizedCandidates) codes.add(candidate);
  }
  return codes;
}

function applyImportedUnitCosts(rows: Record<string, string>[], products: Product[]): void {
  const costsByCode = new Map<string, number>();
  for (const row of rows) {
    const unitCost = parseUnitCost(row);
    if (unitCost === undefined) continue;
    for (const code of importedRowCodes(row)) costsByCode.set(code, unitCost);
  }
  for (const product of products) {
    const unitCost = product.aliases.map((code) => costsByCode.get(code)).find((value) => value !== undefined);
    if (unitCost !== undefined) product.unitCost = unitCost;
  }
}

/** Snapshot of rows removed by a junk cleanup, so the action is fully reversible (Undo). */
export interface CleanupBackup {
  removedCounts: InventoryCount[];
  removedProducts: Product[];
  removedAliases: Alias[];
  removedAt: string;
}

/** Full snapshot taken before deleting product(s), so a delete is fully reversible (Undo) + downloadable. */
export interface ProductDeleteBackup {
  products: Product[]; // the product rows as they were BEFORE delete (active/verified)
  aliases: Alias[]; // their aliases as they were BEFORE delete (approval intact)
  counts: InventoryCount[]; // their removed InventoryCount rows
  catalog: CatalogEntry[]; // removed global-catalog entries keyed to their codes
  shopOverrides: ShopOverride[]; // removed private shop-override entries keyed to their codes
  feed: ScanEvent[]; // scan-feed rows (full prior value) that referenced the deleted product(s)
  deletedAt: string;
  /** Ids of the "Unidentified item" provisionals minted by the delete to carry the deleted counts
   *  (TOP-LEVEL LAW: quantity never vanishes). Optional: older persisted backups lack it. Undo uses
   *  it to remove the now-empty provisionals after restoring the original rows. */
  mintedProvisionalIds?: string[];
}

/**
 * Task 2 (honest daily-cap copy): thrown by decodeOnce when /api/ai-lookup returns 429 with
 * reasonCode "daily_cap" (the server-side daily AI spend cap, not a self-inflicted rate limit).
 * This is a genuinely different failure than a transient rate limit - there is NO automatic
 * decode-on-cap-reset queue anywhere in the app (verified: only the sync retry queue and the
 * manual "Retry live decode" button exist), so the caught reason must not retry and must not
 * promise a retry that will never happen.
 */
export class DailyCapReachedError extends Error {
  readonly reasonCode: "daily_cap" | "account_daily_cap";
  /** P2 (Task 8): the $0 prefix floor the server threaded through the 429 body when the GS1 company
   *  prefix knows the company, so the cap-blocked row is named "<Brand> / product unconfirmed" instead
   *  of a bare "Unidentified item". Undefined when the code has no known prefix (unchanged behavior). */
  readonly floor?: PrefixFloorResult;
  /** F1/F4: distinguishes the GLOBAL server cap ("daily_cap") from the PER-ACCOUNT cap
   *  ("account_daily_cap", route.ts:311/331) so the row can carry the honest, account-specific copy. */
  readonly accountScoped: boolean;
  constructor(message = "Daily AI lookup cap reached", floor?: PrefixFloorResult, accountScoped = false) {
    super(message);
    this.name = "DailyCapReachedError";
    this.floor = floor;
    this.accountScoped = accountScoped;
    this.reasonCode = accountScoped ? "account_daily_cap" : "daily_cap";
  }
}

/**
 * AM-1(a) (owner-reported 36-70s browser blocks): thrown when the client-side decode fetch is
 * aborted by our own AbortController (timeout = decodeBudgetMs + 7000ms margin). The server-side
 * ladder deadline (L2, see pipeline.ts) is the primary fix - it bounds the SUM of every rung so the
 * request itself finishes fast - but the client must never trust the network to behave: an abort
 * here is NOT a retry case (the decode keeps running server-side; there is nowhere to retry TO), it
 * is an honest "still working, check back" signal that keeps the scan row open and reviewable.
 */
export class DecodeAbortedError extends Error {
  readonly reasonCode = "decode_aborted" as const;
  constructor(message = "Decode client-side abort timeout") {
    super(message);
    this.name = "DecodeAbortedError";
  }
}

const DEFAULT_AI_STATUS: AiStatus = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  openaiConfigured: false,
  freeDecodeAvailable: false,
  dailyLimit: 100,
  missingKeys: ["OPENAI_API_KEY"],
  emergencyStop: false,
  lastAttemptAt: null,
  lastProvider: "",
  lastFailureReason: "",
  killSwitchOn: false,
  killSwitchStatusUnknown: false,
};

/**
 * Decide whether an unknown scan should auto-run the live decode pipeline, and if not, WHY.
 * The "why" becomes the scan-row reason so the user always knows what happened (no silent skip).
 */
function evaluateAutoDecode(p: {
  aiEnabled: boolean;
  status: AiStatus;
  online: boolean;
  dailyCount: number;
  dailyLimit: number;
  breaker: BreakerState;
  now: number;
  /** GOD CLIENT (owner-approved 2026-08-07): the client-side platformOwner UI hint (derived from the
   *  SAME `effectiveClientAccessLevel` allowlist check `useAccessLevel`/`useIsPlatformOwner` use - never
   *  a server-trusted flag). When true, this only stops the CLIENT from pre-blocking the owner's own
   *  scans on the cap/breaker/emergency-stop gates below so a decode attempt always fires; the server
   *  remains the sole security-authoritative gate (isGod re-derived there from a verified token). Every
   *  OTHER client gate (AI off, server live-disabled, auto-decode-on-scan off, offline, missing keys)
   *  still applies unchanged - those are not caps/breaker/emergency, they are real preconditions for a
   *  decode attempt to make sense at all. */
  platformOwner?: boolean;
}): { allowed: boolean; reason: string } {
  if (!p.aiEnabled) return { allowed: false, reason: "AI lookup is off. Turn it on in Settings to auto-decode." };
  if (!p.status.liveEnabled)
    return { allowed: false, reason: "Live AI lookup is disabled on the server (ENABLE_LIVE_AI_LOOKUP=false)." };
  if (!p.status.autoDecodeOnScan) return { allowed: false, reason: "Auto decode on scan is disabled." };
  const isGodClient = p.platformOwner === true;
  if (!isGodClient && p.status.emergencyStop)
    return { allowed: false, reason: "Emergency stop is active. AI calls are paused." };
  if (!p.online) return { allowed: false, reason: "Offline. Saved locally; AI was not called." };
  const freeDecodeAvailable = p.status.freeDecodeAvailable === true;
  // When the server advertises free/local decode rungs (tire corpus, retail corpus, caches), do not
  // client-block solely on paid-provider keys or a spent cap: the server will answer $0 hits before
  // applying paid-rung gates. Older/mocked status payloads omit this flag, so they keep the legacy
  // key/cap client gate and existing tests do not accidentally start real/network decode attempts.
  if (!freeDecodeAvailable && !p.status.openaiConfigured) {
    const missing = p.status.missingKeys.join(", ") || "OPENAI_API_KEY";
    return { allowed: false, reason: `No API keys configured (missing: ${missing}). Set them server-side, then retry live decode.` };
  }
  if (!isGodClient && !freeDecodeAvailable && isDailyCapReached(p.dailyCount, p.dailyLimit))
    return { allowed: false, reason: "Daily AI lookup cap reached. Routed to Needs Review." };
  if (!isGodClient && !canRequest(p.breaker, p.now).allowed)
    return { allowed: false, reason: "AI circuit breaker is open after repeated failures. Routed to Needs Review." };
  return { allowed: true, reason: "Decoding with AI..." };
}

/** GATE-BYPASS hint ONLY (advisory only - see evaluateAutoDecode's `platformOwner` doc). Deliberately
 *  uses `isPlatformOwnerClient` (the raw NEXT_PUBLIC_PLATFORM_OWNER_UIDS/EMAILS allowlist check), NOT
 *  `effectiveClientAccessLevel`/`useAccessLevel`/`useIsPlatformOwner` - those ALSO honor
 *  `NEXT_PUBLIC_E2E_PLATFORM_OWNER=1` (the mock-E2E full-UI-access override used by the 11 mock
 *  Playwright specs), which must grant the platformOwner UI ROLE without ever granting a cap/breaker/
 *  emergency-stop BYPASS to an arbitrary E2E-mocked identity. A dedicated name (not shared with the UI
 *  role hint) keeps that distinction impossible to blur at a future call site. */
function isPlatformOwnerForGateBypass(userId: string | null): boolean {
  return isPlatformOwnerClient({ uid: userId });
}

/**
 * GOD CLIENT (owner-approved 2026-08-07): shared override for every `evaluateAiGate` re-check on a
 * decode-execution path (`runLiveDecodeOnce`, `backgroundVerifyDeep`
 * follow-up). `evaluateAutoDecode` already bypasses the SAME cap/breaker/emergency-stop pre-block at
 * enqueue time; `evaluateAiGate` is a separate, lower-level re-check each of those paths runs again
 * just before actually firing (defense-in-depth against state drifting between enqueue and execution).
 * Owner intent (2026-08-07 review): "god account has no caps, limits, or anything" - so ALL decode
 * paths must never client-pre-block the platform owner, not only the primary scan-time path. Only
 * `daily_cap`/`circuit_open` are overridden here; `disabled` (AI off) and `offline` remain real
 * preconditions for everyone, god included - matching `evaluateAutoDecode`'s own scope exactly.
 */
function applyGodGateOverride<T extends { allowed: boolean; reason: AiGateReason }>(
  gate: T,
  isGodClient: boolean,
): T {
  if (isGodClient && (gate.reason === "daily_cap" || gate.reason === "circuit_open")) {
    return { ...gate, allowed: true };
  }
  return gate;
}

/**
 * Tire portion of the auto-count gate, shared by liveDecode + backgroundVerifyDeep so the spec requirement
 * cannot drift between the two paths again. A non-tire decode is unaffected; a tire must carry the COUNTABLE
 * identity (brand-prefix + size + model), matching the route's verify gate (decode.ts hasCountableTireIdentity).
 * Load index + speed rating are optional enrichment, not required to count. This relaxes ONLY the spec
 * requirement; every other clause of the gate (verified status, app-verified exact code, confidence >= 0.8,
 * firewall / brand-prefix conflict, planAutoVerify) is enforced separately and unchanged.
 */
function tireAutoCountOk(best: AiLookupResult | null | undefined): boolean {
  return !isTireContext(best) || hasCountableTireIdentity(best);
}

/**
 * BUG FIX (badge/reason contradiction, live-proven 115-code preview run): a raw decode `decision.reason`
 * describes the SOURCE's own confidence tier ("Verified from the trusted tire knowledge base (exact
 * barcode). No AI lookup needed.") - that text is only honest on a row actually badged "verified". The
 * feed-row write site downgrades a raw "verified" decision.status to a "suggested" display badge the
 * INSTANT the decode response lands (a raw verified decode still has to clear the app's own auto-count
 * gate / resolveUnknown before it can honestly claim "Verified match" - see the "BUG FIX
 * (verified-shows-Unidentified, burst report)" comment on the same write site). Without this, the row
 * showed decodeStatus "suggested" (or a later "needs_review"/"conflict") while `reason` kept the raw
 * "Verified...No AI lookup needed" claim - a direct contradiction the owner caught live. This function is
 * the SINGLE choke point that reframes a verified-tier reason into an honest suggested-tier one whenever
 * the displayed badge is not (or no longer) "verified". Never invents a new reason - reuses the same text,
 * relabeled, so a corpus/trusted-source hit is still traceable, just described accurately for the tier
 * actually shown. A non-"verified" raw decision's reason is already honest for its own tier and passes
 * through unchanged.
 */
function honestReasonForBadge(rawReason: string | undefined | null, rawStatus: string | undefined, displayedBadge: string | undefined): string {
  const reason = rawReason ?? "";
  if (!reason) return reason;
  if (rawStatus !== "verified" || displayedBadge === "verified") return reason;
  // The source found an exact/strong match, but the app has not (yet, or ever) independently resolved it
  // to a real counted product - state that honestly instead of echoing the source's own "Verified"/"No AI
  // lookup needed" framing over a non-verified badge.
  return `Matched from a trusted source (${reason.replace(/^Verified\s+/i, "").replace(/\.\s*No AI lookup needed\.?$/i, "")}). Needs confirmation before it counts as verified.`;
}

/**
 * What counts as "corroborated" for auto-count, shared by liveDecode + backgroundVerifyDeep so the rule
 * cannot drift. The app-verified exact code OR the internet_two_source_size path (brand from the strong GS1
 * prefix + two independent Internet sources agreeing on the size, set app-side by the route race). The
 * local DB is never involved. Every OTHER gate clause (verified status, confidence >= 0.8, tireOk,
 * no context conflict, autoAddOn) is enforced separately and unchanged.
 */
// Re-exported from the pure gate module (src/stores/scanGates.ts) so existing importers
// (scanStore.autocount.test.ts imports it from "./scanStore") keep working unchanged.
export const decodeCorroborated = decodeCorroboratedGate;

/**
 * Thin store-side wrapper over the pure shouldAutoApplySuggestion gate (src/stores/scanGates.ts): it only
 * computes productNameUsable from the raw productName and delegates. The trust rules live in the pure
 * module; keeping this wrapper preserves the two identical call sites (liveDecode + backgroundVerifyDeep).
 */
function autoSuggestApplyOk(params: {
  autoAddOn: boolean;
  contextConflict: unknown;
  productName: string;
  confidence: number;
  status: string | undefined;
  exactCodeEvidenceVerifiedByApp: boolean;
}): boolean {
  return shouldAutoApplySuggestion({
    autoAddOn: params.autoAddOn,
    contextConflict: params.contextConflict,
    productNameUsable: isUsableProductName(params.productName),
    confidence: params.confidence,
    status: params.status,
    exactCodeEvidenceVerifiedByApp: params.exactCodeEvidenceVerifiedByApp,
  });
}

/**
 * Bounded decode queues (Task 5): ordinary decode retains its two-wide FIFO lane. Authenticated
 * deterministic-only trusted-exact probes use a separate four-wide FIFO lane so a corpus burst cannot
 * sit behind general enrichment. Counting/persistence NEVER waits on either queue -
 * `ensureProvisionalCount` already ran SYNCHRONOUSLY at scan time, before `liveDecode` is ever invoked.
 */
const MAX_CONCURRENT_DECODES = 2;
const MAX_CONCURRENT_TRUSTED_EXACT_DECODES = 4;
// Task 3.5: cap the count-snapshot ring buffer (same pattern as FEEDBACK_EVENT_CAP) so the variance/
// shrinkage report's history stays useful without growing localStorage unbounded.
const COUNT_SNAPSHOT_CAP = 12;
type DecodeTask = { run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void };

/**
 * BULK PACER (owner-approved 2026-08-07): a light client-side token bucket so a 500-2000 code paste
 * self-throttles the RATE of decode dispatch instead of firing every queued request the instant a slot
 * frees up. `MAX_CONCURRENT_DECODES` already bounds concurrency (how many requests are in flight at
 * once) but not RATE (how fast slots turn over) - a fast-miss corpus round-trip (free rungs only, no
 * network) can turn slots over fast enough to burst past `AI_LOOKUP_RATE_LIMIT`, whose SERVER DEFAULT
 * is 600/60s = 10 requests/second (aiSpendGuard.checkRateLimit's AI_LOOKUP_RATE_LIMIT fallback). The
 * client default is pinned to that same 10/s (S6 fix, see GENERAL_DECODE_RATE_PER_SEC below) and is
 * raised by env only where the deployment has actually raised the server limit. Anything faster than
 * the server bucket just converts a bulk paste into a 429 storm on the very next window.
 * Only the GENERAL queue is paced: the trusted-exact probe queue is
 * server-side FREE of the rate limit (route.ts returns before `checkRateLimit` for `deterministicOnly`
 * requests - see inv-bulk-ratelimit.md #1) and pacing it would only slow down decode with no rate-limit
 * benefit. TOP LAW unaffected: counting already happened synchronously in `ensureProvisionalCount`
 * before any code ever reaches this queue - the pacer only paces the decode POST cadence, never a row's
 * appearance or count.
 */
// S6 (deep review 2026-08-09): the client default now MATCHES the server default. The comment above
// used to claim a 20000/60s server ceiling, but aiSpendGuard.checkRateLimit's actual default is
// 600/60s = 10 requests/second (aiSpendGuard.ts, the AI_LOOKUP_RATE_LIMIT fallback). Pacing at 50/s
// against a 10/s bucket drains it in about 12 seconds and then 429-storms in ANY environment that has
// not raised AI_LOOKUP_RATE_LIMIT. Defaulting to the server default makes the safe case the DEFAULT
// case; a deployment that genuinely raises AI_LOOKUP_RATE_LIMIT (production does) raises the client
// pacer with the env override below, so proven production behavior is unchanged. Both values must be
// NEXT_PUBLIC_* to be readable in the browser bundle.
function decodePacerEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const GENERAL_DECODE_RATE_PER_SEC = decodePacerEnvNumber(process.env.NEXT_PUBLIC_DECODE_RATE_PER_SEC, 10);
// Burst allowance: one second's worth of the sustained rate. Kept at the same scale as the rate so an
// ordinary handful-of-scans session never touches the pacer (it dispatches instantly out of the burst),
// while a genuine bulk paste settles onto the sustained rate immediately after the burst is spent.
const GENERAL_DECODE_BURST = decodePacerEnvNumber(process.env.NEXT_PUBLIC_DECODE_BURST, 10);

type TokenBucket = {
  capacity: number;
  tokens: number;
  refillPerMs: number;
  lastRefillAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

function makeTokenBucket(ratePerSec: number, burst: number): TokenBucket {
  return { capacity: burst, tokens: burst, refillPerMs: ratePerSec / 1000, lastRefillAt: Date.now(), timer: null };
}

/** Exported for tests only: resets a bucket's live time reference so fake-timer tests get deterministic
 *  refill math instead of depending on wall-clock Date.now() drift between store construction and test run. */
function resetTokenBucket(bucket: TokenBucket, nowMs: number): void {
  bucket.tokens = bucket.capacity;
  bucket.lastRefillAt = nowMs;
  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}

type DecodeQueue = {
  pendingIds: string[];
  tasks: Map<string, DecodeTask>;
  active: number;
  limit: number;
  pacer?: TokenBucket;
};
const generalDecodeQueue: DecodeQueue = {
  pendingIds: [],
  tasks: new Map(),
  active: 0,
  limit: MAX_CONCURRENT_DECODES,
  pacer: makeTokenBucket(GENERAL_DECODE_RATE_PER_SEC, GENERAL_DECODE_BURST),
};
const trustedExactDecodeQueue: DecodeQueue = {
  pendingIds: [],
  tasks: new Map(),
  active: 0,
  limit: MAX_CONCURRENT_TRUSTED_EXACT_DECODES,
};
// Dedupe within each stage: a review already queued OR in flight resolves to the SAME promise instead
// of being queued twice. The stage is part of the key because an exact miss must be allowed to enqueue
// exactly one ordinary decode for the same review without either stage duplicating itself.
const decodeTaskPromises = new Map<string, Promise<void>>();

function drainDecodeQueue(queue: DecodeQueue): void {
  while (queue.active < queue.limit && queue.pendingIds.length > 0) {
    const pacer = queue.pacer;
    if (pacer) {
      const nowMs = Date.now();
      const elapsedMs = Math.max(0, nowMs - pacer.lastRefillAt);
      pacer.tokens = Math.min(pacer.capacity, pacer.tokens + elapsedMs * pacer.refillPerMs);
      pacer.lastRefillAt = nowMs;
      if (pacer.tokens < 1) {
        // Not enough budget to dispatch another request yet. Schedule exactly one resume once at
        // least one token will exist, then stop dispatching for this tick - never drop or lose a
        // queued review, it just waits its turn (still counted; only the decode POST is deferred).
        if (!pacer.timer) {
          const msUntilToken = (1 - pacer.tokens) / pacer.refillPerMs;
          pacer.timer = setTimeout(() => {
            pacer.timer = null;
            drainDecodeQueue(queue);
          }, Math.max(1, Math.ceil(msUntilToken)));
        }
        return;
      }
      pacer.tokens -= 1;
    }
    const reviewId = queue.pendingIds.shift()!;
    const task = queue.tasks.get(reviewId);
    queue.tasks.delete(reviewId);
    if (!task) continue;
    queue.active++;
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        queue.active--;
        drainDecodeQueue(queue);
      });
  }
}

function enqueueDecode(reviewId: string, run: () => Promise<void>, deterministicOnly = false): Promise<void> {
  const taskKey = `${deterministicOnly ? "trusted-exact" : "general"}:${reviewId}`;
  const existing = decodeTaskPromises.get(taskKey);
  if (existing) return existing;
  const queue = deterministicOnly ? trustedExactDecodeQueue : generalDecodeQueue;
  const promise = new Promise<void>((resolve, reject) => {
    queue.pendingIds.push(reviewId);
    queue.tasks.set(reviewId, { run, resolve, reject });
  });
  decodeTaskPromises.set(taskKey, promise);
  const cleanup = () => decodeTaskPromises.delete(taskKey);
  promise.then(cleanup, cleanup);
  drainDecodeQueue(queue);
  return promise;
}

/**
 * Phase-2 POISON GUARD core check (centralizes what used to be three copy-pasted blocks in
 * resolveUnknown). Returns true when a create_new is accepting the review's AI SUGGESTION (the new
 * product's normalized name equals the suggested name) AND the app could NOT back that suggestion with
 * any real evidence - no brand, no gtin/upc/ean, no source URL. Such an evidence-less guess must never
 * become a verified product / approved alias / verified catalog entry.
 *
 * NOTE: this is ONLY the name+evidence decision. The per-call-site `origin !== "human"` clause is applied
 * by the caller (two sites gate on it, the fresh-mint site historically does not) so this extraction does
 * NOT change any trust decision - it only de-duplicates the shared logic.
 */
function isWeakGuess(review: UnknownCodeReview, np: Partial<Product>): boolean {
  const normName = (s: string) => cleanProductName(s ?? "").trim().toLowerCase();
  const suggestedName = normName(review.suggestedProductName ?? "");
  const acceptingSuggestion =
    !!review.hasSuggestion && suggestedName.length > 0 && normName(np.name ?? "") === suggestedName;
  const suggestionHasRealEvidence =
    (review.suggestedBrand ?? "").trim().length > 0 ||
    [review.suggestedGtin, review.suggestedUpc, review.suggestedEan].some((c) => (c ?? "").trim().length > 0) ||
    (review.sourceUrls?.length ?? 0) > 0;
  return acceptingSuggestion && !suggestionHasRealEvidence;
}

/** TRUST GATE (spec v3 AM-4.2): rejected barcode identity fields are blanked, never stored. This is
 *  the single choke point for both resolveUnknown minting sites (provisional upgrade + fresh mint) -
 *  a phantom/misread barcode never becomes searchable/trusted product identity. The scanned cleanCode
 *  alias is NOT gated here (physically scanned; vendor labels must keep aliasing - Resolver Trust Rules
 *  unchanged). Blanking a field never blocks minting, counting, or alias teaching. */
function gateIdentityBarcodeFields(
  np: { gtin?: string; upc?: string; ean?: string; primarySku?: string },
): { gtin: string; upc: string; ean: string } {
  const gate = (v?: string): string => {
    const value = (v ?? "").trim();
    if (!value) return "";
    return gradeBarcode({ barcode: value, partNumber: np.primarySku }).verdict === "rejected" ? "" : value;
  };
  return { gtin: gate(np.gtin), upc: gate(np.upc), ean: gate(np.ean) };
}

/** Defense in depth (AM-4.4): a decode-provided barcode field that fails the trust gate is scrubbed
 *  from the review's suggested* fields so no approve path can launder it into identity. */
function scrubSuggestedBarcode(value: string | undefined, partNumber?: string): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return gradeBarcode({ barcode: v, partNumber }).verdict === "rejected" ? "" : v;
}

export function trustedExactProbeCandidate(code: string): boolean {
  const value = code.trim();
  const grade = gradeBarcode({ barcode: value });
  if (grade.placeholder) return false;
  // The exact corpus admits short numeric shop identifiers, invalid-check-digit spellings certified
  // from source evidence, and bounded scanner-safe mixed labels. Merely probing these shapes grants no
  // trust: settlement still requires the server attestation, opaque canonical id, and index digest.
  return /^\d{3,14}$/.test(value)
    || (/^(?=.{5,64}$)(?=.*\d)[A-Za-z0-9 ._%+'():/-]+$/.test(value));
}

function trustedExactCanonicalId(data: {
  decision?: DecodeDecision;
  trustedExact?: { path?: unknown; index?: { schemaVersion?: unknown; contentDigest?: unknown } };
}): string | null {
  const decision = data.decision;
  const index = data.trustedExact?.index;
  const id = decision?.trustedExactCanonicalProductId;
  return decision?.status === "verified"
    && decision.exactCodeEvidenceVerifiedByApp === true
    && decision.corroborationPath === "boss_trusted_exact_barcode"
    && data.trustedExact?.path === "boss_trusted_exact_barcode"
    && typeof index?.schemaVersion === "string"
    && /^\d+\.\d+\.\d+$/.test(index.schemaVersion)
    && typeof index.contentDigest === "string"
    && /^[A-F0-9]{64}$/i.test(index.contentDigest)
    && typeof id === "string"
    && /^trusted-exact:v1:[A-F0-9]{32}$/.test(id)
    ? id
    : null;
}

/** PN-BARCODE-CARRY (owner-reported: a PN-resolved suggestion's corpus barcode never carried through
 *  to the counted provisional row). Decides whether a decode's suggested barcode may be carried onto
 *  a provisional product's primaryBarcode. Guard rules:
 *  1. Never clobber a REAL scanned barcode: only carries when the row's current primaryBarcode is
 *     empty, OR equals the scanned cleanCode AND that cleanCode is not itself GTIN-shaped (i.e. it is
 *     a PN/vendor-label placeholder the corpus may upgrade, never a physically-scanned barcode).
 *  2. Must clear the same trust gate as the suggested* fields (scrubSuggestedBarcode /
 *     gradeBarcode) - a bad-check-digit or rejected barcode is never carried.
 *  Returns "" when the carry should NOT happen (caller keeps the existing value). */
function carriedProvisionalBarcode(params: {
  currentPrimaryBarcode: string;
  scannedCleanCode: string;
  scannedCodeType: string;
  candidateBarcode: string | undefined;
  partNumber?: string;
}): string {
  const current = (params.currentPrimaryBarcode ?? "").trim();
  const scannedIsGtin = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(params.scannedCodeType);
  const currentIsPlaceholder = current === "" || (current === params.scannedCleanCode.trim() && !scannedIsGtin);
  if (!currentIsPlaceholder) return ""; // real scanned barcode already present - never clobber
  return scrubSuggestedBarcode(params.candidateBarcode, params.partNumber);
}

/**
 * The exact SAME safe, non-hallucinated placeholder label `ensureProvisionalCount` mints for an
 * unresolved code ("Unidentified item (barcode/code CODE)", or a prefix-floor brand guess when the GS1
 * prefix maps to a known brand). Pure function of the code alone, so it can be recomputed later purely
 * from `review.cleanCode` - used as a reload-resilient fallback to re-identify a scan's own provisional
 * placeholder product when its `provisional` flag and identifier fields (primaryBarcode/gtin/upc/ean/
 * primarySku) were stripped by the customer-role localStorage split (buildPersistedScanState /
 * CUSTOMER_SAFE_PRODUCT_FIELDS never persists those product-identity fields to a customer's disk).
 */
// F5 bundle-surgery: productIds with an /api/prefix-floor enrichment round-trip currently in flight.
// Module-level (not store state - transient network bookkeeping, never persisted): multiple call sites
// can request enrichment for the same freshly minted row in one scan flow; only one fetch ever fires.
const enrichInFlight = new Set<string>();

function provisionalPlaceholderName(code: string): string {
  const ct = detectCodeType(code);
  const struct = decodeBarcodeStructure(code, ct);
  const floor = prefixFloorName(code, ct);
  return floor ? floor.name : struct.checkDigitValid ? `Unidentified item (barcode ${code})` : `Unidentified item (code ${code})`;
}

// The local optimistic session store. Known scans update this store immediately - the UI never
// waits on a server round-trip. Sync to the (mock) backend happens AFTER the user sees feedback,
// using idempotency keys so a retry can never double-count.

// The storage half of these dependencies (db, cloudBackend, trustedExactProbeEnabled,
// loadBusinessData, audit, lookupGlobalCatalog) now lives in @/services/db/databaseService as the
// DatabaseService port, so "what would a replacement backend have to provide?" is answerable without
// reading this file. Extending it means the two cannot drift: a new storage capability added here
// without declaring it there is a type error.
//
// What remains below is what is genuinely NOT storage - an id factory, a clock, and a persistence key
// - kept injectable so tests can make both deterministic.
export interface ScanStoreDeps extends DatabaseService {
  idFactory: () => string;
  now: () => string;
  persistName: string | null; // null disables persistence (used by tests)
}

export const DEFAULT_SETTINGS: Settings = {
  businessId: DEMO_BUSINESS_ID,
  ownerPinHash: "", // no owner PIN set until the owner chooses one in Settings

  // Internal lookup is ALWAYS-ON by default: unknown codes auto-attempt the internal decode pipeline
  // (when configured server-side) before going to Needs Review. The toggle remains platformOwner-only.
  aiLookupEnabled: true,
  dailyLookupLimit: 200, // fallback if the server cap (AI_LOOKUP_DAILY_LIMIT) is unreachable
  dailyLookupCount: 0,
  lastResetDate: "1970-01-01",
  requireHumanApprovalForMerges: true,
  allowImageSuggestions: true,
  allowProductUrlSuggestions: true,
  scannerSubmitMode: "both",
  scannerDebounceMs: 80,
  enablePendingSyncQueue: true,
  enableIdempotentSync: true,
  autoSuggestUnknowns: false,
  autoAddDecodedProducts: true,
  // AM-9 (2026-07-15): the server has always clamped decode budget to [5000, 8000] (owner cost rule
  // 2026-06-28); this default previously drifted to 13000, which the server silently clamped down to
  // 8000 on every request. New installs now get the real default. Existing installs with a persisted
  // 13000 are NOT reset here (persist migrate would also wipe learned products/aliases per CLAUDE.md -
  // never trigger that just to fix a settings number) - instead every read site below clamps at
  // consumption time via clampDecodeBudgetMs, so a stale persisted value can never leave [5000, 8000].
  decodeBudgetMs: DECODE_BUDGET_DEFAULT_MS,
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  scanContext: "tire", // Phase 9: default to Tires so the category firewall protects from day one (no setup)
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
  autoCountNonPublicWithEvidence: true,
};

const AUTO_SESSION_INACTIVITY_MINUTES = 30;
const RECENT_LOCATIONS_CAP = 8;

export interface ScanState {
  // identity / config
  businessId: string;
  userId: string | null; // signed-in user (Firebase backend); null on the local/mock path
  businessContextReady: boolean; // true once a REAL business context is set (or always on the mock path)
  // Cloud backend: true once loadBusinessData has finished (products/aliases/session/counts in store), so
  // the UI does not let a scan run against an empty catalog before the business's data arrives. Always
  // true on the mock/local path.
  businessDataLoaded: boolean;
  currentSession: InventorySession | null;
  /** Phase 3: refresh-populated cloud session history (Task 7's refreshFromCloud writes it; the
   *  cloud paths of listSessions/reopenSession read it). Always [] on the mock/local path. */
  sessions: InventorySession[];
  sessionId: string;
  settings: Settings;

  // deterministic lookup data (seeded; learned aliases are appended and persisted)
  products: Product[];
  aliases: Alias[];

  // live session data
  scanFeed: ScanEvent[]; // newest first
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  // Task 3.5: rolling snapshots of finalCounts for the variance/shrinkage report. Capped ring buffer
  // (same append-and-slice-oldest pattern as feedbackEvents/appendFeedback), most-recent-last.
  countSnapshots: CountSnapshot[];
  /** Owner feature (2026-07-22): automatically saved history of past scan sessions, newest first.
   *  Written the moment a session ends or rotates away (before scanFeed/finalCounts are wiped) - the
   *  shop owner never has to do anything. Capped ring buffer (see sessionHistory.ts for the caps). */
  sessionHistory: SessionHistoryEntry[];

  // sync
  pendingSyncQueue: PendingSyncItem[];
  syncedScanEventIds: string[];
  online: boolean;
  simulateSyncFailure: boolean;
  lastSyncError: string | null;
  // Transient (not persisted): set when a link to a product was BLOCKED by the human-mistake guard.
  // The UI shows the warning and may re-call resolveUnknown with confirmedMismatch: true to override.
  lastMismatchWarning: { reviewId: string; productId: string; verdict: MismatchVerdict } | null;
  // Transient (not persisted): SELECTED discovered identifiers that could NOT be approved because the
  // clean code already belongs to a DIFFERENT product. Surfaced to the UI; never silently overwritten.
  lastAliasConflicts: { reviewId: string; code: string; existingProductId: string }[] | null;
  // Transient (not persisted): set when a scan was BLOCKED by the category firewall. Drives the
  // non-blocking, dismissible warning banner on the scan page (the item still goes to Needs Review).
  lastCategoryWarning: { code: string; productName: string; reason: string } | null;

  // AI lookup (fallback only, for unknown codes)
  aiLookupLogs: AiLookupLog[];
  breaker: BreakerState;
  aiStatus: AiStatus;

  // shared barcode knowledge (local, offline-first abstraction; a cloud-backed store could replace
  // this later without callers changing, since access always goes through localCatalogProvider.ts)
  catalog: CatalogEntry[]; // GLOBAL verified catalog (sanitized, non-private)
  shopOverrides: ShopOverride[]; // PRIVATE, businessId-scoped; never merged into catalog
  feedbackEvents: FeedbackEvent[]; // PRIVATE local event log (capped ring buffer)

  // most recent junk-cleanup snapshot (enables Undo); persisted so Undo survives a reload
  lastCleanupBackup: CleanupBackup | null;
  // most recent product-delete snapshot (enables Undo); persisted so Undo survives a reload
  lastProductDeleteBackup: ProductDeleteBackup | null;
  // most recent identifier-backfill snapshot (enables in-session Undo of the P2 name-prefix backfill)
  lastIdentifierBackfill: Array<{ productId: string; primaryBarcode: string; upc: string }> | null;

  // hydration guard
  _hasHydrated: boolean;
  // Phase 3: this device's stable identity (localStorage-persisted UUID). Null until first read
  // (e.g. non-browser/test contexts, or before the store has touched deviceIdentity). Used only to
  // derive idempotent auto-session ownership - never part of the count/ledger identity.
  deviceId: string | null;
  /** Phase 3: the location to stamp on the NEXT scan (defaults to the session's location; changing
   *  it does not retroactively edit past scans). */
  location: string;
  /** Phase 3: capped ring buffer of recently-used location strings for this business, newest last -
   *  same append-and-slice-oldest pattern as countSnapshots (scanStore.ts:1289-1309). */
  recentLocations: string[];
  /** P6 C2: ISO timestamp of this business's FIRST counted scan (any path - known, provisional, or
   *  conflict), set exactly once. Null until then. Drives the /scan first-run banner
   *  (scanFeed.length === 0 && firstScanAt === null). Local Zustand-persisted state only (MOCK-BACKEND
   *  rule, review F5) - live-auth mode mirroring this to the business doc is explicitly deferred to a
   *  future task, not built here. Reset to null on business switch / sign-out via emptyTenantState. */
  firstScanAt: string | null;
  /** Task 2 (persist-failure surface, 2026-08-09): non-null once the async coalesced persist wrapper's
   *  onPersistFailure has fired at least once (write/migrate/demoted - see scanPersistStorage.ts).
   *  Latches on the FIRST failure (see setPersistDegraded) so a storm of repeated failures does not
   *  spam re-renders; the kind recorded is always the first one seen. Never cleared automatically -
   *  this reflects "this device's storage has shown a failure this session", not live health. Only the
   *  async/IndexedDB persist path can report this (the plain localStorage-only fallback wrapper has no
   *  onPersistFailure hook), so this stays null forever in SSR/jsdom-without-indexedDB/non-persisted
   *  test stores - that is expected, not a bug. */
  persistDegraded: { kind: "write" | "migrate" | "demoted" } | null;

  // actions
  setHasHydrated: (v: boolean) => void;
  /** Task 2: latch-set persistDegraded on the first onPersistFailure callback; a no-op on later calls
   *  (the flag never un-latches within a session). */
  setPersistDegraded: (kind: "write" | "migrate" | "demoted") => void;
  /** Set the signed-in business context (Firebase backend). Enables cloud sync + drains the queue. */
  setBusinessContext: (businessId: string, userId: string) => void;
  /** Pre-sign-out drain guard (F1): if the pending-sync queue is non-empty, attempt one awaited cloud
   *  drain (wrapped so a network failure cannot throw out of sign-out), then return how many items STILL
   *  could not sync. Returns 0 for an empty queue without touching the drain. The UI uses the count to
   *  decide the honest confirm copy - resetForSignOut itself stays a full, unconditional wipe. */
  prepareSignOut: () => Promise<number>;
  /** Sign-out: wipes tenant state to the anon baseline, clears the selected-business key, removes the
   *  signed-out user's per-uid localStorage key, and re-points persist at the anon key. */
  resetForSignOut: () => void;
  /** Re-point persist at this uid's key and rehydrate (no legacy-blob migration). Returns a promise
   *  that resolves once rehydrate has applied, so callers can await it before reading state. */
  rehydrateForUid: (uid: string) => Promise<void>;
  /** Owner-initiated: migrate the legacy pre-account blob into this uid's key, then rehydrate. */
  adoptLegacyLocalData: (uid: string) => Promise<void>;
  startSession: (name: string, location: string) => void;
  /** Mark the current session completed (status=completed, completedAt set) and persist it. */
  finishSession: () => void;
  /** Owner PIN lock. setOwnerPin/resetOwnerPin manage the single owner PIN (stored as a salted hash);
   *  lockSession freezes a session (requires a PIN to be set); unlockSession verifies the entered PIN. */
  setOwnerPin: (pin: string) => Promise<boolean>;
  resetOwnerPin: () => void;
  verifyOwnerPin: (pin: string) => Promise<boolean>;
  hasOwnerPin: () => boolean;
  lockSession: (sessionId: string) => boolean;
  unlockSession: (sessionId: string, pin: string) => Promise<boolean>;
  /** Browse-and-reopen. listSessions returns every saved session (newest first). reopenSession switches the
   *  active context to a saved session and reloads its counts from the durable store. */
  listSessions: () => InventorySession[];
  reopenSession: (sessionId: string) => boolean;
  /** Idempotent per (account, device, time-window): reuses the current session if it is still
   *  ACTIVE, owned by THIS device, and within the inactivity window; otherwise auto-opens a fresh
   *  auto-named session stamped with this device's id. Safe to call on every mount/scan - a no-op
   *  when a valid session already exists. */
  ensureAutoSession: () => void;
  /** Phase 3 cross-device inbound sync: a manual, one-shot refresh (NOT a live listener - see the
   *  sync scout's Trap C on why a listener wired to a naive replace would violate the TOP-LEVEL LAW).
   *  MERGES additively: products/aliases/sessions upsert by id; finalCounts upsert by
   *  (sessionId,productId) EXCEPT rows this device still has an unsynced pendingSyncQueue entry for,
   *  which are left untouched (a stale remote read must never regress a not-yet-synced local count).
   *  No-op on the mock/local backend. Never touches scanFeed. */
  refreshFromCloud: () => Promise<void>;
  /** Set the location to stamp on subsequent scans, and record it in recentLocations (capped,
   *  deduped, most-recent-last). Empty/whitespace-only input is ignored (never stored). */
  setLocation: (location: string) => void;
  processScan: (rawInput: string) => ScanEvent | null;
  syncPending: (force?: boolean) => void;
  retrySync: () => void;
  setOnline: (online: boolean) => void;
  setSimulateSyncFailure: (on: boolean) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  /** Public entry point: ENQUEUES the decode (see the module-level bounded decode queue) and resolves
   *  once it actually runs. Never call `runLiveDecodeOnce` directly outside this queue - that would
   *  bypass the MAX_CONCURRENT_DECODES bound a rapid scan burst relies on. */
  liveDecode: (reviewId: string, options?: { deterministicOnly?: boolean; invalidationGeneration?: number }) => Promise<void>;
  /** The real decode work (network call + evidence gate + count/needs-review routing). Only ever
   *  invoked FROM the `liveDecode` queue wrapper - see the module-level `enqueueDecode`/`drainDecodeQueue`. */
  runLiveDecodeOnce: (reviewId: string, options?: { deterministicOnly?: boolean; invalidationGeneration?: number }) => Promise<void>;
  /** DECODE-EVERYTHING fallback: when the AI decode is SKIPPED (circuit breaker open / rate-limited / AI
   *  unavailable / offline / cap), still COUNT the scan as an UNVERIFIED, reviewable provisional row with a
   *  SAFE label (never fabricated manufacturer anatomy for non-GS1 codes; never an approved alias / verified
   *  product). Idempotent (no double count). The review stays OPEN so a retry can identify it. */
  applyDecodeFallback: (reviewId: string, reason: string) => void;
  /** Idempotent primitive: count one provisional row for `code` (create it if absent), keyed by an
   *  already-existing scan-feed row. Safe to call any number of times for the same code (never double
   *  counts). Used synchronously by processScan and by applyDecodeFallback. Returns the product id the
   *  code is counted under: the already-counted product on the idempotent-hit path, else the freshly
   *  minted provisional's id. markWrong depends on this return to target the CORRECT provisional when
   *  the marked-wrong product is itself a provisional sharing the same primaryBarcode (Task 9 finding:
   *  an unordered products.find could pick the OLD provisional and inflate the total).
   *  `opts.verifyEventId` (FINDING 2, Codex clean-room review, 2026-08-16): the "already counted for
   *  this code" idempotent shortcut is normally correct - repeat scans/enrichment calls for a code that
   *  is already counted must be a no-op. But the Layer C recovery fallback (processScan's outer catch)
   *  calls this AFTER an unexpected throw, when it cannot trust that ANY existing count for this code
   *  actually includes THIS physical scan's own event - the ledger entry that made the shortcut fire
   *  could be exactly the corrupted/stale record that caused the throw in the first place. When
   *  `verifyEventId` is set, the shortcut only fires if that id is actually present in the matched
   *  product's ledger row; otherwise this call force-counts the scan against the SAME product (never
   *  minting a duplicate product row for a code that already has one). */
  ensureProvisionalCount: (
    code: string,
    reason: string,
    opts?: { freshTransferKeys?: boolean; countIfFeedMissing?: boolean; verifyEventId?: string },
  ) => string;
  /** F5 bundle-surgery (wave 2, 2026-07-20): fire-and-forget enrichment for a provisional row's bare
   *  "Unidentified item (...)" label. Called AFTER the row already appears + counts (never before -
   *  TOP-LEVEL LAW is unaffected). Fetches /api/prefix-floor for the DERIVED-tier (2.3MB corpus) brand
   *  the client-safe SEED/LEARNED lookup couldn't see, and upgrades the row's name/brand ONLY if the
   *  row still carries the exact bare fallback label for this code (never clobbers a decoded name, an
   *  already-resolved prefix-floor name, or a human edit that happened while the fetch was in flight).
   *  Offline/failed fetch/no-hit = silent no-op, never an error, never a re-throw. */
  enrichPrefixFloorLabel: (code: string, productId: string) => void;
  /** Flip every not-yet-resolved scan-feed row for `cleanCode` to the "verified" decode badge (shared by
   *  the 4 auto-verify / catalog-hit sites so their badge-flip guard cannot drift). A row already counted
   *  synchronously is status "known" (not "resolved"), so it is still flipped; a row already "verified" or
   *  "resolved" is left untouched. `reason` overrides the row reason when non-empty, else keeps the row's.
   *  P5 Task 5: `provenance` is optional and additive - only the runLiveDecodeOnce call site (which has a
   *  DecodeDecision in scope) passes "app_verified"; the other call sites (global-catalog hit, etc.) omit
   *  it and the row's provenance is simply left unset (badge falls back to the plain "Verified" label). */
  markFeedRowVerified: (cleanCode: string, reason: string, provenance?: ScanEvent["provenance"]) => void;
  /** Tasks 5+6: client-orchestrated background verify. After a tire scan's fast decode lands as
   *  suggested/needs_review, fire ONE `mode:"decode-deep"` request WITH `scanContext:"tire"` (the
   *  page-fetch verify gate cannot fire without it). On a `verified` decideDecode result, route it
   *  through the EXISTING verified-decode handling (count + alias) using the scan's existing review,
   *  so a late/duplicate response can never double-count (the open-status guard makes it idempotent).
   *  A non-verified deep result never counts; it may only refresh the review suggestion. */
  backgroundVerifyDeep: (reviewId: string) => Promise<void>;
  /** Option 1 wiring: async cloud global catalog lookup on an in-memory-catalog miss.
   *  Awaits deps.lookupGlobalCatalog, applies the Phase-8C firewall, merges a verified hit into
   *  the in-memory catalog, records "found_from_catalog" feedback, and resolves via resolveUnknown.
   *  Falls through to AI on a miss, pending entry, firewall conflict, or dep absence. Fire-and-forget. */
  cloudCatalogResolve: (reviewId: string, codes: string[]) => Promise<void>;
  setAiStatus: (partial: Partial<AiStatus>) => void;
  refreshAiStatus: () => Promise<void>;
  setEmergencyStop: (on: boolean) => void;
  resolveUnknown: (
    reviewId: string,
    action: "link_existing" | "create_new" | "ignore",
    payload: {
      productId?: string;
      newProduct?: Partial<Product>;
      applyToCount?: boolean;
      // "tenant_approval" = a tenant's own human confirmation (feed-row Approve / typed identity): same
      // trust as "human" for THAT tenant's product + alias, but never writes the device-shared verified
      // catalog (platform/app-verified knowledge stays separate from tenant knowledge).
      origin?: "human" | "tenant_approval" | "ai" | "catalog" | "auto_verify" | "auto_count";
      autoVerify?: {
        score: number;
        verifiedBy: CatalogVerifiedBy;
        sourceTier: CatalogSourceTier;
        reason: string;
        evidenceSummary: string;
        sourceUrls: string[];
      };
      /** Owner override: proceed with a link the mismatch guard flagged high-risk (audited). */
      confirmedMismatch?: boolean;
      /** Codes the human explicitly selected from the discovered identifiers to approve as aliases (W2). */
      selectedAliasCodes?: string[];
    },
  ) => void;
  /** Build 3: batch-approve the Suggested pile. Groups `reviewIds` into slices of 25 (readability/per-row
   *  containment only - no per-chunk commit, no state isolation between chunks, one synchronous pass) and
   *  calls the EXACT same path as the single-row "Approve suggestion" button (resolveUnknown "create_new",
   *  applyToCount: true, NO origin field, newProduct built from the review's suggested* fields,
   *  selectedAliasCodes = every discovered identifier) for each id - no new approval semantics, no change
   *  to the trust/poison-guard rules, idempotency is resolveUnknown's own open-status guard. A row that
   *  throws, has no open suggestion, or is already resolved/ignored is recorded and the loop continues; it
   *  never aborts the rest of the batch. */
  batchApprove: (reviewIds: string[]) => { approved: string[]; failed: Array<{ id: string; reason: string }> };
  /** Task 9b (owner-ratified 2026-07-14): approve the feed row's PENDING inline suggestion. Routes
   *  through the EXISTING human-approval core (batchApprove -> resolveUnknown "create_new"), so the
   *  idempotency-keyed alias write, poison guard, dedup guard, and provisional upgrade are inherited,
   *  never re-implemented. No-op unless the row's suggestion.status is "pending" (double-tap safe). */
  approveSuggestion: (scanEventId: string) => void;
  /** Best-guess identity (owner decision 2026-08-19): confirm a HUMAN-TYPED identity for a feed row
   *  (the "Identify" / "Edit" confirm sheet). Thin wrapper: it locates the row's still-awaiting review
   *  (open or parked-suggested, creating one when the row has none) and hands the typed fields to the
   *  EXISTING human-approval core, resolveUnknown "create_new" - so the tenant approved alias, count
   *  upgrade, and idempotency come from that one path and are never re-implemented here. Writes tenant
   *  data only: no corpus, no learned tier, no shared cache. No-op on an empty name or a row whose
   *  suggestion is already settled (double-tap safe). */
  confirmRowIdentity: (scanEventId: string, fields: { name: string; brand?: string; category?: string }) => void;
  /** Task 9b: decline the feed row's PENDING inline suggestion ("Not this product"). Renames the
   *  counted provisional row to the prefix floor (or the safe Unidentified placeholder) FIRST, and
   *  ONLY THEN creates/reopens the OPEN Needs Review item (decline is now the only suggestion path
   *  that creates one). No-op unless suggestion.status is "pending" (double-tap safe). */
  declineSuggestion: (scanEventId: string) => void;
  /** Evaluate (without committing) whether linking a review's code to a product looks like a mistake. */
  evaluateLinkMismatch: (reviewId: string, productId: string) => MismatchVerdict | null;
  /** Clear a pending mismatch warning (e.g. the user cancelled the risky link). */
  clearMismatchWarning: () => void;
  clearAliasConflicts: () => void;
  /** Clear the category-firewall warning banner (user dismissed it or switched category). */
  clearCategoryWarning: () => void;
  /** Approve DISCOVERED (grounded, unapproved) identifiers as aliases for a product so scanning any of
   *  them resolves to it. Conflict-safe (a code approved for a DIFFERENT product is skipped + surfaced);
   *  idempotent (re-approving an already-approved code is a no-op). Never invents a code. */
  approveDiscoveredIdentifiers: (productId: string, cleanCodes: string[]) => void;
  /** Repair a bad alias: unlink it (stops resolving; soft delete, scan history kept). Audited. */
  unlinkAlias: (aliasId: string) => void;
  /** Repair a bad alias: move it to the correct product. Audited. */
  moveAlias: (aliasId: string, toProductId: string) => void;
  /** Phase 6: remove a product's count from the current session only (keeps product + aliases). Audited. */
  removeFromCount: (productId: string) => void;
  /** Phase 6: edit safe product fields (name/brand/category/specs/sku/image/location/unit cost). No alias trust change. */
  correctProduct: (
    productId: string,
    fields: Partial<Pick<Product, "name" | "brand" | "category" | "specsShort" | "specsFull" | "primarySku" | "imageUrl" | "location" | "unitCost">>,
  ) => void;
  /** Phase 6: mark a counted product wrong - deactivate its scanned-code aliases, remove the session count,
   *  reopen Needs Review for the code, and request a correction recheck. Returns the reopened review id. */
  markWrong: (productId: string, opts?: { reason?: string }) => Promise<string | null>;
  /** Phase 6: reopen (or create) an OPEN Needs Review item for a clean code; clears stale suggestions.
   *  Phase 4: an optional importContext carries the import row's quantity + suggestion so an import-origin
   *  review is fully staged (never live-decoded - Phase 4 makes zero /api/ai-lookup calls). */
  reopenNeedsReview: (cleanCode: string, reason: string, importContext?: ImportReviewContext) => string | null;
  /** Phase 4 Task 10: resolve a universal-import preview into store writes. Exact rows resolve via the
   *  human-origin create path (approved) and may auto-count; every non-exact/unmatched row is staged as
   *  Needs Review carrying its quantity and never auto-counts. Duplicate cleanCodes across rows are
   *  aggregated BEFORE any review/count is created so each unique code yields exactly one review/count
   *  carrying the TOTAL quantity (C5). The only write path for a universal import - preview/mapping/match
   *  stay read-only until this is called. */
  applyUniversalImport: (rows: ImportPreviewRow[]) => UniversalImportApplySummary;
  /** Phase 6: correction-only decode recheck. Cost-guarded (one per code unless retry). Never auto-saves. */
  correctionRecheck: (reviewId: string, opts?: { retry?: boolean; reason?: string }) => Promise<void>;
  /** Append a private feedback/event-log entry (the "smarter over time" substrate). */
  recordFeedback: (
    type: FeedbackEventType,
    payload: { code: string; productId?: string | null; meta?: Record<string, string | number | boolean> },
  ) => void;
  /** Task 3.5: capture the CURRENT finalCounts as a labeled CountSnapshot for the variance/shrinkage
   *  report. Prepends to countSnapshots (capped at 12, oldest evicted) and returns the created snapshot. */
  snapshotCount: (label: string) => CountSnapshot;
  /** Import products + approved aliases from CSV text (MVP). Writes via the durable queue + audits. */
  importProductsCsv: (text: string) => CsvImportSummary;
  /** Audit a CSV export (called by the export UI). Fire-and-forget; never blocks. */
  auditCsvExport: (kind: string, rowCount: number, format?: string) => void;
  pendingCount: () => number;
  getProduct: (id: string | null) => Product | undefined;
  clearSession: () => void;
  /** Dev/recovery action: wipe persisted + mock-backend state and reload clean seed data. */
  clearLocalCache: () => void;
  /** Remove the owner-selected recommended count rows (+ orphaned products/aliases). Snapshots for Undo. */
  applyCleanupSelections: (selectedCountIds: string[]) => { removed: number; backup: CleanupBackup | null };
  /** Convenience: apply all high-confidence (default-checked) recommendations. */
  cleanupJunkCounts: () => { removed: number; backup: CleanupBackup | null };
  /** Restore the rows removed by the most recent cleanup (additively, no data loss). */
  undoCleanup: () => boolean;
  /** Delete a saved product: archive it (status archived + verified false so the resolver stops matching),
   *  deactivate ALL its aliases, remove its count rows, detach its scan-feed rows, and drop catalog/
   *  shop-override entries keyed to its codes. Reversible (snapshots for Undo) + audited. The freed code
   *  re-decodes/Needs-Review on the next scan. Returns the backup, or null if the product is unknown. */
  deleteProduct: (productId: string) => ProductDeleteBackup | null;
  /** One-time safe purge of poisoned duplicates (e.g. the 235 "Manstel" rows on 745125495781 and any
   *  non-protected product whose identity is the poison code). Reversible via the same Undo. Returns count. */
  purgePoisonedProducts: () => { removed: number; backup: ProductDeleteBackup | null };
  /** Restore the product(s) removed by the most recent delete/purge (exact restore). */
  undoDeleteProduct: () => boolean;
  /** P2 maintenance (platform, NOT auto-run): dry-run preview of products whose identifier fields are empty
   *  but whose NAME starts with "UPC <code> - " - the code that would backfill primaryBarcode/upc. */
  previewIdentifierBackfill: () => Array<{ productId: string; name: string; code: string }>;
  /** Fill empty primaryBarcode (+ upc for 12-digit) from the name prefix for the given products. Snapshots
   *  the prior values for Undo. Reversible, audited, never auto-run. Returns how many products changed. */
  applyIdentifierBackfill: (productIds: string[]) => { changed: number };
  /** Restore the identifier fields changed by the most recent backfill. */
  undoIdentifierBackfill: () => boolean;
}

/** Phase 3: stamp the current location + deviceId onto a freshly-built ScanEvent. Applied uniformly
 *  to every fresh ScanEvent literal inside processScan. Spread-built events inherit the stamp from
 *  their base; the markWrong residual literal outside processScan is deliberately unstamped. Pure -
 *  takes the values, does not read the store itself. */
// Stamp Phase 3 attribution onto a fresh ScanEvent. Concrete (not generic) so an inline object
// literal is type-checked against the full ScanEvent shape, not just the two stamped fields.
function stampScanEventLocation(
  event: ScanEvent,
  location: string,
  deviceId: string | null,
): ScanEvent {
  return { ...event, location, deviceId: deviceId ?? undefined };
}

function makeQueueItem(params: {
  idFactory: () => string;
  now: () => string;
  businessId: string;
  sessionId: string;
  entityType: PendingSyncItem["entityType"];
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  idempotencyKey: string;
  scanEventId: string | null;
}): PendingSyncItem {
  return {
    id: params.idFactory(),
    businessId: params.businessId,
    sessionId: params.sessionId,
    entityType: params.entityType,
    entityId: params.entityId,
    operation: params.operation,
    payload: params.payload,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: params.now(),
    updatedAt: params.now(),
    idempotencyKey: params.idempotencyKey,
    scanEventId: params.scanEventId,
  };
}

// D3 FIX (shared by ALL THREE orphan-transfer sites: runLiveDecodeOnce's fast-decode auto-link merge,
// backgroundVerifyDeep's deep-verify merge, and resolveUnknown's merge): move an orphan placeholder's
// count onto the merge target, UNIONING the anti-double-count ledger fields (scanEventIds / aliasesSeen /
// appliedIdempotencyKeys) so orphan history survives the merge and a replayed event id stays a no-op.
// Deduped unions keep a repeated merge idempotent. Pure: returns a new array, never mutates. A null
// targetId (or a zero-quantity orphan) just drops the orphan row - identical to each site's old behavior.
// SESSION-SCOPED (root-cause fix 2026-07-22): refreshFromCloud's additive cross-session merge can
// leave finalCounts holding rows for the SAME productId from a DIFFERENT session. Matching the
// target by productId alone (the old behavior) could pour the orphan's quantity onto a foreign
// session's row - which the session-filtered counts table then hides, deflating the visible total
// (the feed-124/counts-122 class). Each orphan row now merges only into a target row of ITS OWN
// session, mirroring incrementInventoryCount's (productId, sessionId) scoping. Exported for tests.
export function transferOrphanCount(
  finalCounts: InventoryCount[],
  oid: string,
  targetId: string | null,
  nowIso: string,
): InventoryCount[] {
  const orphanRows = finalCounts.filter((c) => c.productId === oid);
  let next = finalCounts.filter((c) => c.productId !== oid);
  if (!targetId) return next; // no merge target: drop (identical to each call site's old behavior)
  for (const orphanRow of orphanRows) {
    if (orphanRow.quantity <= 0) continue;
    const targetRow = next.find((c) => c.productId === targetId && c.sessionId === orphanRow.sessionId);
    next = targetRow
      ? next.map((c) =>
          c.productId === targetId && c.sessionId === orphanRow.sessionId
            ? {
                ...c,
                quantity: c.quantity + orphanRow.quantity,
                scanEventIds: Array.from(new Set([...c.scanEventIds, ...orphanRow.scanEventIds])),
                aliasesSeen: Array.from(new Set([...c.aliasesSeen, ...orphanRow.aliasesSeen])),
                appliedIdempotencyKeys: Array.from(new Set([...c.appliedIdempotencyKeys, ...orphanRow.appliedIdempotencyKeys])),
                updatedAt: nowIso,
              }
            : c,
        )
      : [...next, { ...orphanRow, productId: targetId, updatedAt: nowIso }];
  }
  return next;
}

// F-03 (audit remediation 2026-07-29): transferOrphanCount above is PURE local-state math - it never
// enqueues a sync op, so an orphan merge that mutates finalCounts locally leaves the backend holding
// the old (oid) InventoryCount row forever. The next refreshFromCloud/second-device load re-adds it
// ALONGSIDE the repointed target row, silently doubling the quantity - the same class of bug
// deleteProductsInternal's "SYNC THE REPOINT" fix (reviewed defect 2026-07-22, ~:6809) already closed
// for product deletes. Mirror that EXACT balanced-pair pattern here: a zero-out INCREMENT_COUNT on the
// orphan's identity plus a re-add INCREMENT_COUNT on the target's identity, per affected session row,
// both using FRESH per-transfer idempotency keys (never the original counting key) so the Firestore
// applied-key dedupe cannot reject the corrected write as an idempotency_conflict (the FirebaseSyncTarget
// marker's targetId is derived from the payload's own productId, so reusing an old counting key that was
// stamped against a different productId's marker collides). Called by every transferOrphanCount call
// site with the counts snapshot from BEFORE the transfer (so the moved quantity/session/count-id are
// still visible), immediately followed by transferOrphanCount itself for the local state update. The
// affected ScanEvents are also durably re-pointed with fresh SAVE_SCAN_EVENT keys: a cloud reload must
// not retain their former identity even though the count pair itself has already balanced quantity.
// Rotation-side finalCounts prune (bug #34 residual, read-side counterpart to the pendingSyncQueue
// data-loss fix - see sessionRotationSyncSafety.store.test.ts). Rotation must drop ONLY the
// just-abandoned session's own finalCounts rows (superseded by the sessionHistory archive captured
// synchronously by archiveCurrentSessionIfAny just before this runs), never OTHER past sessions'
// rows a prior refreshFromCloud already merged into this array. A blanket `finalCounts: []` wipes
// those unrelated rows too, disabling/emptying the History page's CSV download for sessions that
// had nothing to do with this rotation until the next refreshFromCloud re-fetches them.
function pruneFinalCountsForRotation(
  finalCounts: InventoryCount[],
  abandonedSessionId: string | null | undefined,
): InventoryCount[] {
  if (!abandonedSessionId) return finalCounts;
  return finalCounts.filter((c) => c.sessionId !== abandonedSessionId);
}

function buildOrphanTransferSyncOps(params: {
  finalCountsBeforeTransfer: InventoryCount[];
  scanFeedBeforeTransfer: ScanEvent[];
  oid: string;
  targetId: string;
  businessId: string;
  idFactory: () => string;
  now: () => string;
}): PendingSyncItem[] {
  const { finalCountsBeforeTransfer, scanFeedBeforeTransfer, oid, targetId, businessId, idFactory, now } = params;
  const ops: PendingSyncItem[] = [];
  for (const c of finalCountsBeforeTransfer) {
    if (c.productId !== oid || c.quantity <= 0) continue;
    const outKey = buildIdempotencyKey(businessId, c.sessionId, `${c.id}:orphan-transfer-out`, "INCREMENT_COUNT");
    const outPayload: IncrementPayload = {
      businessId,
      sessionId: c.sessionId,
      productId: oid,
      scanEventId: `${c.id}:orphan-transfer`,
      quantityDelta: -c.quantity,
      idempotencyKey: outKey,
    };
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
    );
    const inKey = buildIdempotencyKey(businessId, c.sessionId, `${c.id}:orphan-transfer-in`, "INCREMENT_COUNT");
    const inPayload: IncrementPayload = {
      businessId,
      sessionId: c.sessionId,
      productId: targetId,
      scanEventId: `${c.id}:orphan-transfer`,
      quantityDelta: c.quantity,
      idempotencyKey: inKey,
    };
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
    );
  }
  for (const event of scanFeedBeforeTransfer) {
    if (event.matchedProductId !== oid) continue;
    const repointedEvent: ScanEvent = { ...event, matchedProductId: targetId };
    const saveKey = buildIdempotencyKey(
      businessId,
      event.sessionId,
      `${event.id}:orphan-transfer:${targetId}`,
      "SAVE_SCAN_EVENT",
    );
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: event.sessionId, entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: repointedEvent, idempotencyKey: saveKey, scanEventId: event.id }),
    );
  }
  return ops;
}

/**
 * Multi-code: build an APPROVED alias for every OTHER scannable code on a product (part number / SKU /
 * GTIN / UPC / EAN / vendor codes), beyond the code(s) already aliased. This is what makes a tire's
 * barcode AND its part-number QR both resolve to the same product. Pure builder; caller commits to state.
 */
function buildProductCodeAliases(params: {
  product: Product;
  alreadyAliasedCleanCodes: string[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
}): { aliases: Alias[]; queued: PendingSyncItem[] } {
  const { product, alreadyAliasedCleanCodes, businessId, sessionId, idFactory, now } = params;
  const rawCodes = [
    product.primaryBarcode,
    product.primarySku,
    product.gtin,
    product.upc,
    product.ean,
    ...(product.vendorCodes ?? []),
  ];
  const seen = new Set(alreadyAliasedCleanCodes.filter(Boolean));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  for (const code of rawCodes) {
    if (!code) continue;
    const n = normalizeCode(code);
    const cleanCode = n.clean;
    if (!cleanCode || seen.has(cleanCode)) continue;
    seen.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: code,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: product.source ?? "human_review",
      confidence: 1,
      approved: true,
      createdAt: now(),
      updatedAt: now(),
      createdBy: "multi_code",
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued };
}

/**
 * W2: build APPROVED aliases for an EXPLICIT list of human-selected discovered identifier codes, onto a
 * target product (new or existing). Dedupes against codes already aliased for that product (idempotent),
 * and NEVER overwrites a code that is an approved alias of a DIFFERENT product - those are returned as
 * conflicts for the caller to surface. Pure builder; caller commits to state.
 */
function buildAliasesForCodes(params: {
  product: Product;
  codes: string[];
  existingAliases: Alias[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
  approved?: boolean; // default true; pass false to persist a DISCOVERED (un-trusted) alias suggestion
  source?: Alias["source"];
  createdBy?: string;
}): { aliases: Alias[]; queued: PendingSyncItem[]; conflicts: { code: string; otherProductId: string }[] } {
  const { product, codes, existingAliases, businessId, sessionId, idFactory, now } = params;
  const approved = params.approved ?? true;
  const aliasSource = params.source ?? "human_review";
  const aliasCreatedBy = params.createdBy ?? "human";
  const ownCleanCodes = new Set(existingAliases.filter((a) => a.productId === product.id).map((a) => a.cleanCode));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  const conflicts: { code: string; otherProductId: string }[] = [];
  for (const raw of codes) {
    if (!raw) continue;
    const n = normalizeCode(raw);
    const cleanCode = n.clean;
    if (!cleanCode) continue;
    if (ownCleanCodes.has(cleanCode)) continue; // already aliased to THIS product -> idempotent skip
    const other = existingAliases.find((a) => a.cleanCode === cleanCode && a.productId !== product.id && a.approved);
    if (other) {
      conflicts.push({ code: cleanCode, otherProductId: other.productId });
      continue; // belongs to a DIFFERENT product -> never overwrite
    }
    ownCleanCodes.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: raw,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: aliasSource,
      confidence: 1,
      approved,
      createdAt: now(),
      updatedAt: now(),
      createdBy: aliasCreatedBy,
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued, conflicts };
}

/** Recompute syncStatus on feed/counts/reviews from what remains in the pending queue. */
function recomputeSyncStatus(state: {
  businessId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  pendingSyncQueue: PendingSyncItem[];
}) {
  const tenantQueue = state.pendingSyncQueue.filter((item) => item.businessId === state.businessId);
  const pendingEventIds = new Set(
    tenantQueue.map((p) => p.scanEventId).filter((x): x is string => !!x),
  );
  const erroredEventIds = new Set(
    tenantQueue
      .filter((p) => p.status === "error" || p.status === "quarantined")
      .map((p) => p.scanEventId)
      .filter((x): x is string => !!x),
  );
  const pendingProductIds = new Set(
    tenantQueue
      .filter((p) => p.operation === "INCREMENT_COUNT")
      .map((p) => (p.payload as IncrementPayload).productId),
  );

  const statusFor = (eventId: string): ScanEvent["syncStatus"] =>
    pendingEventIds.has(eventId) ? (erroredEventIds.has(eventId) ? "error" : "pending") : "synced";

  return {
    scanFeed: state.scanFeed.map((e) => ({ ...e, syncStatus: statusFor(e.id) })),
    finalCounts: state.finalCounts.map((c) => ({
      ...c,
      syncStatus: pendingProductIds.has(c.productId) ? ("pending" as const) : ("synced" as const),
    })),
    needsReviewQueue: state.needsReviewQueue.map((r) => ({
      ...r,
      syncStatus: pendingEventIds.has(idForReview(r)) ? ("pending" as const) : ("synced" as const),
    })),
  };
}

// reviews are keyed to their originating scan event via idempotencyKey's event segment;
// we stash the scanEventId on the review's idempotencyKey, so derive it back here.
function idForReview(r: UnknownCodeReview): string {
  const parts = (r.idempotencyKey ?? "").split(":");
  return parts[2] ?? r.id;
}

function mergeReloadedProductsAndAliases(params: {
  businessId: string;
  localProducts: Product[];
  remoteProducts: Product[];
  localAliases: Alias[];
  remoteAliases: Alias[];
  pendingSyncQueue: PendingSyncItem[];
}): { products: Product[]; aliases: Alias[] } {
  const tenantPendingQueue = params.pendingSyncQueue.filter((it) => it.businessId === params.businessId);
  const pendingProductIds = new Set(
    tenantPendingQueue.filter((it) => it.operation === "SAVE_PRODUCT").map((it) => it.entityId),
  );
  const pendingAliasIds = new Set(
    tenantPendingQueue.filter((it) => it.operation === "RESOLVE_ALIAS").map((it) => it.entityId),
  );

  const productsById = new Map(params.localProducts.map((p) => [p.id, p]));
  for (const remote of params.remoteProducts) {
    const local = productsById.get(remote.id);
    if (pendingProductIds.has(remote.id)) continue;
    if (local?.status === "archived" && remote.status !== "archived") continue;
    productsById.set(remote.id, remote);
  }

  const aliasesById = new Map(params.localAliases.map((a) => [a.id, a]));
  for (const remote of params.remoteAliases) {
    if (pendingAliasIds.has(remote.id)) continue;
    aliasesById.set(remote.id, remote);
  }

  return {
    products: [...productsById.values()],
    aliases: [...aliasesById.values()],
  };
}

// The ONE prefix-rewrite rule for every idempotencyKey-shaped string in this store: rewrite only the
// leading businessId segment (buildIdempotencyKey joins businessId:sessionId:...:operation with ":"),
// leaving every other segment byte-identical so retries of the exact same event keep deduping against
// the same identity. Hoisted (F-5, 2026-08-09) so rescopePlaceholderRecord and rescopePlaceholderQueueItem
// share the exact same rewrite - never duplicate this logic at a new call site.
const PLACEHOLDER_ID_PREFIX = `${DEMO_BUSINESS_ID}:`;
function rescopeKey(key: string, realBusinessId: string): string {
  return key.startsWith(PLACEHOLDER_ID_PREFIX) ? realBusinessId + key.slice(DEMO_BUSINESS_ID.length) : key;
}

// Fix #41 (data-loss race, 2026-08-06): re-point a placeholder-scoped record onto the real business
// once sign-in bootstrap resolves. Used by setBusinessContext's bootstrap-resolution branch below.
// F-5 class closure (2026-08-09): businessId was the only field rewritten here, but several entities
// also embed businessId-derived identity strings that stayed stale - ScanEvent/UnknownCodeReview/
// Alias.idempotencyKey and InventoryCount.appliedIdempotencyKeys[]. Several existing enqueue sites
// (~1792, 5341, 5361, 7137, 7519, 7683) rebuild a queue item straight from an entity's OWN stored
// idempotencyKey, and server-side reconciliation compares appliedIdempotencyKeys against _appliedKeys -
// either path would mis-dedupe (or permanently reject) if the entity's own embedded key still pointed
// at the placeholder tenant while the queue item's copy of the same key had already been rescoped.
// Generic over any embedded idempotencyKey-shaped field so every rescoped collection gets the same
// treatment from one place. Never regenerates a key: only the leading businessId segment changes.
function rescopePlaceholderRecord<T extends { businessId: string }>(entity: T, realBusinessId: string): T {
  if (entity.businessId !== DEMO_BUSINESS_ID) return entity;
  const next: T = { ...entity, businessId: realBusinessId };
  const record = next as unknown as Record<string, unknown>;
  if (typeof record.idempotencyKey === "string") {
    record.idempotencyKey = rescopeKey(record.idempotencyKey, realBusinessId);
  }
  if (Array.isArray(record.appliedIdempotencyKeys)) {
    record.appliedIdempotencyKeys = (record.appliedIdempotencyKeys as unknown[]).map((k) =>
      typeof k === "string" ? rescopeKey(k, realBusinessId) : k,
    );
  }
  return next;
}

// Same idea for a queued sync item: rewrite its own businessId, its payload's businessId (if the
// payload shape carries one), and the leading businessId segment of its idempotencyKey, reusing the
// exact same rescopeKey rewrite rescopePlaceholderRecord uses above.
// Bug fix (proven live 2026-08-09): some payload shapes (IncrementPayload for INCREMENT_COUNT,
// UnknownCodeReview for SAVE_UNKNOWN_SCAN) ALSO embed their own copy of idempotencyKey, which must
// stay byte-identical to the outer (queue item) idempotencyKey - firebaseSyncSafety.validatePendingSyncItem
// hard-rejects a mismatch as payload_idempotency_mismatch. Only the outer key was rewritten here
// before; the embedded copy kept the stale placeholder business prefix forever, so every rescoped
// INCREMENT_COUNT item was permanently rejected by the server and never synced. Rescope the embedded
// key with the exact same prefix-rewrite rule as the outer key so outer === payload after adoption.
function rescopePlaceholderQueueItem(item: PendingSyncItem, realBusinessId: string): PendingSyncItem {
  if (item.businessId !== DEMO_BUSINESS_ID) return item;
  const payload = item.payload;
  const rescopedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (() => {
          const record = payload as Record<string, unknown>;
          const next: Record<string, unknown> = { ...record };
          if ("businessId" in record) next.businessId = realBusinessId;
          if (typeof record.idempotencyKey === "string") next.idempotencyKey = rescopeKey(record.idempotencyKey, realBusinessId);
          if (Array.isArray(record.appliedIdempotencyKeys)) {
            next.appliedIdempotencyKeys = (record.appliedIdempotencyKeys as unknown[]).map((k) =>
              typeof k === "string" ? rescopeKey(k, realBusinessId) : k,
            );
          }
          return next;
        })()
      : payload;
  const idempotencyKey = rescopeKey(item.idempotencyKey, realBusinessId);
  return { ...item, businessId: realBusinessId, payload: rescopedPayload, idempotencyKey };
}

// ADOPTION RE-SYNC (verified live on the Firebase emulator, 2026-08-09 - proof in
// e2e/proof/adopt-emulator-spotcheck/): the pre-auth cohort's anonymous session ran against the MOCK
// backend, which marks every local write "synced" the instant it is applied and leaves
// pendingSyncQueue EMPTY. When that blob is adopted into a signed-in LIVE Firebase account, the
// bootstrap-resolution branch below re-scopes the rows correctly but there is nothing left in the
// queue to re-scope, so the real cloud sync engine never pushes the adopted rows: local total 4,
// Firestore holds only the 1 post-sign-in scan, and the UI honestly reports "All saved: 0". A silent
// local-vs-cloud divergence.
//
// So adoption must REBUILD the sync work those adopted entities would have enqueued had they been
// scanned under the live tenant. Two rules make this safe:
//  1. Reuse each entity's OWN (already-rescoped) idempotencyKey - never regenerate one. Server-side
//     `_appliedKeys` dedupe then swallows anything that genuinely HAD reached THIS backend before, so
//     re-enqueueing can never double-count. Re-sending is idempotent BY DESIGN; not re-sending is
//     unrecoverable data loss.
//  2. Skip any key already present in the queue, so the ordinary fix-#41 shape (nothing drained yet,
//     every write still queued under the placeholder) only gets re-scoped, never duplicated.
// The rebuilt set mirrors exactly what the live scan path enqueues: SAVE_SCAN_EVENT + INCREMENT_COUNT
// per counted event (processScan ~3147-3170), SAVE_UNKNOWN_SCAN per open review, and the provisional
// SAVE_PRODUCT that ensureProvisionalCount mints (~5467). Catalog/seed products and sessions are NOT
// pushed - a live scan of a known catalog product does not push the product either.
function buildAdoptionResyncItems(params: {
  businessId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  products: Product[];
  existingQueue: PendingSyncItem[];
  adoptedEventIds: Set<string>;
  adoptedReviewIds: Set<string>;
  idFactory: () => string;
  now: () => string;
}): PendingSyncItem[] {
  const { businessId, idFactory, now } = params;
  const seenKeys = new Set(params.existingQueue.map((item) => item.idempotencyKey));
  const items: PendingSyncItem[] = [];
  const push = (item: PendingSyncItem) => {
    if (seenKeys.has(item.idempotencyKey)) return;
    seenKeys.add(item.idempotencyKey);
    items.push(item);
  };
  const provisionalById = new Map(
    params.products.filter((p) => p.provisional === true).map((p) => [p.id, p]),
  );
  const pushedProductIds = new Set<string>();

  for (const event of params.scanFeed) {
    if (!params.adoptedEventIds.has(event.id) || !event.idempotencyKey) continue;
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: event.sessionId,
        entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
        // Deterministic reconstruction of the key the scan path mints for this same event id
        // (buildIdempotencyKey(businessId, sessionId, eventId, "SAVE_SCAN_EVENT")). SAVE_SCAN_EVENT is
        // an upsert-by-id with no counting semantics, so even a key that differs from the original
        // (e.g. a `:transfer:`-suffixed one) can only rewrite the same document, never add a count.
        idempotencyKey: buildIdempotencyKey(businessId, event.sessionId, event.id, "SAVE_SCAN_EVENT"),
        scanEventId: event.id,
      }),
    );
    const productId = event.matchedProductId;
    if (!productId || event.quantityDelta <= 0) continue;
    const count = params.finalCounts.find(
      (c) => c.productId === productId && c.sessionId === event.sessionId,
    );
    if (!count) continue;
    const provisional = provisionalById.get(productId);
    if (provisional && !pushedProductIds.has(productId)) {
      pushedProductIds.add(productId);
      push(
        makeQueueItem({
          idFactory, now, businessId, sessionId: event.sessionId,
          entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: provisional,
          idempotencyKey: buildIdempotencyKey(businessId, event.sessionId, `${productId}:provisional`, "SAVE_PRODUCT"),
          scanEventId: null,
        }),
      );
    }
    const incPayload: IncrementPayload = {
      businessId,
      sessionId: event.sessionId,
      productId,
      scanEventId: event.id,
      quantityDelta: event.quantityDelta,
      // The event's OWN counting key, verbatim (its INCREMENT_COUNT identity since it was minted).
      idempotencyKey: event.idempotencyKey,
    };
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: event.sessionId,
        entityType: "InventoryCount", entityId: count.id, operation: "INCREMENT_COUNT", payload: incPayload,
        idempotencyKey: event.idempotencyKey, scanEventId: event.id,
      }),
    );
  }

  for (const review of params.needsReviewQueue) {
    if (!params.adoptedReviewIds.has(review.id) || !review.idempotencyKey) continue;
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: review.sessionId,
        entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: review,
        idempotencyKey: review.idempotencyKey, scanEventId: null,
      }),
    );
  }

  return items;
}

export function buildScanInitializer(deps: ScanStoreDeps) {
  const { db, idFactory, now } = deps;
  const cloudBackend = deps.cloudBackend ?? false;
  const trustedExactProbeEnabled = deps.trustedExactProbeEnabled ?? cloudBackend;

  return (
    set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
    get: () => ScanState,
  ): ScanState => {
    const seed = getSeed();
    // Per-store, non-persisted marker for the narrow deterministic-only request. A rapid repeat can
    // then distinguish its own trusted-exact lookup from an ordinary AI decode that happens to share
    // the same provisional row/review shape.
    const trustedExactProbeReviewIds = new Set<string>();
    // A trusted-exact probe is deliberately NOT a review until it misses. Keeping its minimal context
    // outside Zustand means the navigation badge/table cannot observe a transient open review before an
    // authenticated exact hit settles.
    const trustedExactProbes = new Map<string, UnknownCodeReview>();
    const trustedExactProbeIdsByCode = new Map<string, string>();
    let trustedExactProbeGeneration = 0;
    // TASK T3 fix (2026-08-06, audit-9 finding B): the deterministicOnly probe's reasonCode
    // "trusted_exact_not_available" (server allowlist not configured / this business is not in it)
    // must not be swallowed if the ladder it then continues into also misses. This set remembers
    // (by reviewId, which materializeTrustedExactMiss/the continuation call always reuse - see
    // materializeTrustedExactMiss below) which in-flight reviews had that specific config-gap probe
    // outcome, so the eventual settle site can compose an honest reason instead of the generic
    // "not found anywhere" bucket that a genuinely nonexistent code also produces.
    const trustedExactConfigGapReviewIds = new Set<string>();
    const clearTrustedExactProbes = () => {
      trustedExactProbeGeneration++;
      trustedExactProbeReviewIds.clear();
      trustedExactProbes.clear();
      trustedExactProbeIdsByCode.clear();
      trustedExactConfigGapReviewIds.clear();
    };

    // LAYER B (persist-corruption defect, 2026-08-13): defense in depth for processScan, see its call
    // site. Reuses the same field list + coercion rule as sanitizePersistedScanShape (LAYER A, the
    // persist `merge` sanitizer) but operates on the LIVE store state via get()/set(), so a wrong-shape
    // value that reached state through any path other than rehydration (test setup, a future bug) is
    // still repaired in place before it can throw inside resolveScan/ensureProvisionalCount/etc.
    // Idempotent and cheap when the state is already well-shaped (the overwhelmingly common case): no
    // fields differ, so no set() call happens at all. Returns the names of any field that had to be
    // fixed, for the caller's own log message.
    const sanitizeLiveScanStateShape = (): string[] => {
      const current = get();
      const sanitized = sanitizePersistedScanShape(current as unknown as Record<string, unknown>);
      // Every field the shared shape table knows about (array container, array member, object, or
      // nullable-object) - not just the array-shaped ones - so a wrong-shape `settings`/`currentSession`/
      // `lastCleanupBackup` is repaired here too, not only wrong-shape collections.
      const candidateFields = Object.keys(PERSISTED_FIELD_SHAPES);
      const fixed = candidateFields.filter(
        (field) => (current as unknown as Record<string, unknown>)[field] !== sanitized[field],
      );
      if (fixed.length > 0) {
        set(Object.fromEntries(fixed.map((field) => [field, sanitized[field]])) as Partial<ScanState>);
      }
      return fixed;
    };

    const enqueueAndSync = (items: PendingSyncItem[]) => {
      set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...items] }));
      // Optimistic UI is already updated by the caller; attempt sync afterward.
      get().syncPending();
    };

    // Live decode is tenant-scoped. Mock/E2E mode remains token-free.
    const aiRequestAuth = async (businessId: string): Promise<{ idToken?: string; businessId?: string }> => {
      if (!cloudBackend) return {};
      const user = await getSession();
      if (!user || typeof user.getIdToken !== "function") return {};
      return { idToken: await user.getIdToken(), businessId };
    };

    // The provisional product and scan event are written immediately so counting survives a slow decode.
    // Once a decode enriches either record, persist that newer state too or a refresh would restore the
    // placeholder rather than the identity the scanner just displayed.
    const syncDecodedState = (reviewId: string) => {
      if (!cloudBackend) return;
      const state = get();
      const review = state.needsReviewQueue.find((item) => item.id === reviewId);
      if (!review || !state.businessContextReady || !state.sessionId) return;
      // CLASS FIX (Codex final verdict finding 2, 2026-08-04): a repeat scan of the SAME unknown code
      // while its first scan's decode is still in flight reuses the still-open review (scanStore.ts:
      // 2902-2912) and mints its own SIBLING ScanEvent that shares this review's (sessionId, cleanCode).
      // The local settle further below (the scanFeed.map matching e.cleanCode === review.cleanCode)
      // updates EVERY such row, so persistence must sync ALL of them, not just the first `.find()` hit -
      // otherwise a sibling's decoded status never reaches the backend, and a reload/rehydrate (e.g. the
      // session timeline reading fresh ScanEvents via getScanEventsBySession) resurrects its stale
      // "decoding" badge even though the local count was always correct.
      const events = state.scanFeed.filter(
        (item) => item.sessionId === review.sessionId && item.cleanCode === review.cleanCode,
      );
      const items: PendingSyncItem[] = [];
      const syncedProductIds = new Set<string>();
      for (const event of events) {
        const product = state.products.find((item) => item.id === event.matchedProductId);
        if (!product) continue;
        // One product save per distinct matched product (normally all sibling events share the same
        // provisional/decoded product) - never one duplicate SAVE_PRODUCT per sibling event.
        if (!syncedProductIds.has(product.id)) {
          syncedProductIds.add(product.id);
          const productVersion = JSON.stringify([product.name, product.brand, product.primaryBarcode]);
          items.push(
            makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
              entityType: "Product", entityId: product.id, operation: "SAVE_PRODUCT", payload: product,
              idempotencyKey: buildIdempotencyKey(state.businessId, event.sessionId, `${product.id}:decode:${productVersion}`, "SAVE_PRODUCT"), scanEventId: null,
            }),
          );
        }
        const version = JSON.stringify([event.status, event.decodeStatus, event.reason, product.name, product.brand, product.primaryBarcode]);
        items.push(
          makeQueueItem({
            idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
            entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
            idempotencyKey: buildIdempotencyKey(state.businessId, event.sessionId, `${event.id}:decode:${version}`, "SAVE_SCAN_EVENT"), scanEventId: event.id,
          }),
        );
      }
      if (items.length === 0) return;
      enqueueAndSync(items);
    };

    /**
     * Commit the authenticated trusted-exact result as one local state transition. This path deliberately
     * does not create aliases or write the shared catalog: the opaque server identity is only a coalescing
     * key for exact corpus rows, while every physical scan remains represented by its original event.
     */
    const settleTrustedExactIdentity = (
      reviewId: string,
      canonicalId: string,
      result: Partial<AiLookupResult>,
      reason: string,
    ): boolean => {
      const state = get();
      const review = state.needsReviewQueue.find((item) => item.id === reviewId) ?? trustedExactProbes.get(reviewId);
      if (!review || (review.status !== "open" && review.status !== "suggested")) return false;
      if (review.businessId !== state.businessId || review.sessionId !== state.sessionId) {
        trustedExactProbes.delete(reviewId);
        trustedExactProbeIdsByCode.delete(review.cleanCode);
        trustedExactProbeReviewIds.delete(reviewId);
        return false;
      }
      const transientProbe = trustedExactProbes.has(reviewId);

      const matchingEvent = state.scanFeed.find(
        (event) => event.sessionId === review.sessionId && event.cleanCode === review.cleanCode,
      );
      const provisionalId = review.provisionalProductId ?? matchingEvent?.matchedProductId ?? null;
      if (!provisionalId) return false;
      const provisional = state.products.find((product) => product.id === provisionalId);
      if (!provisional) return false;

      const existingCanonical = state.products.find(
        (product) => product.status !== "archived" && product.trustedExactCanonicalId === canonicalId,
      );
      const target = existingCanonical ?? provisional;
      const targetId = target.id;
      const settledAt = now();
      const reviewKey = buildIdempotencyKey(
        state.businessId,
        review.sessionId,
        `${review.id}:trusted-exact:${canonicalId}`,
        "SAVE_UNKNOWN_SCAN",
      );
      const settledProduct: Product = {
        ...target,
        name: result.productName?.trim() || target.name,
        brand: result.brand?.trim() || target.brand,
        category: result.category?.trim() || target.category,
        specsShort: result.specsShort?.trim() || target.specsShort,
        specsFull: result.specsFull?.trim() || target.specsFull,
        primarySku: result.primarySku?.trim() || target.primarySku,
        primaryBarcode: target.primaryBarcode || result.primaryBarcode?.trim() || review.cleanCode,
        gtin: result.gtin?.trim() || target.gtin,
        upc: result.upc?.trim() || target.upc,
        ean: result.ean?.trim() || target.ean,
        aliases: target.aliases ?? [],
        source: "catalog",
        confidence: 1,
        verified: true,
        provisional: false,
        provenanceTier: "corpus_verified",
        trustedExactCanonicalId: canonicalId,
        updatedAt: settledAt,
        updatedBy: "system:trusted_exact",
      };
      const archivedProvisional: Product | null = provisionalId !== targetId
        ? { ...provisional, status: "archived", updatedAt: settledAt, updatedBy: "system:trusted_exact" }
        : null;

      const isOwnEvent = (event: ScanEvent) =>
        event.sessionId === review.sessionId
        && (event.cleanCode === review.cleanCode || event.matchedProductId === provisionalId);
      const settledEvents = state.scanFeed.map((event): ScanEvent =>
        isOwnEvent(event)
          ? {
              ...event,
              matchedProductId: targetId,
              matchType: "primary_barcode",
              status: "known",
              resolverStatus: "known",
              reason,
              decodeNote: undefined,
              decodeStatus: "verified",
              provenance: "app_verified",
              suggestion: undefined,
              syncStatus: "pending",
            }
          : event,
      );
      const settledReview: UnknownCodeReview = {
        ...review,
        suggestedProductName: settledProduct.name,
        suggestedBrand: settledProduct.brand,
        suggestedCategory: settledProduct.category,
        suggestedSpecsShort: settledProduct.specsShort,
        suggestedSpecsFull: settledProduct.specsFull,
        suggestedPrimarySku: settledProduct.primarySku,
        suggestedPrimaryBarcode: settledProduct.primaryBarcode,
        suggestedGtin: settledProduct.gtin,
        suggestedUpc: settledProduct.upc,
        suggestedEan: settledProduct.ean,
        suggestedAliases: [],
        sourceUrls: [],
        verifiedFacts: [],
        guesses: [],
        reason,
        decodeNote: undefined,
        providerName: "trusted-exact-corpus",
        confidence: 1,
        hasSuggestion: false,
        decodeStatus: "verified",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheckDecision: "single_provider",
        suggestedLinkProductId: undefined,
        status: "resolved",
        resolvedAt: settledAt,
        resolvedBy: "system:trusted_exact",
        resolutionAction: "trusted_exact",
        syncStatus: "pending",
        idempotencyKey: reviewKey,
      };

      let finalCounts = state.finalCounts;
      const transferOps = provisionalId !== targetId
        ? buildOrphanTransferSyncOps({
            finalCountsBeforeTransfer: state.finalCounts,
            scanFeedBeforeTransfer: state.scanFeed.filter(isOwnEvent),
            oid: provisionalId,
            targetId,
            businessId: state.businessId,
            idFactory,
            now,
          })
        : [];
      if (provisionalId !== targetId) {
        finalCounts = transferOrphanCount(finalCounts, provisionalId, targetId, settledAt);
      }

      set((current) => ({
        products: current.products.map((product) => {
          if (product.id === targetId) return settledProduct;
          if (archivedProvisional && product.id === archivedProvisional.id) return archivedProvisional;
          return product;
        }),
        finalCounts,
        scanFeed: settledEvents,
        needsReviewQueue: transientProbe
          ? current.needsReviewQueue
          : current.needsReviewQueue.map((item) => item.id === reviewId ? settledReview : item),
      }));
      if (transientProbe) {
        trustedExactProbes.delete(reviewId);
        trustedExactProbeIdsByCode.delete(review.cleanCode);
      }

      const version = `${review.id}:${canonicalId}`;
      const settledEventOps = settledEvents
        .filter(isOwnEvent)
        .map((event) => {
          const key = buildIdempotencyKey(state.businessId, event.sessionId, `${event.id}:trusted-exact:${canonicalId}`, "SAVE_SCAN_EVENT");
          return makeQueueItem({
            idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
            entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
            idempotencyKey: key, scanEventId: event.id,
          });
        });
      const productKey = buildIdempotencyKey(state.businessId, review.sessionId, `${targetId}:trusted-exact:${version}`, "SAVE_PRODUCT");
      const persistOps: PendingSyncItem[] = [
        ...transferOps,
        makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "Product", entityId: targetId, operation: "SAVE_PRODUCT", payload: settledProduct,
          idempotencyKey: productKey, scanEventId: null,
        }),
      ];
      if (archivedProvisional) {
        const archiveKey = buildIdempotencyKey(state.businessId, review.sessionId, `${archivedProvisional.id}:trusted-exact-archive:${canonicalId}`, "SAVE_PRODUCT");
        persistOps.push(makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "Product", entityId: archivedProvisional.id, operation: "SAVE_PRODUCT", payload: archivedProvisional,
          idempotencyKey: archiveKey, scanEventId: null,
        }));
      }
      if (!transientProbe) {
        persistOps.push(makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: settledReview,
          idempotencyKey: reviewKey, scanEventId: matchingEvent?.id ?? null,
        }));
      }
      persistOps.push(...settledEventOps);
      enqueueAndSync(persistOps);
      return true;
    };

    // Fire-and-forget audit. NEVER blocks or throws into the scanner/UI. Only emits with a REAL business
    // context (no fake businessId/actor); a no-op when no audit sink is wired (mock/default path).
    const emitAudit = (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => {
      const { businessId, userId, businessContextReady } = get();
      if (!deps.audit || !businessContextReady || !userId || !businessId) return;
      try {
        deps.audit({ businessId, actorUserId: userId, ...e });
      } catch {
        // An audit failure must never break the scanner or any action. Swallow it.
      }
    };

    const materializeTrustedExactMiss = (reviewId: string, reason: string): UnknownCodeReview | null => {
      const probe = trustedExactProbes.get(reviewId);
      if (!probe) return get().needsReviewQueue.find((item) => item.id === reviewId) ?? null;
      const review: UnknownCodeReview = {
        ...probe,
        reason,
        decodeNote: undefined,
        decodeStatus: "needs_review",
      };
      trustedExactProbes.delete(reviewId);
      trustedExactProbeIdsByCode.delete(review.cleanCode);
      set((state) => ({
        needsReviewQueue: state.needsReviewQueue.some((item) => item.id === review.id)
          ? state.needsReviewQueue
          : [...state.needsReviewQueue, review],
        scanFeed: state.scanFeed.map((event) =>
          event.sessionId === review.sessionId && event.cleanCode === review.cleanCode && event.decodeStatus === "decoding"
            ? { ...event, decodeStatus: "needs_review" as const, reason, decodeNote: undefined }
            : event,
        ),
      }));
      enqueueAndSync([makeQueueItem({
        idFactory, now, businessId: review.businessId, sessionId: review.sessionId,
        entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: review,
        idempotencyKey: review.idempotencyKey, scanEventId: null,
      })]);
      emitAudit({ entityType: "UnknownCodeReview", entityId: review.id, action: "unknown_review_created", metadata: { code: review.cleanCode } });
      return review;
    };

    // Owner feature (2026-07-22): automatically archive the CURRENT session's live scanFeed into
    // sessionHistory the instant it ends or rotates away - called BEFORE the caller wipes scanFeed/
    // finalCounts, so a session with at least one scan is never silently lost. A zero-scan session is
    // not recorded (buildSessionHistoryEntry returns null in that case). Never throws into the caller.
    const archiveCurrentSessionIfAny = () => {
      const s = get();
      if (!s.currentSession) return;
      const getProductName = (matchedProductId: string | null) => {
        const product = matchedProductId ? s.products.find((p) => p.id === matchedProductId) : undefined;
        return product?.name ?? "Unidentified item";
      };
      const entry = buildSessionHistoryEntry(s.currentSession, s.scanFeed, getProductName, now());
      if (!entry) return;
      set((cur) => ({ sessionHistory: appendSessionHistory(cur.sessionHistory, entry) }));
    };

    // P6 C2: set-once stamp of this business's first EVER counted scan (any path). Called AFTER the
    // count has already been applied at each call site (never before - TOP-LEVEL LAW: counting is never
    // gated on this). Idempotent: a no-op once firstScanAt is already set, so re-scans/re-entries never
    // overwrite the original timestamp. Local Zustand-persisted state only (MOCK-BACKEND rule, review
    // F5) - live-auth mode mirroring this to the business doc is deferred, not built here.
    const markFirstScanIfNeeded = () => {
      if (get().firstScanAt != null) return;
      set({ firstScanAt: now() });
    };

    // Serialize cloud drains: rapid scans each call syncPending, and overlapping async drains would
    // contend on the same _appliedKeys doc (self-inflicted "already-exists"). A promise-chain mutex runs
    // each drain after the previous completes; every enqueue still triggers a drain that picks up the
    // latest queue. Per-item idempotency (transaction + ledger) remains the guarantee against true retries.
    const CLOUD_APPLY_TIMEOUT_MS = 60_000;
    const STALE_DRAIN_MS = 75_000;
    // Every N successfully/unsuccessfully processed items, the in-flight pass durably commits its
    // progress (see flushProgress in drainCloudOnce below), instead of waiting for the whole batch to
    // finish. This is what lets a multi-minute real-network drain survive being superseded mid-flight.
    const PROGRESS_FLUSH_CHUNK = 10;
    let drainChain: Promise<void> = Promise.resolve();
    let drainStartedAt: number | null = null;
    // Tracks the last time ANY item in the current pass finished processing (success or error). A pass
    // that keeps landing items is healthy no matter how long it runs in total; only a pass with NO
    // completed item for STALE_DRAIN_MS is truly wedged. Using drainStartedAt alone (the pass's total
    // age) was the 2026-08-05 livelock bug: a large real-latency batch legitimately takes minutes, so
    // the "is old" check kept firing and cancelling healthy, actively-progressing passes.
    let lastProgressAt: number | null = null;
    let activeDrainToken = 0;
    let businessLoadGeneration = 0;
    const queueItemIdentity = (item: PendingSyncItem) =>
      `${item.businessId}\u0000${item.id}\u0000${item.idempotencyKey}`;
    const syncPendingCloud = (force: boolean): Promise<void> => {
      const state = get();
      if (
        drainStartedAt !== null &&
        Date.now() - (lastProgressAt ?? drainStartedAt) > STALE_DRAIN_MS &&
        state.pendingSyncQueue.length > 0
      ) {
        console.warn(`[sync] drain watchdog: force-reset after ${Date.now() - (lastProgressAt ?? drainStartedAt)}ms with no completed item, ${state.pendingSyncQueue.length} items pending`);
        activeDrainToken += 1;
        drainStartedAt = null;
        lastProgressAt = null;
        drainChain = Promise.resolve();
      }
      drainChain = drainChain.then(async () => {
        const token = ++activeDrainToken;
        drainStartedAt = Date.now();
        lastProgressAt = drainStartedAt;
        try {
          await drainCloudOnce(force, token);
        } finally {
          if (activeDrainToken === token) {
            drainStartedAt = null;
            lastProgressAt = null;
          }
        }
      }).catch(() => {});
      return drainChain;
    };

    // Cloud drain (one pass): async, awaits db.apply, and REQUIRES a real business context first (no
    // fake/default business writes). The mock/local path keeps the original SYNCHRONOUS syncPending below.
    const drainCloudOnce = async (force: boolean, token: number) => {
      const state = get();
      if (!state.online && !force) return;
      if (state.pendingSyncQueue.length === 0) return;
      if (!state.businessContextReady || !state.userId || !state.businessId) {
        set({ lastSyncError: "Select or create a business before syncing to the cloud." });
        return; // pause: keep everything pending, write nothing
      }
      // Snapshot the batch to process. We must NOT overwrite the whole queue at the end (items enqueued
      // by rapid scans DURING this async loop would be clobbered + silently lost). Instead, track this
      // batch's outcome by item id and reconcile against the LATEST queue, preserving anything new.
      const activeBusinessId = state.businessId;
      const activeUserId = state.userId;
      const batch = state.pendingSyncQueue.filter(
        (item) => item.businessId === activeBusinessId && item.status !== "quarantined",
      );
      if (batch.length === 0) return;
      const syncedIds = new Set(get().syncedScanEventIds);
      let appliedItems = new Set<string>();
      let erroredItems = new Map<string, PendingSyncItem>();
      let lastErr: string | null = null;
      let unflushedCount = 0;

      // Persist whatever has landed so far. Intentionally NOT gated on `activeDrainToken === token` when
      // there are real successes to save: those items already committed server-side (db.apply resolved
      // ok), so their bookkeeping (dequeue + syncedScanEventIds) must survive even if the watchdog
      // supersedes this pass moments later. This is the fix for the 2026-08-05 livelock: previously the
      // ONLY commit point was a single set() after the whole batch loop, gated on the token - so a
      // superseded multi-minute pass discarded 100% of its already-server-committed progress, and the
      // replacement pass re-sent the SAME starting batch forever.
      //
      // A superseded pass with NOTHING but errored/retry bookkeeping to report (no successes) still
      // discards that partial state rather than writing it - the replacement pass will naturally retry
      // those same still-pending items, and this preserves the existing stale-clobber guarantee that an
      // abandoned pass's late-arriving results never write into a queue/session it no longer represents.
      const flushProgress = () => {
        if (appliedItems.size === 0 && erroredItems.size === 0) return;
        if (activeDrainToken !== token && appliedItems.size === 0) {
          appliedItems = new Set<string>();
          erroredItems = new Map<string, PendingSyncItem>();
          unflushedCount = 0;
          return;
        }
        const appliedSnapshot = appliedItems;
        const erroredSnapshot = erroredItems;
        const syncedSnapshot = syncedIds;
        set((cur) => {
          // Reconcile against the CURRENT queue: drop applied items, replace errored with their updated
          // version, and KEEP any items enqueued while this pass was awaiting (a later pass drains them).
          const nextQueue = cur.pendingSyncQueue
            .filter((it) => !appliedSnapshot.has(queueItemIdentity(it)))
            .map((it) => erroredSnapshot.get(queueItemIdentity(it)) ?? it);
          const recomputed = recomputeSyncStatus({
            businessId: cur.businessId,
            scanFeed: cur.scanFeed,
            finalCounts: cur.finalCounts,
            needsReviewQueue: cur.needsReviewQueue,
            pendingSyncQueue: nextQueue,
          });
          const contextStillMatches =
            cur.businessContextReady &&
            cur.businessId === activeBusinessId &&
            cur.userId === activeUserId;
          // Merge, never replace: syncedSnapshot is this pass's own local accumulator, seeded once at
          // pass start and grown only in this closure. Overwriting cur.syncedScanEventIds with it would
          // silently drop ids a DIFFERENT (newer) pass already recorded, if this pass's trailing flush
          // runs after that - reintroducing, in this one field, the exact "a pass's flush clobbers
          // progress it doesn't own" defect this fix eliminates for pendingSyncQueue. The ledger is
          // documented monotonic (scanPersist.ts:55): synced ids only ever accumulate, never shrink.
          const mergedSyncedIds = Array.from(new Set([...cur.syncedScanEventIds, ...syncedSnapshot]));
          return {
            pendingSyncQueue: nextQueue,
            syncedScanEventIds: mergedSyncedIds,
            lastSyncError: contextStillMatches ? lastErr : cur.lastSyncError,
            ...recomputed,
          };
        });
        appliedItems = new Set<string>();
        erroredItems = new Map<string, PendingSyncItem>();
        unflushedCount = 0;
      };

      const contextStillActive = () => {
        if (activeDrainToken !== token) return false;
        const live = get();
        return (
          live.businessContextReady &&
          live.businessId === activeBusinessId &&
          live.userId === activeUserId
        );
      };

      const applySyncItem = async (item: PendingSyncItem): Promise<"applied" | "failed" | "stopped"> => {
        // Token mismatch stops SENDING new applies; whatever already succeeded is saved by the flush
        // below regardless (see flushProgress comment).
        if (!contextStillActive()) return "stopped";
        const itemIdentity = queueItemIdentity(item);
        let res;
        try {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            res = await Promise.race([
              db.apply(item),
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`cloud sync apply timed out after ${CLOUD_APPLY_TIMEOUT_MS}ms`)), CLOUD_APPLY_TIMEOUT_MS);
              }),
            ]);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        } catch (e) {
          res = {
            ok: false,
            alreadyApplied: false,
            error: e instanceof Error ? e.message : String(e),
            retryable: true,
          };
        }
        if (res.ok) {
          // A genuine successful apply is forward progress: the wedged-pass watchdog must not fire
          // regardless of total pass age as long as items keep actually landing. An error/timeout is NOT
          // counted as progress here - a pass that only ever times out (never lands anything) is exactly
          // the wedge this watchdog exists to catch, same as before this fix.
          lastProgressAt = Date.now();
          appliedItems.add(itemIdentity);
          if (item.scanEventId) syncedIds.add(item.scanEventId);
        } else {
          erroredItems.set(itemIdentity, {
            ...item,
            status: res.retryable === false ? "quarantined" : "error",
            retryCount: item.retryCount + 1,
            lastError: res.error ?? "sync failed",
            syncError: {
              code: res.errorCode ?? "sync_failed",
              message: res.error ?? "sync failed",
            },
            updatedAt: now(),
          });
          lastErr = res.error ?? "sync failed";
        }
        unflushedCount += 1;
        if (unflushedCount >= PROGRESS_FLUSH_CHUNK) flushProgress();
        return res.ok ? "applied" : "failed";
      };

      const productItems = batch.filter((item) => item.operation === "SAVE_PRODUCT");
      const nonProductItems = batch.filter((item) => item.operation !== "SAVE_PRODUCT");
      if (productItems.length > 0) {
        const PRODUCT_DRAIN_CONCURRENCY = 4;
        const groups = new Map<string, PendingSyncItem[]>();
        for (const item of productItems) {
          const group = groups.get(item.entityId);
          if (group) group.push(item);
          else groups.set(item.entityId, [item]);
        }
        const productGroups = [...groups.values()];
        let nextGroupIndex = 0;
        const runProductWorker = async () => {
          while (contextStillActive()) {
            const group = productGroups[nextGroupIndex];
            nextGroupIndex += 1;
            if (!group) return;
            for (const item of group) {
              const result = await applySyncItem(item);
              if (result !== "applied") break;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PRODUCT_DRAIN_CONCURRENCY, productGroups.length) }, () =>
            runProductWorker(),
          ),
        );
      }

      for (const item of nonProductItems) {
        const result = await applySyncItem(item);
        if (result === "stopped") break;
      }
      flushProgress();
    };

    return {
      businessId: DEMO_BUSINESS_ID,
      userId: null,
      // Mock/local path needs no business context; cloud path must wait for setBusinessContext().
      businessContextReady: !cloudBackend,
      businessDataLoaded: !cloudBackend, // mock path has no remote data to load

      sessionId: "session-1",
      currentSession: {
        id: "session-1",
        businessId: DEMO_BUSINESS_ID,
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: now(),
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
      sessions: [],
      settings: DEFAULT_SETTINGS,
      products: seed.products,
      aliases: seed.aliases,
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      countSnapshots: [],
      sessionHistory: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      online: true,
      simulateSyncFailure: false,
      lastSyncError: null,
      lastMismatchWarning: null,
      lastAliasConflicts: null,
      lastCategoryWarning: null,
      aiLookupLogs: [],
      breaker: initBreaker(),
      aiStatus: { ...DEFAULT_AI_STATUS },
      catalog: [],
      shopOverrides: [],
      feedbackEvents: [],
      lastCleanupBackup: null,
      lastProductDeleteBackup: null,
      lastIdentifierBackfill: null,
      _hasHydrated: deps.persistName ? false : true,
      deviceId: null,
      location: "Main",
      recentLocations: [],
      firstScanAt: null,
      persistDegraded: null,

      setHasHydrated: (v) => set({ _hasHydrated: v }),
      setPersistDegraded: (kind) =>
        set((s) => {
          // Latch on the first kind seen, with ONE exception (F4, 2026-08-09): "demoted" is not a
          // data-loss event (a blocked IndexedDB plus a working localStorage fallback is the design,
          // and the UI shows calm copy for it), so a REAL write/migrate failure that follows must be
          // able to upgrade the latch - otherwise the calm copy stays on screen while writes are
          // genuinely being dropped. A real kind never downgrades back to "demoted".
          if (!s.persistDegraded) return { persistDegraded: { kind } };
          if (s.persistDegraded.kind === "demoted" && kind !== "demoted") return { persistDegraded: { kind } };
          return s;
        }),

      setBusinessContext: (businessId, userId) => {
        const loadGeneration = ++businessLoadGeneration;
        const needsLoad = cloudBackend && !!deps.loadBusinessData;
        // REFRESH GUARD (data-loss fix): a page refresh re-resolves the SAME (businessId, userId)
        // this store already holds and calls setBusinessContext again (BusinessContextGate runs on
        // every mount). That is NOT a tenant switch, so it must never wipe scanFeed/finalCounts/
        // needsReviewQueue/settings/firstScanAt/recentLocations - loadBusinessData can never restore
        // scanFeed/needsReviewQueue (Firestore has no collections for them), so wiping here loses
        // unsynced scans and open reviews on every reload. Only an ACTUAL tenant/user change (the
        // isolation law below) replaces tenant state.
        const contextState = get();
        const sameTenant = contextState.businessId === businessId && contextState.userId === userId;
        // Bug #41 (data-loss race): a scan processed while THIS session still held the placeholder
        // (cloud mode, sign-in bootstrap not yet resolved - userId still null) counted locally and
        // queued for sync tagged with DEMO_BUSINESS_ID. That is not a real tenant switch (no real
        // tenant was ever active in this session), so it must not go through the wipe-and-isolate
        // branch below: the tenant-aware drain (:1731-ish, recomputeSyncStatus above) only matches
        // queue items whose businessId equals the CURRENT tenant, and the placeholder id never
        // becomes the current tenant again - those items would sit stranded forever, never synced,
        // while the UI's own syncStatus derivation would misreport them as already "synced" (see
        // recomputeSyncStatus: it also filters the queue by the CURRENT businessId).
        // Only trigger the rescope path when there is actual placeholder-tagged activity to save -
        // a fresh store's first-ever setBusinessContext call (the ordinary sign-up/cloud-init shape
        // pinned by many existing tests) has an empty scanFeed/pendingSyncQueue/needsReviewQueue and
        // must keep taking the normal wipe-to-clean-slate branch below unchanged.
        const hasPlaceholderActivity =
          contextState.scanFeed.some((e) => e.businessId === DEMO_BUSINESS_ID) ||
          contextState.pendingSyncQueue.some((item) => item.businessId === DEMO_BUSINESS_ID) ||
          contextState.needsReviewQueue.some((r) => r.businessId === DEMO_BUSINESS_ID);
        const isBootstrapResolution =
          cloudBackend &&
          !sameTenant &&
          contextState.businessId === DEMO_BUSINESS_ID &&
          contextState.userId === null &&
          hasPlaceholderActivity;
        if (sameTenant) {
          set({
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
          });
        } else if (isBootstrapResolution) {
          // RE-SCOPE ON HYDRATION: keep every placeholder-scoped record (never wipe scanFeed/
          // finalCounts/needsReviewQueue/sessions/products/aliases/settings/pendingSyncQueue) and
          // re-point its businessId (plus queue payload + idempotencyKey) onto the real business.
          // Counts/rows are never lost or doubled - idempotencyKeys keep every non-businessId
          // segment, so an item already applied server-side (if that ever happened) still dedupes,
          // and every future retry of a rescoped item keeps hitting its own new stable identity.
          // The syncPending() call further below (shared with the other two branches) then drains
          // the now-correctly-scoped queue immediately.
          clearTrustedExactProbes();
          // The set this branch is about to rescope IS the adopted set - capture it BEFORE rewriting
          // businessId, so the re-sync rebuild below knows precisely which entities came from the
          // placeholder/mock phase (never touching anything that already belonged to a live tenant).
          const adoptedEventIds = new Set(
            contextState.scanFeed.filter((e) => e.businessId === DEMO_BUSINESS_ID).map((e) => e.id),
          );
          const adoptedReviewIds = new Set(
            contextState.needsReviewQueue.filter((r) => r.businessId === DEMO_BUSINESS_ID).map((r) => r.id),
          );
          const rescopedProducts = contextState.products.map((p) => rescopePlaceholderRecord(p, businessId));
          const rescopedScanFeed = contextState.scanFeed.map((e) => rescopePlaceholderRecord(e, businessId));
          const rescopedFinalCounts = contextState.finalCounts.map((c) => rescopePlaceholderRecord(c, businessId));
          const rescopedReviews = contextState.needsReviewQueue.map((r) => rescopePlaceholderRecord(r, businessId));
          const rescopedQueue = contextState.pendingSyncQueue.map((item) =>
            rescopePlaceholderQueueItem(item, businessId),
          );
          // ADOPTION RE-SYNC: rebuild the sync work for adopted rows the mock backend already flagged
          // "synced" (queue empty). Dedupes by idempotencyKey against the rescoped queue, so the
          // ordinary not-yet-drained shape adds nothing. See buildAdoptionResyncItems.
          const resyncItems = buildAdoptionResyncItems({
            businessId,
            scanFeed: rescopedScanFeed,
            finalCounts: rescopedFinalCounts,
            needsReviewQueue: rescopedReviews,
            products: rescopedProducts,
            existingQueue: rescopedQueue,
            adoptedEventIds,
            adoptedReviewIds,
            idFactory,
            now,
          });
          const nextQueue = resyncItems.length > 0 ? [...rescopedQueue, ...resyncItems] : rescopedQueue;
          // Honest UI: rows with queued work read "pending" until the drain actually lands them, so
          // the adopted inventory never claims a cloud save that has not happened yet.
          const recomputed = recomputeSyncStatus({
            businessId,
            scanFeed: rescopedScanFeed,
            finalCounts: rescopedFinalCounts,
            needsReviewQueue: rescopedReviews,
            pendingSyncQueue: nextQueue,
          });
          set({
            businessId,
            userId,
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
            products: rescopedProducts,
            aliases: contextState.aliases.map((a) => rescopePlaceholderRecord(a, businessId)),
            sessions: contextState.sessions.map((s) => rescopePlaceholderRecord(s, businessId)),
            currentSession: contextState.currentSession
              ? rescopePlaceholderRecord(contextState.currentSession, businessId)
              : contextState.currentSession,
            scanFeed: recomputed.scanFeed,
            finalCounts: recomputed.finalCounts,
            needsReviewQueue: recomputed.needsReviewQueue,
            settings: rescopePlaceholderRecord(contextState.settings, businessId),
            pendingSyncQueue: nextQueue,
            // F-5 class closure (2026-08-09): aiLookupLogs carries businessId too and was not being
            // rescoped at all - a platformOwner reading logs after adoption would still see the
            // placeholder tenant id on pre-adoption entries.
            aiLookupLogs: contextState.aiLookupLogs.map((l) => rescopePlaceholderRecord(l, businessId)),
          });
        } else {
          clearTrustedExactProbes();
          // Isolation: settings/needsReviewQueue/scanFeed are NOT returned by loadBusinessData and
          // finalCounts linger when no session restores, so a context switch must REPLACE all four or
          // the previous tenant's rows bleed through (two users OR one user with two businesses).
          const cleared = emptyTenantState();
          set({
            businessId,
            userId,
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
            products: cleared.products,
            aliases: cleared.aliases,
            sessions: cleared.sessions,
            // The old tenant's session must not survive: ensureAutoSession would ADOPT it (spreading
            // its old businessId) and enqueue foreign SAVE_SESSIONs the new tenant's rules deny
            // forever. cleared.currentSession is null, so the next scan mints a fresh session here.
            // NOTE: pendingSyncQueue is deliberately NOT filtered here - the sync drain is tenant-aware
            // (tenantQueueIsolation.store.test.ts), so foreign-tenant items are preserved and drain
            // when their own tenant becomes active again, never clogging under the wrong tenant.
            currentSession: cleared.currentSession,
            sessionId: cleared.sessionId,
            scanFeed: cleared.scanFeed,
            finalCounts: cleared.finalCounts,
            needsReviewQueue: cleared.needsReviewQueue,
            countSnapshots: cleared.countSnapshots,
            settings: cleared.settings,
            firstScanAt: cleared.firstScanAt,
            recentLocations: cleared.recentLocations,
            location: "Main",
            syncedScanEventIds: [],
            lastMismatchWarning: null,
            lastAliasConflicts: null,
            lastCategoryWarning: null,
            aiLookupLogs: [],
            shopOverrides: [],
            feedbackEvents: [],
            lastCleanupBackup: null,
            lastProductDeleteBackup: null,
            lastIdentifierBackfill: null,
            // Tenant isolation: the previous tenant's archived scan log (codes + product names) must
            // never bleed into the next tenant's History page.
            sessionHistory: cleared.sessionHistory,
          });
        }
        const loader = deps.loadBusinessData;
        if (cloudBackend && loader) {
          // Load THIS business's products/aliases from Firestore (pending-aware and never across
          // tenant switches), then drain anything queued. Failure is surfaced, not fatal to the local
          // UI. The pending-aware finalCounts merge below keeps this device's unsynced increments
          // authoritative, so no pre-drain is needed: a local row still referenced by an unsynced
          // INCREMENT_COUNT queue item wins over the remote snapshot until it syncs.
          void (async () => {
            try {
              const data = await loader(businessId, userId);
              if (
                loadGeneration !== businessLoadGeneration ||
                get().businessId !== businessId ||
                get().userId !== userId
              ) {
                return;
              }
              // Reconstruct the active count session + its finalCounts (survive-refresh). Prefer the most
              // recent ACTIVE session; else the most recent overall. finalCounts are the persisted count
              // lines for that session, mapped back to store shape. No session -> keep current defaults.
              const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
                (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
              const sessions = [...data.sessions].sort(byStartedAtDesc);
              const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
              set((cur) => {
                const mergedIdentities = mergeReloadedProductsAndAliases({
                  businessId,
                  localProducts: cur.products,
                  remoteProducts: data.products,
                  localAliases: cur.aliases,
                  remoteAliases: data.aliases,
                  pendingSyncQueue: cur.pendingSyncQueue,
                });
                const next: Partial<ScanState> = {
                  products: mergedIdentities.products,
                  aliases: mergedIdentities.aliases,
                  businessDataLoaded: true,
                };
                if (restored) {
                  // Same-tenant refresh guard (part 2): the synchronous guard above preserves the local
                  // feed/counts, so this restore must not quietly re-introduce the wipe by REPLACING
                  // finalCounts with the remote snapshot - that snapshot has not seen this device's
                  // unsynced increments, so a refresh with pending work would show a feed of N against
                  // counts of N-k (the exact feed-vs-counts divergence class the guard exists to stop).
                  // Mirror refreshFromCloud's pending-aware merge: a local row still referenced by an
                  // unsynced INCREMENT_COUNT queue item is authoritative until it syncs; otherwise the
                  // remote row wins. A tenant switch starts from a wiped store (empty local counts, empty
                  // queue), so that path degrades to the plain remote restore this used to be.
                  next.currentSession = cur.currentSession?.id === restored.id ? cur.currentSession : restored;
                  next.sessionId = restored.id;
                  const tenantPendingQueue = cur.pendingSyncQueue.filter((it) => it.businessId === businessId);
                  const pendingCountItems = tenantPendingQueue.filter((it) => it.operation === "INCREMENT_COUNT");
                  const pendingCountKeys = new Set(
                    pendingCountItems
                      .map((it) => {
                        const payload = it.payload as Partial<IncrementPayload> | undefined;
                        const productId = payload?.productId;
                        if (!productId) return null;
                        return `${payload.sessionId ?? it.sessionId}|${productId}`;
                      })
                      .filter((key): key is string => !!key),
                  );
                  const pendingCountEntityIds = new Set(pendingCountItems.map((it) => it.entityId));
                  // Seed from the restored session's rows PLUS any row this device still has unsynced
                  // work for: one a pendingSyncQueue item references (any sessionId), or one belonging
                  // to cur.currentSession when that session itself has not synced yet. Otherwise a local
                  // row from a different/unsynced session (e.g. this device's own active session, when
                  // the remote answers with a different restored session) was silently dropped instead
                  // of merged - unsynced local work would vanish on a business-context refresh.
                  const pendingSessionIds = new Set(tenantPendingQueue.map((it) => it.sessionId));
                  const unsyncedCurrentSessionId =
                    cur.currentSession && cur.currentSession.syncStatus !== "synced" ? cur.currentSession.id : null;
                  const countsByKey = new Map(
                    cur.finalCounts
                      .filter(
                        (c) =>
                          c.sessionId === restored.id ||
                          pendingSessionIds.has(c.sessionId) ||
                          pendingCountKeys.has(`${c.sessionId}|${c.productId}`) ||
                          pendingCountEntityIds.has(c.id) ||
                          pendingCountEntityIds.has(`${c.sessionId}_${c.productId}`) ||
                          (unsyncedCurrentSessionId !== null && c.sessionId === unsyncedCurrentSessionId),
                      )
                      .map((c) => [`${c.sessionId}|${c.productId}`, c]),
                  );
                  for (const remote of data.counts) {
                    if (remote.sessionId !== restored.id) continue;
                    const key = `${remote.sessionId}|${remote.productId}`;
                    const local = countsByKey.get(key);
                    const localIsPending =
                      !!local &&
                      (pendingCountKeys.has(key) ||
                        pendingCountEntityIds.has(local.id) ||
                        pendingCountEntityIds.has(`${local.sessionId}_${local.productId}`));
                    if (localIsPending) continue; // guard: unsynced local wins
                    countsByKey.set(key, remote);
                  }
                  next.finalCounts = [...countsByKey.values()];
                  const pendingScanEventIds = new Set(
                    tenantPendingQueue
                      .map((it) => it.scanEventId ?? it.entityId)
                      .filter((id): id is string => !!id),
                  );
                  if (Array.isArray(data.scanEvents)) {
                    const remoteFeed = data.scanEvents
                      .filter((e) => e.sessionId === restored.id)
                      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
                    const feedById = new Map(remoteFeed.map((e) => [e.id, e]));
                    for (const local of cur.scanFeed) {
                      if (local.sessionId !== restored.id) continue;
                      if (local.syncStatus === "synced" && !pendingScanEventIds.has(local.id)) continue;
                      feedById.set(local.id, local);
                    }
                    next.scanFeed = [...feedById.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
                  }
                }
                return next;
              });
            } catch (e) {
              if (
                loadGeneration !== businessLoadGeneration ||
                get().businessId !== businessId ||
                get().userId !== userId
              ) {
                return;
              }
              // Surface the error but mark loaded so the UI does not hang forever (sync still paused on error).
              set({ lastSyncError: e instanceof Error ? e.message : "Failed to load business data", businessDataLoaded: true });
            }
            if (
              loadGeneration !== businessLoadGeneration ||
              get().businessId !== businessId ||
              get().userId !== userId
            ) {
              return;
            }
            get().syncPending();
          })();
        } else {
          get().syncPending(); // drain anything queued now that we have a real business context
        }
      },

      prepareSignOut: async () => {
        // F1: never destroy unsynced work silently. An empty queue is the common case - return 0 WITHOUT
        // invoking the drain at all (no needless network on a clean sign-out). Otherwise attempt exactly
        // one awaited drain via the established retry path (force=true so an offline flag does not skip
        // it), then report how many items STILL could not sync so the UI can warn honestly. The whole
        // drain is wrapped so a network/provider failure can never throw out of the sign-out handler.
        if (get().pendingSyncQueue.length === 0) return 0;
        try {
          // Cloud path: syncPendingCloud returns the awaitable mutex-chained drain. Mock/local path:
          // syncPending(true) is synchronous, so there is nothing to await - the queue is already
          // reconciled by the time this returns. Either way we then re-read the queue length.
          if (cloudBackend) {
            await syncPendingCloud(true);
          } else {
            get().syncPending(true);
          }
        } catch {
          // Swallow: a failed drain must not abort sign-out. The count below reflects what survived.
        }
        return get().pendingSyncQueue.length;
      },

      resetForSignOut: () => {
        clearTrustedExactProbes();
        // Capture identity BEFORE the reset wipes it: the per-uid key must be removed and the persist
        // middleware re-pointed to the anon key, or the fail-soft coalesced storage would simply
        // rewrite sis-scan-<uid> on the next tick and the "cleared" state would leak right back.
        const uid = get().userId;
        // Re-point persist at the anon key BEFORE the wipe below. Firebase's own SDK auth persistence
        // is cleared by fbSignOut (auth.ts:66-69) in the UI sign-out handlers - that call is the
        // authority for SDK state; this action owns only app state. Guarded on deps.persistName so the
        // non-persisted test store (createTestScanStore, persistName: null) never touches the
        // module-level app store. Doing this BEFORE the wipe (not after) is what stops the coalesced
        // writer from resurrecting the uid key: the coalescer keeps only one pending slot (latest
        // name+value), so once persist is re-pointed, the wipe's own write below targets the anon key
        // and overwrites any older pending write still queued for the uid key. The direct
        // localStorage.removeItem(persistKeyForUid(uid)) further down stays authoritative regardless.
        if (deps.persistName) {
          const persistApi = (useScanStore as unknown as {
            persist?: { setOptions: (o: { name: string }) => void };
          }).persist;
          if (persistApi) persistApi.setOptions({ name: persistKeyForUid(null) });
        }
        const cleared = emptyTenantState();
        set({
          businessId: DEMO_BUSINESS_ID,
          userId: null,
          businessContextReady: !cloudBackend,
          businessDataLoaded: !cloudBackend,
          products: cleared.products,
          aliases: cleared.aliases,
          sessions: cleared.sessions,
          scanFeed: cleared.scanFeed,
          finalCounts: cleared.finalCounts,
          needsReviewQueue: cleared.needsReviewQueue,
          settings: cleared.settings,
          firstScanAt: cleared.firstScanAt,
          recentLocations: cleared.recentLocations,
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
          // N2: the wipe write also deposits tenant-scoped SESSION IDENTITY + variance SNAPSHOTS into the
          // persisted blob. Clear them too so a signed-out browser holds no residue of the prior tenant's
          // session/report data (and does not spuriously look "non-empty" to legacyBlobIsMeaningful,
          // the shared predicate behind hasMeaningfulLegacyBlobAsync). countSnapshots
          // is the variance ring buffer; currentSession/sessionId are the active-session identity.
          // sessionId is typed `string` (non-nullable), so it is cleared to "" rather than null.
          // sessionHistory carries the tenant's scanned codes - same residue rule.
          countSnapshots: cleared.countSnapshots,
          sessionHistory: [],
          currentSession: cleared.currentSession,
          sessionId: cleared.sessionId,
        });
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            clearSelectedBusinessId(); // sis-selected-business-v1 is NOT uid-namespaced: explicit clear
            if (uid) {
              // F-4 fix (resurrection leak, 2026-08-09): cancel any coalesced write still pending for
              // this key FIRST (the wrapper's own removeItem does this, plus deletes from backing) - or
              // that pending write could land after removePersistedKeyEverywhere and resurrect the key.
              if (deps.persistName) scanPersistBackingStorage.removeItem(persistKeyForUid(uid));
              removePersistedKeyEverywhere(persistKeyForUid(uid));
            }
          } catch {
            // ignore storage errors: the in-memory reset above already holds
          }
        }
      },

      rehydrateForUid: (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return Promise.resolve();
        // Re-point storage at this uid's key and rehydrate from it. NO legacy migration here:
        // adopting the pre-account blob is an explicit owner action (adoptLegacyLocalData), never an
        // automatic side effect of signing in (shared-browser inheritance hazard).
        if (!deps.persistName) return Promise.resolve(); // non-persisted test store: nothing to re-point
        const persistApi = (useScanStore as unknown as {
          persist?: { setOptions: (o: { name: string }) => void; rehydrate: () => Promise<void> | void };
        }).persist;
        if (persistApi) {
          persistApi.setOptions({ name: persistKeyForUid(uid) });
          // Returned so callers (BusinessContextGate) can AWAIT rehydrate before calling
          // setBusinessContext - only then does the store's businessId/userId reflect the persisted
          // state, letting the same-tenant refresh guard above actually match on a real refresh.
          return Promise.resolve(persistApi.rehydrate()).then(() => sweepEmptyLegacyResidue());
        }
        return Promise.resolve();
      },

      adoptLegacyLocalData: async (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        // OWNER-INITIATED adopt: copy sis-scan-v1 into this uid's key (normalizing quantityDelta:0),
        // DELETE the legacy blob, then hydrate from the adopted key. Returns the rehydrate promise so
        // callers can await it before setBusinessContext (same ordering rule as the main gate path).
        // IDB-aware: when IndexedDB is the active persist backing, migrate through the async/IDB path
        // so the copy actually lands where the store will read it from; otherwise fall back to the
        // original synchronous localStorage-only migration.
        if (typeof indexedDB !== "undefined") {
          await migrateLegacyBlobOnceAsync(uid);
        } else {
          migrateLegacyBlobOnce(uid, window.localStorage);
        }
        // B4 fix (owner-reported false-safety copy, 2026-08-09): the migrate call above has now COPIED
        // the anon blob to this uid's key AND DELETED the legacy blob (migrateLegacyBlobOnce(Async)'s own
        // contract: throws propagate BEFORE that delete, so a throw from the block above always means
        // the anon blob is still intact - "pre-copy"). Everything from this point on runs AFTER the copy
        // has landed, so a failure here is a genuinely different situation: the anon blob no longer
        // exists, and the per-uid key now HOLDS the adopted data. Tag any such failure so the caller
        // (BusinessContextGate) never claims "your local data is still safe" (false) and never offers
        // "start fresh" (which would re-point persist at a per-uid key that now silently contains the
        // just-adopted inventory instead of a fresh empty one).
        try {
          // F-4 fix (resurrection leak, 2026-08-09): migrateLegacyBlobOnce(Async) deletes the legacy key
          // by writing straight to the raw backing store(s), bypassing this store's own coalesced-write
          // wrapper entirely. If a scan happened under the placeholder tenant moments before this adopt
          // (still-pending, not yet flushed - the wrapper batches ~6 writes/scan into at most one write
          // per tick), that pending write's target name/value are untouched by the raw delete above and
          // can still flush AFTER it, re-creating "sis-scan-v1" with the previous user's stale scan data.
          // On a shared device the NEXT sign-in would then see the adopt banner offering that resurrected
          // (and by then orphaned) inventory. Cancel any such pending write for the legacy key now that
          // the copy has landed - this never removes anything not already removed above, it only stops a
          // stale in-flight write for THIS key from landing later.
          if (deps.persistName) scanPersistBackingStorage.removeItem(LEGACY_PERSIST_KEY);
          return await get().rehydrateForUid(uid);
        } catch (err) {
          const tagged = err instanceof Error ? err : new Error(String(err));
          (tagged as Error & { postCopyAdoptFailure?: true }).postCopyAdoptFailure = true;
          throw tagged;
        }
      },

      recordFeedback: (type, payload) =>
        set((s) => ({
          feedbackEvents: appendFeedback(s.feedbackEvents, {
            id: idFactory(),
            businessId: s.businessId,
            type,
            code: payload.code,
            productId: payload.productId ?? null,
            at: now(),
            meta: payload.meta,
          }),
        })),

      snapshotCount: (label) => {
        const s = get();
        const productById = new Map(s.products.map((p) => [p.id, p]));
        const snapshot: CountSnapshot = {
          id: idFactory(),
          label,
          takenAt: now(),
          lines: s.finalCounts.map((c) => ({
            productId: c.productId,
            name: productById.get(c.productId)?.name ?? "",
            qty: c.quantity,
          })),
        };
        // Same capped-ring-buffer shape as appendFeedback: append newest, slice off the oldest once
        // over the cap, so the most recent snapshot is always last.
        set((cur) => {
          const next = [...cur.countSnapshots, snapshot];
          return { countSnapshots: next.length > COUNT_SNAPSHOT_CAP ? next.slice(next.length - COUNT_SNAPSHOT_CAP) : next };
        });
        return snapshot;
      },

      startSession: (name, location) => {
        clearTrustedExactProbes();
        // Owner feature (2026-07-22): archive the session being abandoned/rotated away from BEFORE
        // its scanFeed is wiped below - a session with at least one scan is never silently lost.
        archiveCurrentSessionIfAny();
        const previousSessionId = get().currentSession?.id;
        const id = `session-${idFactory()}`;
        const businessId = get().businessId;
        const session: InventorySession = {
          id,
          businessId,
          name: name || "Session",
          location: location || "Main",
          status: "active",
          startedAt: now(),
          completedAt: null,
          createdBy: get().userId ?? "demo",
          notes: "",
          syncStatus: "synced",
          locked: false,
          lockedAt: null,
        };
        set({
          sessionId: id,
          currentSession: session,
          scanFeed: [],
          finalCounts: pruneFinalCountsForRotation(get().finalCounts, previousSessionId),
          needsReviewQueue: [],
          // DATA-LOSS FIX (owner 4k campaign, 2026-08-05): pendingSyncQueue is deliberately NOT
          // wiped here. Rotating while the previous session's backlog is still draining was
          // silently discarding its unsynced cloud writes (measured live: 1,000 of 4,000 scan
          // events never reached Firestore). Queue items carry their own sessionId/businessId and
          // the drain is session-agnostic, so the backlog keeps draining under the new session -
          // same principle as setBusinessContext's "deliberately NOT filtered" tenant rule.
          // Guard: sessionRotationSyncSafety.store.test.ts.
          syncedScanEventIds: [],
          lastSyncError: null,
        });
        // Persist the session through the SAME durable queue as scans/counts (never blocks the UI).
        // Distinct idempotency key per lifecycle state ("active") so finishSession's write still applies.
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId,
            sessionId: id,
            entityType: "CountSession",
            entityId: id,
            operation: "SAVE_SESSION",
            payload: session,
            idempotencyKey: buildIdempotencyKey(businessId, id, `${id}-active`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: id, action: "session_started", metadata: { name: session.name, location: session.location } });
      },

      finishSession: () => {
        const cur = get().currentSession;
        if (!cur) return;
        const completed: InventorySession = { ...cur, status: "completed", completedAt: now() };
        set({ currentSession: completed });
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId: completed.businessId,
            sessionId: completed.id,
            entityType: "CountSession",
            entityId: completed.id,
            operation: "SAVE_SESSION",
            payload: completed,
            // Distinct key from the "active" write so the completed state is not deduped as alreadyApplied.
            idempotencyKey: buildIdempotencyKey(completed.businessId, completed.id, `${completed.id}-completed`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: completed.id, action: "session_completed", metadata: { completedAt: completed.completedAt } });
      },

      // --- Owner PIN lock -------------------------------------------------------------------------------
      hasOwnerPin: () => !!get().settings.ownerPinHash,

      setOwnerPin: async (pin) => {
        if (!isValidPinFormat(pin)) return false;
        const ownerPinHash = await hashPin(pin);
        set((s) => ({ settings: { ...s.settings, ownerPinHash } }));
        emitAudit({ entityType: "CountSession", entityId: "-", action: "owner_pin_set", metadata: {} });
        return true;
      },

      resetOwnerPin: () => {
        // Escape hatch: clear the PIN and UNLOCK every session (so a forgotten PIN can never trap a count).
        set((s) => ({
          settings: { ...s.settings, ownerPinHash: "" },
          currentSession: s.currentSession?.locked ? { ...s.currentSession, locked: false, lockedAt: null } : s.currentSession,
        }));
        emitAudit({ entityType: "CountSession", entityId: "-", action: "owner_pin_reset", metadata: {} });
      },

      verifyOwnerPin: async (pin) => verifyPin(pin, get().settings.ownerPinHash),

      lockSession: (sessionId) => {
        // A PIN must exist first (nothing to unlock with otherwise).
        if (!get().settings.ownerPinHash) return false;
        const cur = get().currentSession;
        if (!cur || cur.id !== sessionId || cur.locked) return false;
        const locked: InventorySession = { ...cur, locked: true, lockedAt: now() };
        set({ currentSession: locked });
        enqueueAndSync([
          makeQueueItem({
            idFactory, now, businessId: locked.businessId, sessionId: locked.id,
            entityType: "CountSession", entityId: locked.id, operation: "SAVE_SESSION", payload: locked,
            idempotencyKey: buildIdempotencyKey(locked.businessId, locked.id, `${locked.id}-locked-${locked.lockedAt}`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: locked.id, action: "session_locked", metadata: {} });
        return true;
      },

      unlockSession: async (sessionId, pin) => {
        const cur = get().currentSession;
        if (!cur || cur.id !== sessionId || !cur.locked) return false;
        if (!(await verifyPin(pin, get().settings.ownerPinHash))) return false;
        const unlocked: InventorySession = { ...cur, locked: false, lockedAt: null };
        set({ currentSession: unlocked });
        enqueueAndSync([
          makeQueueItem({
            idFactory, now, businessId: unlocked.businessId, sessionId: unlocked.id,
            entityType: "CountSession", entityId: unlocked.id, operation: "SAVE_SESSION", payload: unlocked,
            idempotencyKey: buildIdempotencyKey(unlocked.businessId, unlocked.id, `${unlocked.id}-unlocked-${now()}`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: unlocked.id, action: "session_unlocked", metadata: {} });
        return true;
      },

      // --- Browse + reopen saved sessions --------------------------------------------------------------
      // PHASE 3 FIX (scout-sessions gap #6): on the cloud backend these MUST NOT read getMockDb() directly
      // (that silently returns an empty/stale local mock DB for a Firebase-backed account). The mock/local
      // path is unchanged (still getMockDb(), which IS the real backing store there). Task 7's
      // refreshFromCloud populates `sessions`; before the first refresh, the current session is the
      // honest fallback. After refresh, the full cloud session history is the read source.
      listSessions: () => {
        if (cloudBackend) {
          const sessions = get().sessions;
          if (sessions.length > 0) return sessions;
          const cur = get().currentSession;
          return cur ? [cur] : [];
        }
        return getMockDb()
          .getSessions(get().businessId)
          .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      },

      reopenSession: (sessionId) => {
        if (cloudBackend) {
          // Cloud path: Task 7 refreshes full session history and counts into store state. Look up the
          // requested history row there, with currentSession only as the pre-refresh fallback.
          const state = get();
          const session =
            state.sessions.find((candidate) => candidate.id === sessionId) ??
            (state.currentSession?.id === sessionId ? state.currentSession : null);
          if (!session) return false;
          clearTrustedExactProbes();
          set({
            currentSession: session,
            sessionId: session.id,
            finalCounts: state.finalCounts.filter((c) => c.sessionId === session.id),
            scanFeed: [],
            needsReviewQueue: [],
          });
          emitAudit({ entityType: "CountSession", entityId: session.id, action: "session_reopened", metadata: {} });
          return true;
        }
        const db = getMockDb();
        const session = db.getSession(sessionId);
        if (!session || session.businessId !== get().businessId) return false;
        clearTrustedExactProbes();
        const finalCounts: InventoryCount[] = db.getSessionCounts(sessionId).map((c) => ({
          id: `count-${c.sessionId}-${c.productId}`,
          businessId: c.businessId,
          sessionId: c.sessionId,
          productId: c.productId,
          quantity: c.quantity,
          lastScannedAt: "",
          aliasesSeen: [],
          scanEventIds: c.scanEventIds,
          createdAt: session.startedAt,
          updatedAt: session.startedAt,
          syncStatus: "synced",
          syncError: null,
          appliedIdempotencyKeys: c.appliedIdempotencyKeys,
        }));
        set({ currentSession: session, sessionId: session.id, finalCounts, scanFeed: [], needsReviewQueue: [] });
        emitAudit({ entityType: "CountSession", entityId: session.id, action: "session_reopened", metadata: {} });
        return true;
      },

      ensureAutoSession: () => {
        if (typeof window === "undefined" || !window.localStorage) return; // non-browser/test context: no-op
        const deviceId = getOrCreateDeviceId(window.localStorage);
        set({ deviceId });
        const cur = get().currentSession;
        const nowIso = now();
        if (
          cur &&
          shouldReuseSession(
            { status: cur.status, deviceId: cur.deviceId, startedAt: cur.startedAt, locked: cur.locked },
            { deviceId, nowIso, inactivityMinutes: AUTO_SESSION_INACTIVITY_MINUTES },
          )
        ) {
          return; // idempotent: this device's session is still fresh and active, reuse it
        }
        // ADOPT an UNCLAIMED active session still within the window (a legacy/default/mock session with
        // no deviceId): claim it for this device and KEEP its counts, instead of rotating to a fresh
        // session and wiping the visible finalCounts. Rotating-with-wipe is correct only for a genuinely
        // new session (none active), a DIFFERENT device's session, or one past the inactivity window.
        // Without this, ensureAutoSession on scan-page mount would erase a hydrated in-progress count.
        // A LOCKED session is never adopted either (F1) - it must rotate to a fresh session, same as completed.
        if (cur && cur.status === "active" && !cur.locked && !cur.deviceId) {
          const startedMs = Date.parse(cur.startedAt);
          const withinWindow =
            !Number.isNaN(startedMs) &&
            (Date.parse(nowIso) - startedMs) / 60000 <= AUTO_SESSION_INACTIVITY_MINUTES;
          if (withinWindow) {
            // Adopt keeps id/counts, but the boot placeholder name ("Default Session") must NOT leak
            // to the UI - rename an unnamed/placeholder adopted session to a real auto-session name.
            const adopted: InventorySession = {
              ...cur,
              deviceId,
              name: cur.name === "Default Session" ? buildAutoSessionName(nowIso) : cur.name,
            };
            set({ currentSession: adopted });
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId: adopted.businessId,
                sessionId: adopted.id,
                entityType: "CountSession",
                entityId: adopted.id,
                operation: "SAVE_SESSION",
                payload: adopted,
                idempotencyKey: buildIdempotencyKey(adopted.businessId, adopted.id, `${adopted.id}-adopted-${deviceId}`, "SAVE_SESSION"),
                scanEventId: null,
              }),
            ]);
            emitAudit({ entityType: "CountSession", entityId: adopted.id, action: "session_adopted", metadata: { deviceId } });
            return;
          }
        }
        // A genuine rotation away from the prior session (fresh session below wipes scanFeed/
        // finalCounts) - archive it first, same as startSession.
        archiveCurrentSessionIfAny();
        clearTrustedExactProbes();
        const id = `session-${idFactory()}`;
        const businessId = get().businessId;
        const session: InventorySession = {
          id,
          businessId,
          name: buildAutoSessionName(nowIso),
          location: cur?.location || "Main",
          status: "active",
          startedAt: nowIso,
          completedAt: null,
          createdBy: get().userId ?? "demo",
          notes: "",
          syncStatus: "synced",
          locked: false,
          lockedAt: null,
          deviceId,
        };
        set({
          sessionId: id,
          currentSession: session,
          scanFeed: [],
          finalCounts: pruneFinalCountsForRotation(get().finalCounts, cur?.id),
          needsReviewQueue: [],
          lastSyncError: null,
        });
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId,
            sessionId: id,
            entityType: "CountSession",
            entityId: id,
            operation: "SAVE_SESSION",
            payload: session,
            idempotencyKey: buildIdempotencyKey(businessId, id, `${id}-active`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: id, action: "session_auto_started", metadata: { name: session.name, deviceId } });
      },

      refreshFromCloud: async () => {
        if (!cloudBackend || !deps.loadBusinessData) return; // mock/local path: already the source of truth
        const state = get();
        if (!state.businessContextReady || !state.userId || !state.businessId) return;
        const businessId = state.businessId;
        const userId = state.userId;
        const loadGeneration = ++businessLoadGeneration;
        let data;
        try {
          data = await deps.loadBusinessData(businessId, userId);
        } catch (e) {
          if (
            loadGeneration !== businessLoadGeneration ||
            get().businessId !== businessId ||
            get().userId !== userId
          ) {
            return;
          }
          set({ lastSyncError: e instanceof Error ? e.message : "Failed to refresh from the cloud" });
          return;
        }
        if (
          loadGeneration !== businessLoadGeneration ||
          get().businessId !== businessId ||
          get().userId !== userId
        ) {
          return;
        }
        set((cur) => {
          const tenantPendingQueue = cur.pendingSyncQueue.filter((it) => it.businessId === businessId);
          // Products/aliases: one shared pending-aware reload policy with setBusinessContext.
          // Remote rows replace non-pending local rows and add remote-only rows, but this device's
          // still-unsynced SAVE_PRODUCT / RESOLVE_ALIAS rows remain authoritative until they drain.
          // A locally archived product also stays archived against stale active remote snapshots.
          const mergedIdentities = mergeReloadedProductsAndAliases({
            businessId,
            localProducts: cur.products,
            remoteProducts: data.products,
            localAliases: cur.aliases,
            remoteAliases: data.aliases,
            pendingSyncQueue: cur.pendingSyncQueue,
          });
          const sessionsById = new Map(cur.sessions.map((s) => [s.id, s]));
          // Preserve previously refreshed history and fold in the current session before applying
          // the remote list, so a refresh never silently drops this device's own active session.
          if (cur.currentSession) sessionsById.set(cur.currentSession.id, cur.currentSession);
          for (const s of data.sessions) sessionsById.set(s.id, s);

          // finalCounts: additive upsert by (sessionId,productId), EXCEPT any row still referenced by
          // a pending (unsynced) queue item - that row's local value is authoritative until it syncs.
          const pendingCountItems = tenantPendingQueue.filter((it) => it.operation === "INCREMENT_COUNT");
          const pendingCountKeys = new Set(
            pendingCountItems
              .map((it) => {
                const payload = it.payload as Partial<IncrementPayload> | undefined;
                const productId = payload?.productId;
                if (!productId) return null;
                return `${payload.sessionId ?? it.sessionId}|${productId}`;
              })
              .filter((key): key is string => !!key),
          );
          const pendingCountEntityIds = new Set(pendingCountItems.map((it) => it.entityId));
          // Products THIS device archived before the merge (its own deletes) - distinguishes a
          // local delete from one performed on another device (see the archived branch below).
          const locallyArchivedIds = new Set(cur.products.filter((p) => p.status === "archived").map((p) => p.id));
          const countsByKey = new Map(cur.finalCounts.map((c) => [`${c.sessionId}|${c.productId}`, c]));
          for (const remote of data.counts) {
            const key = `${remote.sessionId}|${remote.productId}`;
            const local = countsByKey.get(key);
            // pendingCountKeys deliberately does NOT require a local row: the delete-transfer's
            // zero-out increment targets a (sessionId, productId) row that no longer exists locally
            // (it was repointed onto the provisional), yet the remote copy must still not be
            // re-added while that op is pending.
            const localIsPending =
              pendingCountKeys.has(key) ||
              (!!local &&
                (pendingCountEntityIds.has(local.id) ||
                  pendingCountEntityIds.has(`${local.sessionId}_${local.productId}`)));
            if (localIsPending) continue; // guard: unsynced local wins
            if (mergedIdentities.products.find((p) => p.id === remote.productId)?.status === "archived") {
              // Delete-transfer guard (reviewed defect 2026-07-22): a remote count row keyed to a
              // LOCALLY-archived product is the backend's not-yet-transferred (or stale-snapshot)
              // copy of a product THIS device deleted. deleteProductsInternal already repointed
              // those units onto a minted provisional, so re-adding the remote row here would
              // double-count them (2 became 4). The archived-product merge guard above keeps a
              // local archive authoritative, so this holds even after the transfer ops drained.
              if (locallyArchivedIds.has(remote.productId)) continue;
              // Cross-device delete (reviewed defect 2026-07-22): the archive came from the REMOTE
              // (this device's copy was still active - ANOTHER device deleted it). The remote row
              // is the post-transfer zeroed truth; skipping it would keep the stale local row
              // alive NEXT TO the remote provisional row (2 became 4 on every other device), so
              // fall through and let the remote (zeroed) row replace the stale local one.
            }
            countsByKey.set(key, remote);
          }

          return {
            products: mergedIdentities.products,
            aliases: mergedIdentities.aliases,
            sessions: [...sessionsById.values()],
            finalCounts: [...countsByKey.values()],
            lastSyncError: null,
          };
        });
      },

      setLocation: (location) => {
        const trimmed = location.trim();
        if (!trimmed) return;
        set((s) => {
          const withoutDup = s.recentLocations.filter((l) => l !== trimmed);
          const next = [...withoutDup, trimmed];
          return {
            location: trimmed,
            recentLocations: next.length > RECENT_LOCATIONS_CAP ? next.slice(next.length - RECENT_LOCATIONS_CAP) : next,
          };
        });
      },

      processScan: (rawInput) => {
        // LAYER C / OUTER SAFETY NET (third-review hardening, 2026-08-16; widened FOURTH-review,
        // 2026-08-16): LAYER A (persist merge) and LAYER B (sanitizeLiveScanStateShape, just below)
        // close every KNOWN wrong-shape variant found so far. But a reviewer has now found this class
        // of bug FOUR times - the only way to guarantee the TOP-LEVEL LAW against a still-unknown
        // variant is to make processScan itself structurally incapable of letting a throw escape
        // without first committing a safe row. FINDING 1 (independent Codex clean-room review,
        // 2026-08-16): the try used to start AFTER session initialization (ensureAutoSession, which
        // calls getOrCreateDeviceId -> raw localStorage.getItem/setItem) - a throw there (Safari private
        // mode, blocked cookies, full quota) escaped processScan entirely with no Layer C log, no
        // fallback row, no count. The try now starts at the very top of this action so NOTHING in its
        // synchronous body - including session init - sits outside the safety net. `cleanedCaught` and
        // `scanEventIdCaught` are hoisted `let`s (assigned inside the try, never re-declared) purely so
        // the catch can still identify which physical scan needs recovering.
        let cleanedCaught: ReturnType<typeof cleanScanCode> | undefined;
        let scanEventIdCaught: string | undefined;
        try {
        // TOP-LEVEL LAW / Phase 3 defect F1: a scanned code must ALWAYS appear on the feed and count,
        // even when the current session is locked (owner PIN) or completed (Finish). Those guards
        // decide the session's own frozen/read-only status; they must never make a physical scan
        // vanish. So instead of dropping the scan, ROTATE to a fresh active session and count it
        // there - reusing the exact mechanism ensureAutoSession/mount already use for a stale/absent
        // session - leaving the locked/completed session and its counts untouched and auditable.
        // Callers (the scan page) also call ensureAutoSession before every scan batch; this is the
        // hard backstop for any path (including the internal resolveUnknown -> processScan re-apply
        // call) that does not.
        if (!get().sessionId || !get().currentSession || get().currentSession?.locked || get().currentSession?.status === "completed") {
          get().ensureAutoSession();
        }
        const scanLocation = get().location;
        const scanDeviceId = get().deviceId;
        const cleaned = cleanScanCode(rawInput);
        cleanedCaught = cleaned;
        if (!cleaned.cleanCode) return null;

        // LAYER B (persist-corruption defect, 2026-08-13): defense in depth alongside LAYER A's persist
        // `merge` sanitizer above. `ensureProvisionalCount`'s ordering already enforces the TOP-LEVEL
        // LAW that every scan appears + counts - but that guarantee only holds if nothing BEFORE (or
        // called FROM) it can throw. `products`/`aliases` are filtered/mapped/found across the resolver,
        // the alias matcher, AND ensureProvisionalCount itself (all reading live store state via get()),
        // so a wrong-shape value reaching this far - from any future path, not just the persist boundary
        // LAYER A already closes - would throw somewhere in that chain and silently drop the scan.
        // Sanitize the STORE STATE itself (not just a local copy) so every subsequent get() in this
        // call, including nested action calls like ensureProvisionalCount, sees well-shaped data too.
        // Loudly logged, never silently swallowed.
        const stateShapeIssues = sanitizeLiveScanStateShape();
        if (stateShapeIssues.length > 0) {
          console.error(
            `[scanStore] processScan: store state had wrong-shape field(s) (${stateShapeIssues.join(", ")}); ` +
              `reset to [] so this scan still appears and counts (TOP-LEVEL LAW).`,
          );
        }
        const { products, aliases, businessId, sessionId } = get();
        // Deterministic resolver only. AI is never consulted here. Known requires verified/approved.
        // Wrapped: any unexpected throw inside resolution degrades this scan to "unidentified" (still
        // appears + counts via the needs_review path below) instead of propagating out of processScan
        // and silently dropping the row.
        let resolution: ResolverResult;
        try {
          resolution = resolveScan(cleaned, products, aliases, businessId);
        } catch (err) {
          console.error(
            `[scanStore] resolveScan threw for code '${cleaned.cleanCode}'; degrading to unidentified ` +
              `so the scan still appears and counts (TOP-LEVEL LAW).`,
            err,
          );
          resolution = {
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            codeType: "messy",
            resolverStatus: "needs_review",
            matchType: "unknown",
            productId: null,
            confidence: 0,
            reason: "Internal error while resolving this code; it was routed to Needs Review as unidentified.",
          };
        }
        const scanEventId = idFactory();
        scanEventIdCaught = scanEventId;
        const createdAt = now();
        const keyFor = (op: SyncOperation) =>
          buildIdempotencyKey(businessId, sessionId, scanEventId, op);

        const isKnown = resolution.resolverStatus === "known" && !!resolution.productId;
        // Phase 8C SIDE-DOOR FIREWALL: a deterministic "known" match (approved alias or verified product)
        // can still carry a POISONED identity - e.g. a verified product whose primaryBarcode is a tire UPC
        // that a public source mislabels as a rivet kit. The original firewall only ran inside the AI
        // decode path, so such a match would auto-count with NO AI and NO firewall. Re-check the matched
        // product's domain against the scan context; on conflict it must NOT count -> route to Needs Review.
        const matchedProduct = resolution.productId
          ? products.find((p) => p.id === resolution.productId)
          : undefined;
        const knownConflict = isKnown
          ? detectIdentityContextConflict(get().settings.scanContext ?? "any", matchedProduct)
          : null;
        const countable = isKnown && !knownConflict;
        // PHASE 2 re-scan dedup: the deterministic resolver only returns "known" for an APPROVED alias /
        // VERIFIED product. A weak AI suggestion is counted as a PROVISIONAL product (verified:false, NO
        // approved alias), which the resolver intentionally misses - so a re-scan would re-decode / duplicate.
        // Bridge it deterministically: if a STILL-COUNTED, UNVERIFIED product carries this exact code as an
        // identifier, count THAT product (exact identifier match only, never fuzzy, no AI). A human approval
        // later flips it verified + approved, after which the resolver matches it as a normal Known.
        let provMatchId: string | null = null;
        if (!countable && !knownConflict) {
          const countedIds = new Set(get().finalCounts.map((c) => c.productId));
          const ids = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          provMatchId =
            products.find(
              (p) =>
                countedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).some((c) => !!c && ids.includes(c)),
            )?.id ?? null;
        }
        const pendingTrustedExactReview = provMatchId
          ? get().needsReviewQueue.find(
              (review) =>
                trustedExactProbeReviewIds.has(review.id)
                && review.provisionalProductId === provMatchId
                && review.sessionId === sessionId
                && review.cleanCode === cleaned.cleanCode
                && review.status === "open"
                && review.decodeStatus === "decoding",
            ) ?? [...trustedExactProbes.values()].find(
              (probe) =>
                probe.provisionalProductId === provMatchId
                && probe.sessionId === sessionId
                && probe.cleanCode === cleaned.cleanCode,
            )
          : undefined;
        const effectiveProductId = resolution.productId ?? provMatchId;
        const effectiveCountable = countable || !!provMatchId;
        if (knownConflict === "category_context_conflict") {
          // Phase 9: surface the non-blocking category warning banner (the scan still routes to review).
          set({ lastCategoryWarning: { code: cleaned.cleanCode, productName: matchedProduct?.name ?? "this product", reason: knownConflict } });
        }

        const event: ScanEvent = stampScanEventLocation(
          {
            id: scanEventId,
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            matchedProductId: effectiveProductId,
            matchType: resolution.matchType,
            status: effectiveCountable ? "known" : resolution.resolverStatus === "conflict" ? "conflict" : "needs_review",
            resolverStatus: resolution.resolverStatus,
            codeType: resolution.codeType,
            reason: pendingTrustedExactReview?.reason
              ?? (provMatchId ? "Counted (suggested - awaiting your confirmation)." : resolution.reason),
            decodeStatus: pendingTrustedExactReview ? "decoding" : provMatchId ? "suggested" : undefined,
            quantityDelta: effectiveCountable ? 1 : 0,
            quantityAfterScan: 0,
            createdAt,
            source: "scan",
            notes: resolution.reason,
            syncStatus: "pending",
            idempotencyKey: keyFor("INCREMENT_COUNT"),
            syncError: null,
          },
          scanLocation,
          scanDeviceId,
        );

        // BEST GUESS ON EVERY SCAN OF THE CODE (owner decision 2026-08-19): a repeat scan of a code whose
        // best guess is already on screen carries the SAME pending suggestion (and its confirm controls)
        // onto this new row, instead of a bare row with no identity. Display only - the decode that
        // produced it settled long ago, so this costs nothing and re-decodes nothing.
        // Never on a deterministically KNOWN row: that identity is settled, a guess would only muddy it.
        const awaitingReview = isKnown
          ? undefined
          : get().needsReviewQueue.find(
              (r) =>
                r.cleanCode === cleaned.cleanCode &&
                (r.status === "open" || r.status === "suggested") &&
                isUsableProductName(r.suggestedProductName),
            );
        if (awaitingReview) {
          event.suggestion = {
            productName: awaitingReview.suggestedProductName,
            brand: awaitingReview.suggestedBrand,
            confidence: awaitingReview.confidence,
            // No status passed: a review still awaiting a human is by definition not a verified identity.
            band: getIdentityConfidenceBand({
              confidence: awaitingReview.confidence,
              evidenceStrength: awaitingReview.evidenceStrength,
              exactCodeEvidenceVerifiedByApp: awaitingReview.exactCodeEvidenceVerifiedByApp,
            }),
            status: "pending",
          };
        }

        if (effectiveCountable && effectiveProductId) {
          // Deterministic increment in local state FIRST (instant UI, no server round-trip).
          const { counts, count } = incrementInventoryCount(get().finalCounts, event, idFactory);
          event.quantityAfterScan = count.quantity;

          set((s) => ({
            scanFeed: [event, ...s.scanFeed],
            finalCounts: counts.map((c) =>
              c.productId === event.matchedProductId && c.sessionId === event.sessionId
                ? { ...c, location: scanLocation }
                : c,
            ),
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();

          const incPayload: IncrementPayload = {
            businessId,
            sessionId,
            productId: effectiveProductId,
            scanEventId,
            quantityDelta: 1,
            idempotencyKey: keyFor("INCREMENT_COUNT"),
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "ScanEvent",
              entityId: scanEventId,
              operation: "SAVE_SCAN_EVENT",
              payload: event,
              idempotencyKey: keyFor("SAVE_SCAN_EVENT"),
              scanEventId,
            }),
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "InventoryCount",
              entityId: count.id,
              operation: "INCREMENT_COUNT",
              payload: incPayload,
              idempotencyKey: keyFor("INCREMENT_COUNT"),
              scanEventId,
            }),
          ]);
          return event;
        }

        if (isKnown && knownConflict && resolution.productId) {
          // SIDE-DOOR FIREWALL block: the matched product contradicts the tire scan context (a poisoned
          // identity reached via the deterministic path). Do NOT count. Surface it for human relink,
          // carrying the suspect product so the owner sees what it WOULD have been. No AI is run here -
          // re-decoding would just return the same poisoned public source.
          const conflictText = conflictReason(knownConflict);
          event.decodeStatus = "needs_review";
          event.reason = conflictText;
          event.notes = conflictText;
          set((s) => ({ scanFeed: [event, ...s.scanFeed] }));
          const alreadyOpen = get().needsReviewQueue.find(
            (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
          );
          if (!alreadyOpen) {
            const review: UnknownCodeReview = {
              id: idFactory(),
              businessId,
              sessionId,
              rawCode: cleaned.rawCode,
              cleanCode: cleaned.cleanCode,
              normalizedCandidates: cleaned.normalizedCandidates,
              suggestedProductName: matchedProduct?.name ?? "",
              suggestedBrand: matchedProduct?.brand ?? "",
              suggestedCategory: matchedProduct?.category ?? "",
              suggestedSpecsShort: matchedProduct?.specsShort ?? "",
              suggestedSpecsFull: matchedProduct?.specsFull ?? "",
              suggestedPrimarySku: matchedProduct?.primarySku ?? "",
              suggestedPrimaryBarcode: matchedProduct?.primaryBarcode ?? "",
              suggestedGtin: matchedProduct?.gtin ?? "",
              suggestedUpc: matchedProduct?.upc ?? "",
              suggestedEan: matchedProduct?.ean ?? "",
              suggestedImageUrl: "",
              suggestedProductUrl: "",
              suggestedAliases: [],
              sourceUrls: [],
              verifiedFacts: [],
              guesses: [],
              reason: conflictText,
              providerName: "",
              confidence: 0,
              hasSuggestion: !!matchedProduct,
              decodeStatus: "needs_review",
              evidenceStrength: "none",
              exactCodeEvidenceVerifiedByApp: false,
              crossCheckDecision: "",
              status: "open",
              createdAt,
              resolvedAt: null,
              resolvedBy: null,
              resolutionAction: null,
              syncStatus: "pending",
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
            };
            set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "UnknownCodeReview",
                entityId: review.id,
                operation: "SAVE_UNKNOWN_SCAN",
                payload: review,
                idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
                scanEventId,
              }),
            ]);
            emitAudit({
              entityType: "UnknownCodeReview",
              entityId: review.id,
              action: "context_conflict_blocked",
              metadata: { code: cleaned.cleanCode, productId: resolution.productId, kind: knownConflict },
            });
          }
          // OWNER RULE "scan N = count N": even a known-but-context-conflicted scan must COUNT (the physical
          // item is on the shelf). Count it provisionally against a SAFE "Unidentified item" placeholder -
          // never against the suspect/poisoned matched product - and keep the review open so a human confirms
          // the real identity. ensureProvisionalCount is idempotent PER CODE (mints the placeholder once and
          // counts it once) - it never counts a REPEAT physical scan of the same conflicted code (F-02,
          // TOP-LAW). Detect a repeat the same way the provMatchId bridge does for non-conflict provisionals
          // (2208-2222): if a safe placeholder for this code is ALREADY counted, mint a FRESH counting event
          // (this scan's own scanEventId + idempotency keys) directly against that placeholder - never
          // against the poisoned resolution.productId - so N repeated conflict scans produce N counts.
          const conflictCandidates = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          const conflictCountedIds = new Set(get().finalCounts.map((c) => c.productId));
          const repeatPlaceholderId =
            get().products.find(
              (p) =>
                conflictCountedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku]
                  .map((c) => (c ?? "").trim())
                  .some((c) => !!c && conflictCandidates.includes(c)),
            )?.id ?? null;
          if (repeatPlaceholderId) {
            const repeatEvent: ScanEvent = {
              ...event,
              matchedProductId: repeatPlaceholderId,
              status: "known",
              quantityDelta: 1,
              decodeStatus: "suggested",
            };
            const { counts, count } = incrementInventoryCount(get().finalCounts, repeatEvent, idFactory);
            repeatEvent.quantityAfterScan = count.quantity;
            set((s) => ({
              scanFeed: s.scanFeed.map((e) => (e.id === repeatEvent.id ? repeatEvent : e)),
              finalCounts: counts.map((c) =>
                c.productId === repeatEvent.matchedProductId && c.sessionId === repeatEvent.sessionId
                  ? { ...c, location: scanLocation }
                  : c,
              ),
            }));
            // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
            markFirstScanIfNeeded();
            const repeatIncPayload: IncrementPayload = {
              businessId,
              sessionId,
              productId: repeatPlaceholderId,
              scanEventId,
              quantityDelta: 1,
              idempotencyKey: keyFor("INCREMENT_COUNT"),
            };
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "ScanEvent",
                entityId: scanEventId,
                operation: "SAVE_SCAN_EVENT",
                payload: repeatEvent,
                idempotencyKey: keyFor("SAVE_SCAN_EVENT"),
                scanEventId,
              }),
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "InventoryCount",
                entityId: count.id,
                operation: "INCREMENT_COUNT",
                payload: repeatIncPayload,
                idempotencyKey: keyFor("INCREMENT_COUNT"),
                scanEventId,
              }),
            ]);
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
            return repeatEvent;
          }
          get().ensureProvisionalCount(cleaned.cleanCode, conflictText);
          // STABLE-ID FIX: the placeholder now exists (minted just above); stamp its id onto this review
          // (new or pre-existing open one) so resolveUnknown can re-link by id after a customer reload
          // instead of by reconstructed name (see provisionalProductId doc comment in types.ts).
          const conflictPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          if (conflictPlaceholder) {
            set((s) => ({
              needsReviewQueue: s.needsReviewQueue.map((r) =>
                r.cleanCode === cleaned.cleanCode && r.status === "open" && !r.provisionalProductId
                  ? { ...r, provisionalProductId: conflictPlaceholder.id }
                  : r,
              ),
            }));
          }
          get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          return event;
        }

        // Unknown or conflict. AGGRESSIVE AUTO DECODE: if AI is on and a key is configured, run the
        // live decode pipeline automatically instead of dropping straight to passive Needs Review.
        const settings = get().settings;
        const today = createdAt.slice(0, 10);
        const dailyCount = settings.lastResetDate === today ? settings.dailyLookupCount : 0;
        let autoGate = evaluateAutoDecode({
          aiEnabled: settings.aiLookupEnabled,
          status: get().aiStatus,
          online: get().online,
          dailyCount,
          dailyLimit: settings.dailyLookupLimit,
          breaker: get().breaker,
          now: new Date(createdAt).getTime(),
          platformOwner: isPlatformOwnerForGateBypass(get().userId),
        });
        // A3 (owner-ratified 2026-07-15, narrowed by AM-2): a code whose GS1 check digit fails can
        // never decode via any GTIN rung (Go-UPC/fetchV2/GPT all key off the code) - dispatching the
        // ladder here only burns time and cap budget chasing a doomed lookup. Skip auto-decode
        // entirely; the row stays a normal, aliasable needs_review row (never "decoding") with the
        // additive misread reason already set by the resolver. Overriding here (rather than after
        // row creation) keeps decodeStatus honest from the very first render - never "decoding" then
        // silently reverted. A valid unknown GTIN is never affected by this check.
        // QA HARDENING FIX #6 (live-proven): captured once and reused below at the catalog-first seam -
        // a misread code must never mint a fabricated identity there either (see that call site).
        const misread = isLikelyMisreadGtin(cleaned.cleanCode);
        if (misread) {
          autoGate = { allowed: false, reason: "Scan misread - decode was not attempted." };
        }
        const deterministicCandidate = trustedExactProbeCandidate(cleaned.cleanCode);
        const deterministicLookupEligible = trustedExactProbeEnabled
          && get().online
          && deterministicCandidate;
        const lookupPending = autoGate.allowed || deterministicLookupEligible;

        const existingOpen = get().needsReviewQueue.find(
          (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
        );

        // Customer-safe split: the feed REASON is the deterministic resolver explanation only (product-
        // facing, no AI/provider/Settings mechanics). The auto-decode "why" (e.g. lookup not configured)
        // goes to decodeNote, which LiveScanFeed shows ONLY to platformOwner. The internal gate reason
        // text is unchanged (still used for aiLookupLogs/diagnostics).
        event.decodeStatus = existingOpen?.decodeStatus ?? (lookupPending ? "decoding" : "needs_review");
        event.reason = existingOpen?.reason ?? resolution.reason;
        event.decodeNote = existingOpen?.decodeNote ?? autoGate.reason;

        set((s) => ({ scanFeed: [event, ...s.scanFeed] }));

        // OWNER RULE "scan N = count N": count EVERY unresolved scan immediately, synchronously, before any
        // network work. The AI/catalog lookup below only ENRICHES this provisional row (name/verified); it
        // can never again decide whether the scan counts. ensureProvisionalCount is idempotent, so the later
        // decode handlers (which filter on status !== "known") find nothing to re-count.
        get().ensureProvisionalCount(cleaned.cleanCode, resolution.reason);

        if (deterministicLookupEligible) {
          // Repeats share the in-flight probe, while each physical scan has already received its own
          // synchronous feed/count event above.
          if (trustedExactProbeIdsByCode.has(cleaned.cleanCode)) return event;
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          const probe: UnknownCodeReview = {
            id: idFactory(), businessId, sessionId, rawCode: cleaned.rawCode, cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "", suggestedBrand: "", suggestedCategory: "", suggestedSpecsShort: "", suggestedSpecsFull: "",
            suggestedPrimarySku: "", suggestedPrimaryBarcode: "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
            suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
            reason: resolution.reason, decodeNote: autoGate.reason, providerName: "", confidence: 0, hasSuggestion: false,
            decodeStatus: "decoding", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
            status: "open", createdAt, resolvedAt: null, resolvedBy: null, resolutionAction: null, syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"), provisionalProductId: mintedPlaceholder?.id ?? null,
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
          };
          trustedExactProbes.set(probe.id, probe);
          trustedExactProbeIdsByCode.set(probe.cleanCode, probe.id);
          trustedExactProbeReviewIds.add(probe.id);
          void get().liveDecode(probe.id, {
            deterministicOnly: true,
            invalidationGeneration: trustedExactProbeGeneration,
          }).then(
            () => trustedExactProbeReviewIds.delete(probe.id),
            () => trustedExactProbeReviewIds.delete(probe.id),
          );
          return event;
        }

        if (!existingOpen) {
          // STABLE-ID FIX: ensureProvisionalCount just ran synchronously above, so this code's placeholder
          // product (if one was minted) already exists in state. Capture its id now so resolveUnknown can
          // re-link this review to it by id later, even after a customer reload strips the placeholder's
          // `provisional` flag and identifier fields (see provisionalProductId doc comment in types.ts).
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          const review: UnknownCodeReview = {
            id: idFactory(),
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "",
            suggestedBrand: "",
            suggestedCategory: "",
            suggestedSpecsShort: "",
            suggestedSpecsFull: "",
            suggestedPrimarySku: "",
            suggestedPrimaryBarcode: "",
            suggestedGtin: "",
            suggestedUpc: "",
            suggestedEan: "",
            suggestedImageUrl: "",
            suggestedProductUrl: "",
            suggestedAliases: [],
            sourceUrls: [],
            verifiedFacts: [],
            guesses: [],
            reason: resolution.reason,
            decodeNote: autoGate.reason,
            providerName: resolution.resolverStatus === "conflict" ? "conflict" : "",
            confidence: 0,
            hasSuggestion: false,
            decodeStatus: lookupPending ? "decoding" : "needs_review",
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            crossCheckDecision: "",
            status: "open",
            createdAt,
            resolvedAt: null,
            resolvedBy: null,
            resolutionAction: null,
            syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
            provisionalProductId: mintedPlaceholder?.id ?? null,
            // QA Task 8 (owner-approved 2026-07-15): review-only "Did you mean <X>?" near-match SKU
            // suggestion from the deterministic resolver (distance<=1, single candidate only - see
            // resolver.ts findNearMatchSuggestion). Reuses the EXACT same one-tap "Link to <product>"
            // UI/path as the identity-merge suggest_link (NeedsReviewTable's suggestedLinkProductId),
            // which already routes exclusively through the human-approved link_existing action. This
            // NEVER auto-counts and NEVER auto-aliases - resolverStatus/decodeStatus above are
            // untouched (still a normal needs_review row awaiting a human).
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
          };
          set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "UnknownCodeReview",
              entityId: review.id,
              operation: "SAVE_UNKNOWN_SCAN",
              payload: review,
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
              scanEventId,
            }),
          ]);
          emitAudit({ entityType: "UnknownCodeReview", entityId: review.id, action: "unknown_review_created", metadata: { code: cleaned.cleanCode } });

          if (resolution.resolverStatus === "conflict") {
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          }

          // Every trusted-exact candidate gets the isolated deterministic-only request first. A valid
          // GTIN miss may later enter the unchanged ordinary queue; non-GTIN, misread, and gate-blocked
          // misses remain counted/reviewable without provider egress.
          // CATALOG-FIRST (offline-first, saves AI tokens): private shop override -> verified shared
          // catalog. A verified hit resolves + counts with NO AI, even with no key / offline. AI only
          // runs on a miss or a weak/conflicting catalog hit.
          // QA HARDENING FIX #6 (live-proven, 2026-07-16): a misread (bad-check-digit) GTIN must NEVER
          // attach a fabricated identity here either. `codeSet.has(entry.normalizedBarcode)` in
          // localCatalogProvider.ts has no check-digit awareness, so a bad code that happens to
          // string-match a seeded catalog entry's normalizedBarcode (e.g. a coincidental zero-pad
          // collision) would otherwise mint a named product via resolveUnknown("create_new",
          // {origin:"catalog"}) - the exact bug that attached "Healthyholics" to an invalid UPC. Skip
          // computing `decision` entirely when misread (cleaner than gating the `if` below): this also
          // avoids polluting the catalog's timesScanned/observeScan bookkeeping with a bad-code hit.
          // The row already fell through to needs_review with the honest misread reason set above.
          const codes = [cleaned.cleanCode, ...cleaned.normalizedCandidates];
          const decision = misread
            ? { source: "none" as const, hit: null, shouldResolveWithoutAi: false, shouldTryAi: true }
            : decideLookup(get().catalog, get().shopOverrides, codes, businessId);
          // Phase 8C: a verified-catalog / shop-override hit is also a NON-AI auto-count path - apply the
          // same context firewall. A clearly non-tire hit in tire context must not shortcut-count; let it
          // fall through to the AI decode path (where the firewall + human review handle it).
          const catalogConflict = decision.hit
            ? detectIdentityContextConflict(get().settings.scanContext ?? "any", decision.hit)
            : null;
          if (decision.shouldResolveWithoutAi && decision.hit && !catalogConflict) {
            const fromOverride = decision.source === "shop_override";
            get().recordFeedback(fromOverride ? "found_from_override" : "found_from_catalog", {
              code: cleaned.cleanCode,
            });
            if (decision.source === "verified_catalog") {
              set({ catalog: observeScan(get().catalog, codes, now()) });
            }
            get().markFeedRowVerified(
              cleaned.cleanCode,
              `Matched from ${fromOverride ? "shop override" : "verified catalog"} - no AI used.`,
            );
            get().resolveUnknown(review.id, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: decision.hit.name,
                brand: decision.hit.brand,
                category: decision.hit.category,
                imageUrl: decision.hit.imageUrl,
                productUrl: decision.hit.productUrl,
                primaryBarcode: cleaned.cleanCode,
                source: "catalog",
              },
            });
            return event;
          }

          // Fall back to live AI decode (subject to the existing gate). A human still approves anything
          // not auto-accepted. AI is never called for a known/approved scan or a verified catalog hit.
          // Option 1 wiring: if the cloud dep is present and we're online, try the global catalog first;
          // cloudCatalogResolve falls through to AI internally on a miss / firewall conflict.
          if (deps.lookupGlobalCatalog && get().online) {
            // FIX 5: swallow a rejection here (e.g. a dev-assert throw from the GC1 hard invariant)
            // so it never becomes an unhandled promise rejection - siblings already do this (line ~1138).
            void get().cloudCatalogResolve(review.id, codes).catch(() => {});
          } else if (autoGate.allowed) {
            void get().liveDecode(review.id);
          } else {
            // AI decode SKIPPED. Only fire the provisional fallback when decode was INTENDED but blocked
            // by a TRANSIENT cause (circuit breaker, rate-limit, offline, cap). When AI is explicitly
            // disabled or keys are missing, the scan goes to Needs Review without a provisional count
            // (the user chose not to decode — do not fabricate a product).
            const s = get();
            const aiIntended = s.settings.aiLookupEnabled && s.aiStatus.openaiConfigured;
            if (aiIntended) {
              get().applyDecodeFallback(
                review.id,
                `${autoGate.reason ?? "AI decode unavailable."} Counted as unverified; retry to identify.`.trim(),
              );
            }
          }
        }
        return event;
        } catch (outerErr) {
          // LAYER C catch: log loudly (never silently swallowed) and guarantee the row still appears
          // and counts. ensureProvisionalCount is idempotent - if a scanFeed row for this code was
          // already committed by an earlier branch before the throw, it repoints THAT row instead of
          // minting a duplicate; if none exists yet, it mints both the safe placeholder product and a
          // synthetic backing scanFeed row so the physical scan is never lost.
          //
          // FINDING 1 continued: `cleanedCaught` may still be unset (the throw happened before it was
          // ever assigned, e.g. inside ensureAutoSession/getOrCreateDeviceId before the fail-soft fix,
          // or some still-unknown FIFTH variant). cleanScanCode is pure and cheap - recompute it here,
          // defensively, so this recovery path still has a code to recover even in that case.
          let recoveredCleanCode: string;
          try {
            recoveredCleanCode = cleanedCaught ? cleanedCaught.cleanCode : cleanScanCode(rawInput).cleanCode;
          } catch (cleanErr) {
            console.error(
              `[scanStore] processScan: even recomputing the clean code failed for raw input; the scan ` +
                `cannot be recovered. This is the true last resort.`,
              cleanErr,
            );
            recoveredCleanCode = "";
          }
          console.error(
            `[scanStore] processScan: unexpected error while processing code '${recoveredCleanCode}'; ` +
              `routing to Needs Review as unidentified so the scan still appears and counts (TOP-LEVEL LAW).`,
            outerErr,
          );
          if (!recoveredCleanCode) {
            return get().scanFeed[0] ?? null;
          }
          try {
            get().ensureProvisionalCount(
              recoveredCleanCode,
              "Internal error while processing this scan; it was routed to Needs Review as unidentified.",
              // FINDING 2 FIX: pass THIS scan's own event id so ensureProvisionalCount's idempotent
              // shortcut cannot be fooled by an unrelated/stale existing count for the same code - see
              // its doc comment. Only meaningful when scanEventId was actually minted before the throw.
              scanEventIdCaught ? { verifyEventId: scanEventIdCaught } : undefined,
            );
          } catch (fallbackErr) {
            // True last resort: even the safe fallback path itself threw. Still never rethrow out of
            // processScan (that would be the original silent-drop defect all over again) - log and
            // return whatever the feed already shows for this code, if anything.
            console.error(
              `[scanStore] processScan: fallback ensureProvisionalCount ALSO threw for code ` +
                `'${recoveredCleanCode}'; the scan may not have counted. This is the true last resort.`,
              fallbackErr,
            );
          }
          // FINDING 3 (recovery must prove itself, not just claim success): assert a committed feed row
          // AND ledger application actually exist for THIS scan before calling the recovery successful.
          // A caller (or a human reading the log) must be able to tell "recovered" apart from "lost" -
          // returning an older same-code row as if it were proof of success is exactly how the original
          // loss stayed invisible.
          const recoveredState = get();
          const ownRecoveredRow = scanEventIdCaught
            ? recoveredState.scanFeed.find((e) => e.id === scanEventIdCaught)
            : recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode);
          const ledgerHasOwnEvent =
            !!ownRecoveredRow &&
            recoveredState.finalCounts.some(
              (c) => c.productId === ownRecoveredRow!.matchedProductId && Array.isArray(c.scanEventIds) && c.scanEventIds.includes(ownRecoveredRow!.id),
            );
          if (!ownRecoveredRow || !ledgerHasOwnEvent) {
            console.error(
              `[scanStore] processScan: LAYER C RECOVERY FAILED for code '${recoveredCleanCode}' ` +
                `(scanEventId=${scanEventIdCaught ?? "unminted"}) - no feed row and/or ledger entry for THIS ` +
                `scan exists after the fallback ran. This scan may not have counted. Do not treat the ` +
                `return value of this call as proof of success.`,
            );
          }
          return ownRecoveredRow ?? recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode) ?? null;
        }
      },

      syncPending: (force = false) => {
        // Cloud backend: async drain (preserves the local optimistic UI; never blocks the scan input).
        if (cloudBackend) {
          void syncPendingCloud(force);
          return;
        }
        const state = get();
        if (!state.online && !force) return; // offline: keep everything pending, lose nothing
        if (state.pendingSyncQueue.length === 0) return;

        db.setFailure(state.simulateSyncFailure ? "always" : "none");

        const stillPending: PendingSyncItem[] = [];
        const syncedIds = new Set(state.syncedScanEventIds);
        let lastErr: string | null = null;

        for (const item of state.pendingSyncQueue) {
          // This branch only runs for the local mock backend (cloudBackend === false), whose apply() is
          // synchronous, so the cast is safe.
          const res = db.apply(item) as SyncResult;
          if (res.ok) {
            if (item.scanEventId) syncedIds.add(item.scanEventId);
          } else {
            stillPending.push({
              ...item,
              status: "error",
              retryCount: item.retryCount + 1,
              lastError: res.error ?? "sync failed",
              updatedAt: now(),
            });
            lastErr = res.error ?? "sync failed";
          }
        }

        const recomputed = recomputeSyncStatus({
          businessId: state.businessId,
          scanFeed: state.scanFeed,
          finalCounts: state.finalCounts,
          needsReviewQueue: state.needsReviewQueue,
          pendingSyncQueue: stillPending,
        });

        set({
          pendingSyncQueue: stillPending,
          syncedScanEventIds: [...syncedIds],
          lastSyncError: lastErr,
          ...recomputed,
        });
      },

      // Explicit user-facing retry: re-arm any items quarantined by a terminal failure (e.g. Firestore
      // permission-denied) so this drain can re-attempt them. Automatic drains (timer/online/enqueue)
      // intentionally keep skipping "quarantined" status - only this explicit action re-attempts a
      // terminal failure, so a fix to the underlying cause (e.g. a rules bug) is not stranded forever.
      // syncError is preserved until a successful apply clears it (see the ok-branch in drainCloudOnce).
      retrySync: () => {
        set((cur) => ({
          pendingSyncQueue: cur.pendingSyncQueue.map((item) =>
            item.status === "quarantined" ? { ...item, status: "error" } : item,
          ),
        }));
        get().syncPending(true);
      },

      setOnline: (online) => {
        set({ online });
        if (online) get().syncPending(true);
      },

      setSimulateSyncFailure: (on) => set({ simulateSyncFailure: on }),

      setAiStatus: (partial) => set((s) => ({ aiStatus: { ...s.aiStatus, ...partial } })),

      setEmergencyStop: (on) => set((s) => ({ aiStatus: { ...s.aiStatus, emergencyStop: on } })),

      refreshAiStatus: async () => {
        // Ask the server which keys/flags are configured (no secrets are returned).
        try {
          const res = await fetch("/api/ai-lookup", { method: "GET" });
          if (!res.ok) {
            // Silent-failure fix: a failed refresh must never be indistinguishable from a confirmed
            // "kill switch off" - mark the status unknown/stale rather than leaving a false "off".
            set((s) => ({ aiStatus: { ...s.aiStatus, killSwitchStatusUnknown: true } }));
            return;
          }
          const d = await res.json();
          set((s) => {
            const keyConfigured = Boolean(d.openaiConfigured);
            return {
              aiStatus: {
                ...s.aiStatus,
                liveEnabled: Boolean(d.liveEnabled),
                autoDecodeOnScan: Boolean(d.autoDecodeOnScan),
                openaiConfigured: Boolean(d.openaiConfigured),
                dailyLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.aiStatus.dailyLimit,
                missingKeys: Array.isArray(d.missingKeys) ? d.missingKeys : s.aiStatus.missingKeys,
                // Task 8: the real ladder order. Gemini is permanently out of decode and the server no
                // longer reports any Gemini flag, model, or key.
                decodeLadder: Array.isArray(d.decodeLadder) ? d.decodeLadder : s.aiStatus.decodeLadder,
                // Spec 2 (M1): server-authoritative, same as every other flag in this block - a stale
                // client value must never mask a live server kill switch, and an omitted field (older/
                // mocked GET response) correctly defaults to false (not on).
                killSwitchOn: Boolean(d.killSwitchOn),
                // A successful refresh always confirms fresh truth - clear any prior unknown/stale flag.
                killSwitchStatusUnknown: false,
                gptLadder:
                  d.gptLadder && typeof d.gptLadder === "object"
                    ? {
                        spentTodayUsd: Number(d.gptLadder.spentTodayUsd) || 0,
                        capUsd: Number(d.gptLadder.capUsd) || 0,
                        callsToday: Number(d.gptLadder.callsToday) || 0,
                        enabled: Boolean(d.gptLadder.enabled),
                      }
                    : s.aiStatus.gptLadder,
              },
              // Live AI config is SERVER-AUTHORITATIVE so a stale persisted client value can't disable lookup
              // or pin an old daily cap. When the server confirms a provider key, force lookup ON (always-on)
              // and adopt the server daily cap (AI_LOOKUP_DAILY_LIMIT).
              settings: {
                ...s.settings,
                aiLookupEnabled: keyConfigured ? true : s.settings.aiLookupEnabled,
                dailyLookupLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.settings.dailyLookupLimit,
              },
            };
          });
        } catch {
          // Leave existing status; auto-decode simply won't fire without confirmed keys. But do not
          // leave killSwitchOn silently reading as a confirmed false "off" - a transient network
          // failure must surface as unknown/stale, not as reassurance that the kill switch is off.
          set((s) => ({ aiStatus: { ...s.aiStatus, killSwitchStatusUnknown: true } }));
        }
      },

      updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

      cloudCatalogResolve: async (reviewId, codes) => {
        if (!deps.lookupGlobalCatalog) return;
        let entry: CatalogEntry | null = null;
        try {
          entry = await deps.lookupGlobalCatalog(codes);
        } catch {
          // Cloud lookup failure must never break the scanner. Fall through to AI.
        }
        // Re-read review after the async round-trip: the user may have already resolved it.
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;

        // Phase 5b Task 4 (AC4/GC1/GC9): before applying a master-catalog hit, check whether the
        // master identity DISAGREES with a tenant product this account already has resolvable for
        // this code. toMasterCandidates only ever emits a non-empty candidate when a tenant
        // candidate existed first (GC1 hard invariant) - see masterCandidates.ts. Agreement or no
        // tenant candidate falls through to existing behavior, byte-identical.
        if (entry && entry.masterId) {
          const cleanedForCandidates = { rawCode: review.rawCode, cleanCode: review.cleanCode, normalizedCandidates: review.normalizedCandidates };
          const master = get();
          const masterCandidates = toMasterCandidates(
            { masterId: entry.masterId, name: entry.name, brand: entry.brand, masterProvenanceTier: entry.masterProvenanceTier },
            master.products,
            master.aliases,
            cleanedForCandidates,
            master.businessId,
          );
          const loneMasterCandidate = masterCandidates.length > 0 && masterCandidates.every((c) => c.productId.startsWith("master:"));
          if (loneMasterCandidate) {
            // HARD INVARIANT (GC1/review F3): toMasterCandidates guarantees this only happens when a
            // tenant candidate already resolved for this code (it never emits a lone "master:"
            // candidate for a code with zero tenant candidates). Dev-assert the invariant holds;
            // never throw in prod (a violated assumption here must never crash a scan).
            if (process.env.NODE_ENV !== "production") {
              const tenantOnlyCheck = resolveScanToProductTiered(cleanedForCandidates, { products: master.products, aliases: master.aliases, masterCandidates: [] }, master.businessId);
              if (!tenantOnlyCheck.productId) {
                throw new Error("toMasterCandidates invariant violated: lone master: candidate with no tenant-origin candidate");
              }
            }
            const tiered = resolveScanToProductTiered(cleanedForCandidates, { products: master.products, aliases: master.aliases, masterCandidates }, master.businessId);
            if (tiered.matchType === "conflict") {
              const conflictReasonText = "Cross-tier conflict: master catalog identity disagrees with this account's product";
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, reason: conflictReasonText } : r)),
                // Match by cleanCode + not-yet-resolved (same guard shape as markFeedRowVerified above) -
                // the row here is the scan's own provisional placeholder (status "known" against that
                // placeholder, per TOP-LEVEL LAW), never a real approved-alias match: the review is still
                // open, so this code has no trusted resolution yet.
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.status !== "resolved"
                    ? { ...e, decodeStatus: "needs_review" as const, reason: conflictReasonText }
                    : e,
                ),
              }));
              // Identity-only outcome (GC9/TOP-LEVEL LAW): the row already appeared and counted
              // synchronously before this async resolve ran. Skip the enrichment apply below entirely
              // - never overwrite a disagreeing tenant identity with the master's.
              return;
            }
          }
        }

        const scanContext = get().settings.scanContext ?? "any";
        if (entry && entry.verificationStatus === "verified") {
          // Build a CatalogHit for the Phase-8C identity-context firewall check.
          const hit: CatalogHit = {
            source: "verified_catalog",
            name: entry.name,
            brand: entry.brand ?? "",
            category: entry.category ?? "",
            size: entry.size ?? "",
            imageUrl: entry.imageUrl ?? "",
            productUrl: entry.sourceUrls?.[0] ?? "",
            confidence: entry.confidence ?? 0.9,
            verified: true,
          };
          const hasConflict = detectIdentityContextConflict(scanContext, hit);
          if (!hasConflict) {
            // Cache into in-memory catalog so repeat scans are instant (no second cloud round-trip).
            set((s) => ({ catalog: [...s.catalog, entry!] }));
            get().recordFeedback("found_from_catalog", { code: review.cleanCode });
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: entry.name,
                brand: entry.brand,
                category: entry.category,
                imageUrl: entry.imageUrl,
                productUrl: entry.sourceUrls?.[0],
                primaryBarcode: review.cleanCode,
                source: "catalog",
              },
            });
            // BUG FIX (verified-shows-Unidentified): only stamp the feed badge "Verified match" when
            // resolveUnknown ACTUALLY resolved this review. resolveUnknown can silently no-op and leave
            // the review "open" - a fuzzy identity-merge suggest_link (two different products sharing a
            // name/brand), or a dedup conflict (matchedIds.size > 1) - in which case the row's REAL
            // product/name never changed (still the provisional placeholder) and forcing the badge to
            // "verified" here would lie about the row's status (the exact owner-reported bug: "Verified
            // match" + "Unidentified item" on the same row). Only mark verified once the review is
            // actually "resolved".
            if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
              get().markFeedRowVerified(review.cleanCode, "Matched from global catalog - no AI used.");
            }
            return;
          }
          // Firewall conflict: fall through to AI below (same as a miss).
        }
        // Cloud miss, pending/unverified, or firewall conflict -> fall back to AI if the gate allows.
        const state = get();
        const s = state.settings;
        const nowMs = Date.now();
        const today = now().slice(0, 10);
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;
        const autoGate = evaluateAutoDecode({
          aiEnabled: s.aiLookupEnabled,
          status: state.aiStatus,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
          platformOwner: isPlatformOwnerForGateBypass(state.userId),
        });
        // A3 (owner-ratified 2026-07-15): same misread gate as processScan's direct dispatch - a
        // bad-check-digit code cannot decode via any GTIN rung even after a cloud-catalog miss.
        if (autoGate.allowed && !isLikelyMisreadGtin(review.cleanCode)) void get().liveDecode(reviewId);
      },

      // Thin wrapper: enqueue the real work on the bounded decode queue (module-level, MAX_CONCURRENT_DECODES
      // = 2) so a burst of unknown scans never fires unlimited concurrent /api/ai-lookup calls. Resolves once
      // the queued task actually runs and completes. Counting/persistence never waits on this - see the
      // queue doc comment above `decodeCorroborated`.
      liveDecode: (reviewId, options) => enqueueDecode(
        reviewId,
        () => get().runLiveDecodeOnce(reviewId, options),
        options?.deterministicOnly === true,
      ),

      runLiveDecodeOnce: async (reviewId, options) => {
        const state = get();
        const deterministicOnly = options?.deterministicOnly === true;
        const invalidationGeneration = options?.invalidationGeneration;
        const wasInvalidated = () =>
          invalidationGeneration !== undefined && invalidationGeneration !== trustedExactProbeGeneration;
        if (wasInvalidated()) return;
        const review = state.needsReviewQueue.find((r) => r.id === reviewId)
          ?? (deterministicOnly ? trustedExactProbes.get(reviewId) : undefined);
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        const mkLog = (
          status: AiLookupLog["status"],
          providerName: string,
          confidence: number,
          breakerState: BreakerState,
        ): AiLookupLog => ({
          id: idFactory(),
          businessId: state.businessId,
          rawCode: review.rawCode,
          cleanCode: review.cleanCode,
          providerName,
          status,
          confidence,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCost: 0,
          cacheHit: false,
          circuitBreakerState: breakerState.state,
          createdAt: nowIso,
        });

        // GOD CLIENT (owner-approved 2026-08-07): this is the SAME cap/breaker re-check evaluateAutoDecode
        // already bypassed at enqueue time (see its doc comment), run again here as defense-in-depth
        // before the actual fetch fires (state can drift between enqueue and dequeue). Without also
        // bypassing it here, the owner's decode would still be silently dropped to Needs Review with a
        // "Daily AI lookup cap reached"/"circuit breaker" reason even though evaluateAutoDecode allowed
        // it - defeating the whole point of the client bypass. See `applyGodGateOverride` for exactly
        // what is/isn't bypassed.
        const gate = applyGodGateOverride(
          evaluateAiGate({
            enabled: s.aiLookupEnabled,
            online: state.online,
            dailyCount,
            dailyLimit: s.dailyLookupLimit,
            breaker: state.breaker,
            now: nowMs,
          }),
          isPlatformOwnerForGateBypass(state.userId),
        );
        if (!gate.allowed && (!deterministicOnly || !state.online)) {
          // Fix-wave 2026-08-04: distinguish WHY this gate blocked instead of collapsing "disabled"
          // and "circuit_open" into the same "blocked_cap" label as a real daily-cap block - an
          // engineer reading aiLookupLogs needs to tell "the owner turned AI off" apart from "the
          // circuit breaker tripped" apart from "the daily spend cap is spent".
          const blockStatusByReason: Record<AiGateReason, AiLookupLog["status"]> = {
            ok: "success",
            disabled: "blocked_disabled",
            offline: "blocked_offline",
            daily_cap: "blocked_cap",
            circuit_open: "blocked_circuit",
          };
          const blockStatus: AiLookupLog["status"] = blockStatusByReason[gate.reason];
          // OWNER RULE follow-up (2026-08-05): a non-deterministic call blocked at THIS gate (e.g. the
          // trusted-exact continuation handing off into the ordinary ladder while the daily cap is
          // genuinely spent) must resolve the row honestly instead of leaving it stuck at decodeStatus
          // "decoding" forever - this gate returns before any fetch, so nothing downstream ever touches
          // the row again otherwise. A deterministic probe never flips decodeStatus to "decoding" in the
          // first place, so it stays exempt here (its own caller already routes the honest miss reason).
          // The scanFeed row may already be "needs_review" rather than "decoding" at this point (the
          // continuation's own flip-to-decoding write above is guarded to never touch an unrelated
          // already-resolved row for a repeat scan of the same code - see that guard's comment), so this
          // matches the same decoding/needs_review/suggested set as the decode-settle write below
          // (~line 3900) rather than "decoding" alone, or the honest cap reason would silently lose to a
          // stale pre-block reason already sitting on the row.
          const gateReasonText: Record<AiGateReason, string> = {
            ok: "",
            disabled: "AI lookup is off. Turn it on in Settings to auto-decode.",
            offline: "Offline. Saved locally; AI was not called.",
            daily_cap: "Daily AI lookup cap reached. Routed to Needs Review.",
            circuit_open: "AI circuit breaker is open after repeated failures. Routed to Needs Review.",
          };
          const blockedReason = gateReasonText[gate.reason];
          set((st) => ({
            aiLookupLogs: [mkLog(blockStatus, "decode", 0, gate.breaker), ...st.aiLookupLogs],
            breaker: gate.breaker,
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
            needsReviewQueue: deterministicOnly
              ? st.needsReviewQueue
              : st.needsReviewQueue.map((item) =>
                  item.id === reviewId
                    ? { ...item, decodeStatus: "needs_review" as const, reason: blockedReason, decodeNote: undefined }
                    : item,
                ),
            scanFeed: deterministicOnly
              ? st.scanFeed
              : st.scanFeed.map((event) =>
                  event.sessionId === review.sessionId
                    && event.cleanCode === review.cleanCode
                    && (event.decodeStatus === "decoding" || event.decodeStatus === "needs_review" || event.decodeStatus === "suggested")
                    ? { ...event, decodeStatus: "needs_review" as const, reason: blockedReason, decodeNote: undefined }
                    : event,
                ),
          }));
          return;
        }

        // Fix-wave 2026-08-04 (BLOCKER): mirror route.ts's bareNumericCode carve-out here, client-side.
        // The phone sanitizer masks bare 10-digit runs (sanitizer.ts's PHONE pattern), so a scanned
        // UPC/EAN-shaped bare code was being sent to the server as the literal string
        // "[redacted-phone]" instead of real digits. The server has its own carve-out (route.ts's
        // bareNumericCode), but it only recovers real digits from body.cleanCode/body.rawCode - once
        // the client had already masked them, the server never saw anything to recover. A bare
        // separator-free 8-14 digit run is a lookup code, not free text; everything else (formatted
        // phone numbers, letters, extra words) still gets sanitized exactly as before. The
        // deterministicOnly branch already sends the untouched review.rawCode/review.cleanCode (the
        // trusted-exact corpus probe never reaches a third-party AI provider - see route.ts's
        // deterministicOnly early return before any provider code), so it is unaffected here.
        const exactCodeForBareCheck = cleanScanCode(review.cleanCode || review.rawCode || "").cleanCode;
        const bareNumericCode = /^\d{8,14}$/.test(exactCodeForBareCheck) ? exactCodeForBareCheck : null;
        const rawCodeSanitized = deterministicOnly
          ? review.rawCode
          : (bareNumericCode ?? sanitizeForAiLookup(review.rawCode).clean);
        const cleanCodeSanitized = deterministicOnly
          ? review.cleanCode
          : (bareNumericCode ?? sanitizeForAiLookup(review.cleanCode).clean);
        const codeType = detectCodeType(review.cleanCode);
        // Phase 8B: app-derived prompt hints (advisory only - the Phase 8 firewall stays the hard gate).
        const scanContext = s.scanContext ?? "any";
        const candidatePrefix = decodeBarcodeStructure(review.cleanCode, codeType).candidateCompanyPrefix;
        const learnedHint = candidatePrefix
          ? deriveBrandPrefixHints(get().products, get().aliases).find((h) => h.prefix === candidatePrefix)
          : undefined;
        // Non-authoritative brand-FAMILY suggestion from the validated prefix hint table (corporate
        // siblings that share a GS1 company prefix). The learned (human-approved) hint is listed FIRST -
        // it is the trusted/promoted layer; the family is only a suggestion and never overrides the firewall.
        const familyMatch = lookupTirePrefix(review.cleanCode);
        const familyHint = familyMatch
          ? `GS1 prefix ${familyMatch.prefix} is associated (non-authoritative hint) with the tire brand family: ${familyMatch.brands.map((b) => b.brand).slice(0, 8).join(", ")}`
          : undefined;
        const brandPrefixHint =
          [
            learnedHint
              ? `candidate prefix ${learnedHint.prefix} has previously been human-approved for brand "${learnedHint.brand}" in this business`
              : undefined,
            familyHint,
          ]
            .filter(Boolean)
            .join(". ") || undefined;

        try {
          // AM-1(a) (owner-reported 36-70s browser blocks): the decode fetch had no client-side
          // timeout at all - a slow/hung server response could block the scan row (and the browser
          // connection) indefinitely. Timeout margin gives the server-side L2 ladder deadline
          // (DECODE_LADDER_TOTAL_MS, see pipeline.ts) room to finish and reply honestly before the
          // client gives up; the abort is a client-local giveup only - the server keeps computing and
          // caches its answer for the next scan, so nothing is lost.
          // AM-9: clamp a possibly-stale persisted decodeBudgetMs (e.g. an old 13000 default) into the
          // real [5000, 8000] server-enforced range before using it for anything client-side.
          const clampedBudgetMs = clampDecodeBudgetMs(s.decodeBudgetMs);
          const abortController = new AbortController();
          const abortTimer = setTimeout(() => abortController.abort(), clampedBudgetMs + 7000);
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST
          // (route.ts:294-324) or this 401s "unauthenticated"; mock mode resolves {} and both call
          // legs are unaffected. aiRequestAuth is resolved inline on each leg below.
          const decodeOnce = async () => {
            let res: Response;
            try {
              // P4 (#28): fetchWithBackoff replaces the old inline capped-at-30s/single-retry-no-
              // jitter block. It honors Retry-After IN FULL (up to its own safety ceiling, not the
              // old 30s cap) and applies full jitter on the exponential fallback so a burst of 429s
              // does not retry in a synchronized wave. onRetryDecision reads the (cloned) 429 body to
              // veto a retry outright on daily_cap/account_daily_cap - those never clear by waiting,
              // exactly as before. maxAttempts: 2 preserves the existing single-retry cost/latency
              // budget; the ORIGINAL (unread) response is returned when exhausted/vetoed so the
              // reasonCode handling below is unchanged.
              res = await fetchWithBackoff(
                "/api/ai-lookup",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  signal: abortController.signal,
                  body: JSON.stringify({
                    ...(await aiRequestAuth(state.businessId)),
                    mode: "decode",
                    deterministicOnly,
                    rawCode: rawCodeSanitized,
                    cleanCode: cleanCodeSanitized,
                    codeType,
                    confidenceThreshold: 0.8,
                    allowImageSuggestions: s.allowImageSuggestions,
                    budgetMs: clampedBudgetMs,
                    scanContext,
                    brandPrefixHint,
                    autoCountNonPublicWithEvidence: s.autoCountNonPublicWithEvidence ?? true,
                  }),
                },
                {
                  maxAttempts: 2,
                  onRetryDecision: async (cloned) => {
                    const body = await cloned.json().catch(() => ({}) as { reasonCode?: string });
                    return { retry: body?.reasonCode !== "account_daily_cap" && body?.reasonCode !== "daily_cap" };
                  },
                },
              );
            } catch (fetchErr) {
              // An abort is NEVER a retry case (there is nowhere to retry TO - the decode keeps
              // running server-side and the client just gave up waiting). Every other fetch-level
              // failure (network down, DNS, etc.) falls through to the existing generic catch below.
              if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
                throw new DecodeAbortedError();
              }
              throw fetchErr;
            }
            // 429 has two distinct causes that must NOT be treated the same:
            //  - daily_cap: the server-side daily AI spend cap is reached. There is no automatic
            //    decode-on-cap-reset queue anywhere in the app, so retrying now is pointless (it will
            //    just 429 again) - fail fast with an honest reason instead of burning a wait.
            //  - anything else: a self-inflicted rate limit (costs $0) that fetchWithBackoff already
            //    retried (with full Retry-After honor + jitter) before returning this final response.
            if (res.status === 429) {
              const body = await res.json().catch(() => ({}) as { reasonCode?: string; floor?: PrefixFloorResult });
              // P2: thread the server's $0 prefix floor into the error so the cap-blocked row is named
              // "<Brand> / product unconfirmed" from the GS1 company prefix, not a bare "Unidentified item".
              // F4: the per-account cap (route.ts:311/331) is a distinct 429 the client must ALSO honor -
              // it is not a self-inflicted rate limit, so it must NOT retry. Route it to Needs Review with
              // its own honest account-scoped copy (accountScoped=true drives the message below).
              if (body?.reasonCode === "account_daily_cap") throw new DailyCapReachedError(undefined, body?.floor, true);
              if (body?.reasonCode === "daily_cap") throw new DailyCapReachedError(undefined, body?.floor);
              throw new Error(`decode failed 429 after retries`);
            }
            if (!res.ok) throw new Error(`decode failed ${res.status}`);
            return res.json();
          };
          // Owner cost rule: NO client retry. The old "retry once on a miss" doubled both the wait (up
          // to ~70s, which dropped the browser connection -> "Failed to fetch") and the token spend. One
          // call only; a miss is shown fast with its honest reason and is briefly miss-cached server-side
          // so an immediate re-scan does not re-pay.
          let data: Awaited<ReturnType<typeof decodeOnce>>;
          try {
            data = await decodeOnce();
          } finally {
            clearTimeout(abortTimer);
          }
          // A clear-session/cache/sign-out/tenant-switch action is authoritative. The network request
          // may still complete, but a response from the previous generation must become a pure no-op
          // before any product, review, count, audit, or sync mutation can run.
          if (wasInvalidated()) return;
          // BUG #14 (QA hardening 2026-07-16): CLIENT-SIDE defense in depth. The server already
          // sanitizes reasonText/decision.reason (pipeline.ts) before responding, but this store must
          // not trust that unconditionally - sanitize both here too, ONCE, right at the response
          // boundary, so every downstream read (needsReviewQueue[].reason, scanFeed[].reason, the
          // honestReasonForBadge composition below) is already clean. Honest hand-written prose (no
          // vendor/service/model tokens) passes through unchanged; only a raw/internal string is
          // replaced with an honest fixed fallback - never empty, never the raw value.
          if (data.decision) {
            data = { ...data, decision: { ...data.decision, reason: sanitizeCustomerReason(data.decision.reason ?? "", { status: data.decision.status }) } };
          }
          if (typeof data.reasonText === "string") {
            data = { ...data, reasonText: sanitizeCustomerReason(data.reasonText, { status: data.decision?.status }) };
          }
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          // TASK T3 fix (2026-08-06, audit-9 finding B): remember a config-gap probe outcome so the
          // eventual continuation settle (below) can name the real cause instead of the generic
          // all-miss bucket. Only the deterministicOnly probe leg ever sees this reasonCode.
          if (deterministicOnly && data.reasonCode === "trusted_exact_not_available") {
            trustedExactConfigGapReviewIds.add(reviewId);
          }
          const canonicalId = trustedExactCanonicalId(data);
          if (canonicalId && best) {
            settleTrustedExactIdentity(
              reviewId,
              canonicalId,
              best,
              decision?.reason || "Authenticated trusted exact corpus match.",
            );
            return;
          }
          // AUDIT-6 FINDING 5 fix (2026-08-06, call-count only): a deterministic-only probe can ALSO
          // return a genuinely verified, exact-code-evidenced corpus hit that does not qualify for the
          // boss canonical-id settle above (e.g. a "global_corpus" trusted-exact hit, which deliberately
          // omits trustedExactCanonicalProductId - see the server tire knowledge provider's
          // resolveTrustedExactBarcodeDecision). Treating that as a miss and firing the owner-ratified
          // miss-continuation below would just re-fetch and re-verify the SAME identity a second time -
          // the live-observed "~2 POST /api/ai-lookup for one settled corpus scan" defect. Reuse this
          // response instead of discarding it: skip the miss/continuation branch entirely so the review
          // falls through into the ordinary decode-write path below (unchanged, shared with every
          // non-deterministic decode), producing the identical result the second call would have.
          //
          // SECURITY NARROWING: this must NEVER become a laundering path for an incomplete/spoofed
          // BOSS-scope response (the exact self-claim class scanStore.trustedExact.test.ts's "rejects
          // self-claimed or incomplete trusted responses" guards - a response that claims the boss
          // envelope via either corroborationPath or trustedExact.path but fails the strict canonical-id/
          // digest/schema checks above). Only a response that never claims the boss scope in the first
          // place (the plain non-boss "global_corpus" shape) is eligible here; anything claiming boss
          // scope without a valid canonicalId falls through unchanged to the existing miss/continuation
          // handling below, exactly as before this fix.
          const claimsBossScope =
            decision?.corroborationPath === "boss_trusted_exact_barcode"
            || data.trustedExact?.path === "boss_trusted_exact_barcode";
          const alreadySettledByProbe =
            deterministicOnly
            && !canonicalId
            && !claimsBossScope
            && decision?.status === "verified"
            && decision?.exactCodeEvidenceVerifiedByApp === true
            && Boolean(best);
          if (deterministicOnly && !alreadySettledByProbe) {
            const current = get();
            const currentSettings = current.settings;
            const currentNow = new Date(now()).getTime();
            // OWNER RULE (2026-08-05): a trusted-exact miss is never a dead end. The code continues into
            // the ordinary ladder in every environment unless the ordinary ladder's own gate blocks it.
            // dailyCount is intentionally forced to 0 so paid-rung cap math stays server-side while the
            // free corpus/cache rungs still run. GTIN shape and misread-likelihood never suppress the handoff.
            const continuationGate = evaluateAutoDecode({
              aiEnabled: currentSettings.aiLookupEnabled,
              status: current.aiStatus,
              online: current.online,
              dailyCount: 0,
              dailyLimit: currentSettings.dailyLookupLimit,
              breaker: current.breaker,
              now: currentNow,
              platformOwner: isPlatformOwnerForGateBypass(current.userId),
            });
            if (continuationGate.allowed) {
              const persisted = materializeTrustedExactMiss(reviewId, decision?.reason || "No trusted exact match was found.");
              if (persisted) {
                set((state) => ({
                  needsReviewQueue: state.needsReviewQueue.map((item) =>
                    item.id === persisted.id
                      ? { ...item, decodeStatus: "decoding" as const }
                      : item,
                  ),
                  // Guard by decodeStatus === "decoding" (matches the sibling patterns at
                  // materializeTrustedExactMiss above and the decode-settle write below): sessionId+
                  // cleanCode alone can match a DIFFERENT, already-resolved scanFeed row for a repeat
                  // scan of the same code in this session (e.g. an earlier occurrence already
                  // "verified") - without the guard this would wrongly revert that unrelated row back
                  // to "decoding".
                  scanFeed: state.scanFeed.map((event) =>
                    event.sessionId === persisted.sessionId
                      && event.cleanCode === persisted.cleanCode
                      && event.decodeStatus === "decoding"
                      ? { ...event, decodeStatus: "decoding" as const }
                      : event,
                  ),
                }));
                void get().liveDecode(persisted.id, { invalidationGeneration });
              } else {
                // Hardening: materializeTrustedExactMiss found neither the in-flight probe nor a
                // needsReviewQueue entry for this id (e.g. the session/cache was cleared mid-flight).
                // There is nothing left to continue into the ladder for - resolve honestly instead of
                // silently doing nothing and leaving a stale row behind.
                const fallbackReason = decision?.reason || "No trusted exact match was found.";
                set((state) => ({
                  needsReviewQueue: state.needsReviewQueue.map((item) =>
                    item.id === reviewId
                      ? { ...item, decodeStatus: "needs_review" as const, reason: fallbackReason, decodeNote: undefined }
                      : item,
                  ),
                  scanFeed: state.scanFeed.map((event) =>
                    event.sessionId === review.sessionId
                      && event.cleanCode === review.cleanCode
                      && event.decodeStatus === "decoding"
                      ? { ...event, decodeStatus: "needs_review" as const, reason: fallbackReason, decodeNote: undefined }
                      : event,
                  ),
                }));
              }
              return;
            }
            const missReasonBase = decision?.reason || "No trusted exact match was found.";
            const missReason = `${missReasonBase} Decode did not continue: ${continuationGate.reason}`;
            if (trustedExactProbes.has(reviewId)) {
              materializeTrustedExactMiss(reviewId, missReason);
              return;
            }
            set((current) => ({
              scanFeed: current.scanFeed.map((event) =>
                event.sessionId === review.sessionId
                  && event.cleanCode === review.cleanCode
                  && event.decodeStatus === "decoding"
                  ? { ...event, decodeStatus: "needs_review" as const, reason: missReason, decodeNote: undefined }
                  : event,
              ),
              needsReviewQueue: current.needsReviewQueue.map((item) =>
                item.id === reviewId
                  ? { ...item, decodeStatus: "needs_review" as const, reason: missReason, decodeNote: undefined }
                  : item,
              ),
            }));
            return;
          }
          if (alreadySettledByProbe) {
            // Move the transient probe into the real needsReviewQueue (same mechanic already proven by
            // materializeTrustedExactMiss) so the shared decode-write code below - which looks the
            // review up by id - has a row to update. Its placeholder reason/decodeStatus are
            // immediately overwritten by the real decision a few lines down; this call is purely the
            // carrier that makes the review addressable, never a second network request.
            const persisted = materializeTrustedExactMiss(reviewId, decision?.reason || "Verified from the trusted corpus.");
            if (!persisted) return; // hardening: nothing left to attach the verified identity to (rare race)
          }
          // TASK T3 fix (2026-08-06, audit-9 finding B): if the trusted-exact probe for THIS review
          // reported reasonCode trusted_exact_not_available (the server allowlist is not configured /
          // does not include this business) and the ladder we then continued into settles on the
          // generic all-miss bucket (MISS_REASON_TEXT.product_not_found), that generic text is
          // dishonest - it is indistinguishable from a code that genuinely does not exist anywhere.
          // Compose the specific, customer-safe, denylist-clean reason instead. A genuine
          // trusted_exact_miss (checked and missed) or any other miss reason (rate limit, cap,
          // timeout, missing keys) is untouched - only this exact collapse is corrected. The set entry
          // is consumed here (delete on read) so a later, unrelated re-decode of the same review id
          // never inherits a stale config-gap marker.
          const wasConfigGapProbe = trustedExactConfigGapReviewIds.has(reviewId);
          if (wasConfigGapProbe) trustedExactConfigGapReviewIds.delete(reviewId);
          const finalDecisionReason =
            wasConfigGapProbe && decision?.reason === MISS_REASON_TEXT.product_not_found
              ? "Trusted exact lookup is not enabled for this business, and no match was found in the databases. Saved to Needs Review."
              : (decision?.reason ?? "");
          // Phase 10: for a tire scan, parse the messy decode into structured columns (size -> specs,
          // brand, part number, clean description). Display/storage only - it does NOT touch the firewall
          // or the tireAutoCountOk (size + model) auto-count gate below (those read the ORIGINAL `best`).
          const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
          const providerNamesArr = (data.providerNames as string[]) ?? [];
          const providerName = providerNamesArr.join("+") || "mock";
          // P5 Task 5 (honest provenance badges): derive the honest provenance signal for the feed
          // row's badge from the SAME DecodeDecision already in scope here (the primary live-decode
          // write site). App-verified exact-code evidence wins first (it is the strongest, real
          // signal); otherwise a bare self-report is labeled by which provider produced it. Display
          // only - never gates counting/auto-count (that stays in scanGates.ts's canAutoCount).
          const decodeProvenance: ScanEvent["provenance"] = decision?.exactCodeEvidenceVerifiedByApp
            ? "app_verified"
            : decision?.corroborationPath === "gpt_self_report"
              ? "ai_self_report"
              : providerNamesArr.includes("go-upc")
                ? "db_self_report"
                : undefined;
          const decodeProviderSummaries = results.map((r, i) => ({
            provider: providerNamesArr[i] ?? "?",
            productName: r.productName,
            sources: (r.sourceUrls ?? []).length,
          }));

          // Phase 1: shop-catalog reverse-UPC guard (client-safe, our OWN catalog/products, full UPCs).
          // platformOwner heads-up when the proposed product already exists under a DIFFERENT code.
          const shopRecords: UpcRecord[] = [
            ...get().catalog.map((c) => ({ name: c.name, brand: c.brand, barcode: c.barcode, normalizedBarcode: c.normalizedBarcode })),
            ...get().products.map((p) => ({ name: p.name, brand: p.brand, model: p.specsShort, primarySku: p.primarySku, primaryBarcode: p.primaryBarcode, upc: p.upc, ean: p.ean, gtin: p.gtin, aliases: p.aliases })),
          ];
          const shopRev = best
            ? shopReverseUpcConflict({ brand: best.brand, name: best.productName, model: best.primarySku }, review.cleanCode, shopRecords)
            : { conflict: false, knownUpcs: [] as string[] };
          const reverseUpcConflictNote = shopRev.conflict ? `Already in your catalog under: ${shopRev.knownUpcs.slice(0, 3).join(", ")}` : "";

          // GPT LADDER (owner order 2026-07-06): the info_only tier is DELETED - every GPT answer
          // with a productName now arrives as a normal verified/suggested result and populates the
          // candidate fields like any other suggestion. Only the skip-reason transparency remains:
          // the route may append a {provider:"gpt-5.5-ladder", status:"skipped", errorCode} entry to
          // providerStatuses whenever the paid rung did not run at all. Surface WHY in decodeNote.
          const gptSkipEntry = Array.isArray(data.providerStatuses)
            ? (data.providerStatuses as Array<{ provider?: string; status?: string; errorCode?: string }>).find(
                (p) => p?.provider === "gpt-5.5-ladder" && p?.status === "skipped",
              )
            : undefined;
          const gptSkipNote = gptSkipEntry?.errorCode ? `gpt-5.5-ladder skipped: ${gptSkipEntry.errorCode}` : "";
          const decodeNoteUpdate = gptSkipNote || undefined;

          const suggestedPartNumberForGate = tireFields?.partNumber ?? best?.primarySku;
          const suggestionFields = {
                suggestedProductName: tireFields?.description || (best?.productName ?? ""),
                suggestedBrand: tireFields?.brand ?? best?.brand ?? "",
                suggestedCategory: best?.category ?? "",
                suggestedSpecsShort: tireFields?.size ?? best?.specsShort ?? "",
                suggestedSpecsFull: best?.specsFull ?? "",
                suggestedPrimarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
                suggestedPrimaryBarcode: scrubSuggestedBarcode(best?.primaryBarcode, suggestedPartNumberForGate),
                suggestedGtin: scrubSuggestedBarcode(best?.gtin, suggestedPartNumberForGate),
                suggestedUpc: scrubSuggestedBarcode(best?.upc, suggestedPartNumberForGate),
                suggestedEan: scrubSuggestedBarcode(best?.ean, suggestedPartNumberForGate),
                suggestedImageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
                suggestedProductUrl: best?.productUrl ?? "",
                suggestedAliases: best?.aliases ?? [],
                hasSuggestion: true,
              };

          set((st) => ({
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    ...suggestionFields,
                    sourceUrls: best?.sourceUrls ?? [],
                    verifiedFacts: best?.verifiedFacts ?? [],
                    guesses: best?.guesses ?? [],
                    reason: finalDecisionReason,
                    providerName,
                    confidence: decision?.confidence ?? 0,
                    decodeStatus: decision?.status ?? "needs_review",
                    evidenceStrength: decision?.evidenceStrength ?? "none",
                    exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
                    crossCheckDecision: decision?.crossCheck?.decision ?? "",
                    decodeProviderSummaries,
                    prefixHint: (data.debug?.prefixHint as string) || "",
                    prefixConflictReason: (data.debug?.firewallReason as string) || "",
                    reverseUpcConflictNote,
                    decodeNote: decodeNoteUpdate ?? r.decodeNote,
                  }
                : r,
            ),
            // Update the originating scan-feed row(s) from "Decoding..." / provisional "suggested" (the row
            // may already have been counted synchronously by ensureProvisionalCount) to the REAL fast-decode
            // outcome (needs_review / suggested / conflict). Never downgrade a row already flipped to
            // "verified" by the auto-verify pass.
            //
            // BUG FIX (verified-shows-Unidentified, burst report): a provider's raw decision.status
            // "verified" is NEVER written to the feed badge here. "Verified match" must mean the APP's own
            // auto-count gate (below) actually resolved this scan to a real product - a raw "verified"
            // decision can still fail to auto-count (weak/no evidence, context conflict, tireOk false) or
            // resolveUnknown can still no-op (fuzzy identity-merge suggest_link, dedup conflict), in which
            // case the row must keep showing its honest pending state, not a "Verified match" lie over the
            // unresolved "Unidentified item" placeholder. Only `markFeedRowVerified` - now called ONLY
            // after resolveUnknown actually resolves the review - is allowed to write "verified" here.
            scanFeed: st.scanFeed.map((e) => {
              if (
                e.cleanCode !== review.cleanCode ||
                !(e.decodeStatus === "decoding" || e.decodeStatus === "needs_review" || e.decodeStatus === "suggested")
              ) {
                return e;
              }
              const displayedBadge = (decision?.status === "verified"
                ? "suggested"
                : (decision?.status ?? "needs_review")) as ScanEvent["decodeStatus"];
              return {
                ...e,
                decodeStatus: displayedBadge,
                // P5 Task 5: honest provenance signal for the badge (display only). A raw "verified"
                // decision is displayed as "suggested" above (displayedBadge), so app_verified here
                // would be misleading on THIS provisional row - only attach it when the badge is
                // actually settled to "suggested" so DecodeStatusBadge's app_verified branch (which
                // only fires for status "verified") never mismatches this row's shown status.
                provenance: displayedBadge === "suggested" ? decodeProvenance : undefined,
                // BADGE/REASON INVARIANT: never write a "Verified...No AI lookup needed" reason under a
                // non-verified badge (see honestReasonForBadge above - the owner-caught contradiction).
                reason: honestReasonForBadge(finalDecisionReason, decision?.status, displayedBadge) || e.reason,
                // STALE-NOTE FIX (goupc-cap-rootcause item 3): decodeNote was set once at scan time to the
                // in-flight "Decoding with AI..." note and never refreshed - platformOwner saw that note
                // forever on every settled row. The decode has now settled, so replace the in-flight note
                // with the honest post-decode transparency note (the skipped-paid-rung note when present),
                // or clear it. Never leave "Decoding with AI..." on a row that is no longer decoding.
                decodeNote: decodeNoteUpdate || undefined,
              };
            }),
            aiLookupLogs: [mkLog("success", providerName, decision?.confidence ?? 0, recordSuccess()), ...st.aiLookupLogs],
            breaker: recordSuccess(),
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastProvider: providerName, lastFailureReason: "" },
            settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
          }));

          // CONFIDENCE-BASED AUTO-VERIFY (no extra network calls - scores the evidence the decode
          // already returned). Strong, evidence-backed matches auto-save to the verified catalog and
          // count with NO owner approval. Weak/conflicting/unsafe/AI-only-no-evidence -> Needs Review.
          const cleanName = cleanProductName(best?.productName ?? "");
          const avSettings = {
            autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
            autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
            trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
            aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
            allowNonPublicAutoCount: s.autoCountNonPublicWithEvidence ?? true,
          };
          const plan = planAutoVerify({
            code: review.cleanCode,
            codeType,
            decision: {
              status: decision?.status ?? "needs_review",
              evidenceStrength: decision?.evidenceStrength ?? "none",
              exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheck: decision?.crossCheck ?? {
                decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
              },
            },
            best,
            catalog: get().catalog,
            settings: avSettings,
          });

          const newProduct = {
            name: tireFields?.description || cleanName,
            brand: tireFields?.brand ?? best?.brand ?? "",
            category: best?.category ?? "",
            specsShort: tireFields?.size ?? best?.specsShort ?? "",
            specsFull: best?.specsFull ?? "",
            primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
            primaryBarcode: best?.primaryBarcode || review.cleanCode,
            gtin: best?.gtin ?? "",
            upc: best?.upc ?? "",
            ean: best?.ean ?? "",
            imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
            productUrl: best?.productUrl ?? "",
          };

          const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate: false = manual review for all
          // Phase 7 EVIDENCE GATE: auto-count ONLY on the app's independent exact-code verification +
          // confidence >= 0.8 + (for tires) a countable identity (size + model, matching the route's
          // verify gate). The model's self-reported confidence alone is never enough (that is what
          // auto-counted wrong products). Anything short -> Needs Review.
          const tireOk = tireAutoCountOk(best);
          // Phase 8 FIREWALL: exact-code evidence is necessary but NOT sufficient. If the decoded product
          // contradicts the business scan context (tire) or a learned brand-prefix hint, block auto-count.
          // Task 9 (owner-ratified 2026-07-14, decode-anything): strong APP-VERIFIED exact-code evidence
          // clears the tire category hard-block - a tire shop can really stock hot sauce. Weak/unverified
          // single-source identities (the go-upc-poison / coconut-oil class) still hard-block.
          const exactCodeVerifiedByApp =
            decision?.exactCodeEvidenceVerifiedByApp === true && decision?.status === "verified";
          const firewallParams = {
            scanContext: s.scanContext ?? "any",
            code: review.cleanCode,
            codeType,
            result: best,
            brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
            exactCodeVerifiedByApp,
          };
          const contextConflict = detectScanContextConflict(firewallParams);
          // True exactly when the category conflict was CLEARED by verification -> the row still counts but
          // is tagged "Off-category item" so the operator sees it is not a tire.
          const offCategory = detectOffCategoryAdvisory(firewallParams);
          // PHASE-7 EVIDENCE GATE + GPT-ladder trust tier + T20/code-1225 public-barcode firewall, now in
          // one pure function (src/stores/scanGates.ts) shared with backgroundVerifyDeep so the two paths
          // cannot drift. tireOk + contextConflict are computed here (they need store services) and passed in.
          const evidenceGatePassed = canAutoCount({
            codeType,
            decision,
            productName: best?.productName ?? "",
            productNameUsable: isUsableProductName(best?.productName ?? ""),
            tireOk,
            contextConflict,
          }).allowed;
          // MULTI-VARIANT GATE (Group C, owner mandate 2026-07-21): a listing naming several
          // distinct speed ratings for one size (e.g. "93V, 93W, 93H") describes MULTIPLE product
          // variants, not one confident identity - it must NEVER auto-apply/auto-count as a clean
          // verified match, regardless of how strong the evidence/confidence otherwise looks.
          const multiVariantIdentity = enrichProductIdentity({ payload: { name: best?.productName ?? "" } }).multiVariant;
          if (autoAddOn && evidenceGatePassed && !multiVariantIdentity && (plan.status === "auto_verify" || plan.status === "auto_count")) {
            // Origin decides the catalog write: exact app-confirmed evidence -> VERIFIED global catalog
            // entry; a trusted-but-non-exact AI product -> still counted + aliased, PENDING catalog
            // entry ("ai"); learning off -> count only, no catalog write ("auto_count").
            // OPTION 3: a NON-public code (vendor/SKU/FNSKU) NEVER writes the global cross-shop catalog
            // ("auto_verify") - those codes are seller-specific. It still counts + makes a SHOP-local approved
            // alias via origin "ai". Only a public UPC/EAN/GTIN keeps the verified global-catalog write.
            const isPublicCode = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(codeType);
            const origin =
              plan.status === "auto_count" ? "auto_count" : (plan.verifiedBy && isPublicCode) ? "auto_verify" : "ai";
            get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
            if (origin === "auto_verify") {
              get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
            }
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin,
              autoVerify:
                origin === "auto_verify"
                  ? {
                      score: plan.score,
                      verifiedBy: plan.verifiedBy ?? "evidence_score",
                      sourceTier: plan.sourceTier,
                      reason: plan.reason,
                      evidenceSummary: plan.evidenceSummary,
                      sourceUrls: best?.sourceUrls ?? [],
                    }
                  : undefined,
              newProduct,
            });
            // TASK 3: the scan was counted synchronously, so its feed row is already "known" (which
            // resolveUnknown's resolved-row remap skips). Flip that row's badge to "verified" so the feed
            // shows the auto-verified decode instead of the stale "suggested" placeholder badge.
            //
            // BUG FIX (verified-shows-Unidentified, burst report): resolveUnknown can silently no-op and
            // leave the review "open" instead of "resolved" - most commonly the identity-merge fuzzy
            // suggest_link path (two different products/codes with a very similar name+brand, e.g. the
            // SAME tire model in different sizes scanned back-to-back) or a dedup conflict
            // (matchedIds.size > 1). In either case the row's product/name is UNCHANGED (still the
            // provisional "Unidentified item" placeholder) and the review is left open for a human
            // decision - forcing the badge to "verified" here would show "Verified match" over an
            // unresolved placeholder name, exactly the owner-reported burst bug. Only mark the row
            // verified when resolveUnknown actually resolved it.
            if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
              // P5 Task 5: this branch only runs after the Phase-7 evidence gate (evidenceGatePassed /
              // canAutoCount) passed, i.e. the app itself verified the exact-code evidence - honest
              // "app_verified" provenance for the badge.
              get().markFeedRowVerified(review.cleanCode, decision?.reason ?? "", "app_verified");
            } else {
              // FIX (rung self-poisoning audit, owner-approved): resolveUnknown's create_new branch
              // already stamps "resolved" on every ACTUAL resolution. The only ways a review is still
              // open/suggested here are the two DELIBERATE human-required early-returns: the fuzzy
              // identity-merge suggest_link path (stamps suggestedLinkProductId + returns, keeping the
              // review open on purpose) and the multi-match dedup-conflict path (pushes this reviewId onto
              // lastAliasConflicts + returns, keeping it open on purpose). Force-stamping "resolved" here
              // used to fire in BOTH of those cases - the only cases where the row is still open - hiding
              // a row that MUST stay visible behind a fabricated "auto create_new" audit trail even though
              // nothing was actually created. Only stamp when NEITHER deliberate-hold signal fired for
              // this exact review.
              const stillOpen = get().needsReviewQueue.find((r) => r.id === reviewId);
              const heldForSuggestLink = Boolean(stillOpen?.suggestedLinkProductId);
              const heldForConflict = (get().lastAliasConflicts ?? []).some((c) => c.reviewId === reviewId);
              if (stillOpen && (stillOpen.status === "open" || stillOpen.status === "suggested") && !heldForSuggestLink && !heldForConflict) {
                set((st) => ({
                  needsReviewQueue: st.needsReviewQueue.map((r) =>
                    r.id === reviewId
                      ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const }
                      : r,
                  ),
                }));
              }
            }
            // Task 9: an app-verified off-category decode counts, but flag the row so the feed shows the
            // "Off-category item" tag (the product is not a tire, even though it cleared the firewall).
            if (offCategory) {
              set((st) => ({
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode ? { ...e, offCategory: true } : e,
                ),
              }));
            }
          } else {
            // DECODE-EVERYTHING provisional count: EVERY scan that reached decode gets counted, even if
            // the AI returned a weak/empty product or no product at all. Owner rule: scan 10 = count 10.
            // The provisional product has verified:false, provisional:true, no approved alias, and the
            // review STAYS OPEN for human confirmation. NOTHING blocks provisional counting — not even a
            // brand/context conflict (the prefix firewall is a suggestion, not a blocker for counting).
            {
              const code = review.cleanCode;
              const hasUsableName = isUsableProductName(best?.productName ?? "");
              // PREFIX FLOOR (Plan C Task 3): no usable AI name - before falling back to the bare
              // "Unidentified item" placeholder, check whether the GS1 company prefix maps to a known
              // brand. If so, state the brand with confidence and flag the product unconfirmed instead
              // of an empty row. Never fabricates a specific product; never verified.
              const floor = hasUsableName ? null : prefixFloorName(code, codeType);
              const provName = hasUsableName
                ? (cleanName || code)
                : floor
                  ? floor.name
                  : `Unidentified item (barcode ${code})`;
              const cur = get();
              // DEDUP: reuse a still-counted product whose identifier matches this code (orphaned-count rule),
              // so re-scans increment the SAME provisional row instead of duplicating. Never fuzzy.
              const countedIds = new Set(cur.finalCounts.map((c) => c.productId));
              let provId = cur.products.find(
                (p) =>
                  countedIds.has(p.id) &&
                  p.status !== "archived" &&
                  [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
              )?.id;
              // BUG FIX (scan-order merge asymmetry, live-proven: barcode-then-PN left 2 rows while
              // PN-then-barcode correctly merged into 1): `provId` above is almost always already this
              // SCAN'S OWN placeholder - ensureProvisionalCount mints it synchronously at scan time
              // (before decode ever runs), keyed on the literal scanned code. So an exact-code dedup miss
              // against any OTHER product never happens here; every decode that reaches this branch (never
              // "verified" - e.g. every corpus PN hit, which is a "suggested" decision by design) instead
              // needs to check whether the DECODED identity (not the raw scanned code) matches an existing,
              // already-verified product from an earlier scan of a DIFFERENT code for the SAME physical
              // item (the barcode-first case: a distributor-prefixed PN's own canonical part number was
              // never going to equal the scanned string). resolveUnknown's create_new path already runs
              // findIdentityMerge for exactly this reason; this fast "decode-everything" branch never did.
              // Reuse the SAME size-aware identity-merge primitive here - auto_link (canonical GTIN/barcode
              // equality, tire size agreeing) merges deterministically into the existing product (its own
              // fields are trusted and never overwritten by this weaker suggestion); anything fuzzier
              // (suggest_link) is left alone (never guessed), matching resolveUnknown's own trust rule.
              let mergeOrphanId: string | null = null;
              let mergeTargetId: string | null = null;
              if (best) {
                const mergeCandidates = cur.products.filter(
                  (p) => p.status !== "archived" && p.provisional !== true && p.id !== provId,
                );
                // NOTE: deliberately OMITS primaryBarcode - canonicalOf (identityMerge.ts) reads it, and a
                // carried/decoded barcode must never become a merge key here (probe-B footgun); only the
                // decoded identity fields below are trusted for matching.
                const merge = findIdentityMerge(mergeCandidates, {
                  gtin: best.gtin ?? null,
                  upc: best.upc ?? null,
                  ean: best.ean ?? null,
                  brand: best.brand ?? null,
                  name: best.productName ?? null,
                  specsShort: best.specsShort ?? null,
                  specsFull: best.specsFull ?? null,
                });
                if (merge.kind === "auto_link" && countedIds.has(merge.productId) && merge.productId !== provId) {
                  mergeTargetId = merge.productId;
                  mergeOrphanId = provId ?? null; // this scan's own placeholder (if any) gets merged away
                  provId = merge.productId;
                  emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code } });
                }
              }
              if (mergeTargetId) {
                // BUG FIX (scan-order merge asymmetry): reuse the EXISTING verified product discovered
                // above. Its fields are already correct and trusted - only add this code as a new alias
                // (via the SAME buildAliasesForCodes helper resolveUnknown's own multi-code aliasing uses)
                // so a future scan of the same code resolves deterministically. Never overwrite the
                // existing product's name/brand/specs from this weaker (suggested-tier) decode.
                const targetProduct = cur.products.find((p) => p.id === mergeTargetId);
                if (targetProduct) {
                  const built = buildAliasesForCodes({
                    product: targetProduct,
                    codes: [code],
                    existingAliases: cur.aliases,
                    businessId: cur.businessId,
                    sessionId: cur.sessionId,
                    idFactory,
                    now,
                    source: "ai_gemini",
                    createdBy: "ai",
                  });
                  if (built.aliases.length > 0) {
                    set((st) => ({
                      aliases: [...st.aliases, ...built.aliases],
                      pendingSyncQueue: [...st.pendingSyncQueue, ...built.queued],
                    }));
                  }
                }
                // If this scan already had its OWN provisional placeholder (minted synchronously by
                // ensureProvisionalCount before this decode landed), transfer its retained count onto the
                // merge target and remove the now-redundant placeholder row - the SAME orphan-transfer
                // pattern resolveUnknown uses (never lose a count, never leave two rows for one identity).
                if (mergeOrphanId && mergeOrphanId !== mergeTargetId) {
                  const oid = mergeOrphanId;
                  const targetId = mergeTargetId;
                  // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
                  // local-only transfer leaves the backend holding the orphan's count forever.
                  const transferOps = buildOrphanTransferSyncOps({
                    finalCountsBeforeTransfer: get().finalCounts,
                    scanFeedBeforeTransfer: get().scanFeed,
                    oid,
                    targetId,
                    businessId: cur.businessId,
                    idFactory,
                    now,
                  });
                  set((st) => ({
                    products: st.products.filter((p) => p.id !== oid),
                    finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
                    scanFeed: st.scanFeed.map((e) =>
                      e.matchedProductId === oid ? { ...e, matchedProductId: targetId } : e,
                    ),
                  }));
                  if (transferOps.length > 0) enqueueAndSync(transferOps);
                }
              } else if (!provId) {
                provId = `prod-${idFactory()}`;
                // PN-BARCODE-CARRY: mint time - the scanned code itself is the only barcode so far
                // (current primaryBarcode is empty, i.e. "" as far as carriedProvisionalBarcode is
                // concerned), so a decode-provided barcode may carry through subject to the trust gate.
                const mintedBarcode =
                  carriedProvisionalBarcode({
                    currentPrimaryBarcode: "",
                    scannedCleanCode: code,
                    scannedCodeType: codeType,
                    candidateBarcode: best?.primaryBarcode,
                    partNumber: best?.primarySku,
                  }) || code;
                // FALKEN FIX (owner-reported live bug, 2026-07-20): this is the DECODE-EVERYTHING
                // provisional mint - the exact path a single fresh scan with a name-only decode
                // payload (no separate brand/category/specsShort/specsFull) takes. Previously every
                // structured column defaulted straight to "" with no fallback, leaving Brand/Model/
                // Category/Specs/Size permanently blank even though they are cleanly parseable from
                // the decoded name. Route through the shared helper: the payload's own field always
                // wins; a still-empty field falls back to a deterministic name parse, never a guess.
                const mintEnriched = enrichProductIdentity({
                  payload: { name: provName, brand: best?.brand, category: best?.category, specsShort: best?.specsShort, specsFull: best?.specsFull },
                });
                const provProduct: Product = {
                  id: provId, businessId: cur.businessId, name: provName, brand: mintEnriched.brand || (floor?.brand ?? ""),
                  category: mintEnriched.category, specsShort: mintEnriched.specsShort, specsFull: mintEnriched.specsFull,
                  primarySku: best?.primarySku ?? "", primaryBarcode: mintedBarcode, gtin: best?.gtin ?? "", upc: best?.upc ?? "",
                  ean: best?.ean ?? "", vendorCodes: [], aliases: [], imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
                  productUrl: best?.productUrl ?? "", location: "", notes: "", status: "active", source: "ai_gemini",
                  confidence: decision?.confidence ?? 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
                  ...(mintEnriched.structuredModel ? { structuredModel: mintEnriched.structuredModel, structuredBy: "deterministic" as const } : {}),
                };
                set((st) => ({ products: [...st.products, provProduct] }));
                emitAudit({ entityType: "Product", entityId: provId, action: "product_created", metadata: { code, origin: "ai_suggested_provisional" } });
              } else if (hasUsableName) {
                // TASK 3 ENRICH: the scan was already counted synchronously (ensureProvisionalCount) as an
                // "Unidentified item" placeholder. Upgrade that SAME row in place with the decoded identity
                // (name / brand / specs) - NEVER re-count (its feed row is already "known"). It stays
                // provisional + unverified; the review stays open for human confirmation.
                const enrichId = provId;
                set((st) => ({
                  products: st.products.map((p) => {
                    if (p.id !== enrichId) return p;
                    // FALKEN FIX (owner-reported live bug, 2026-07-20): same gap as the mint branch
                    // above - a name-only decode payload used to leave brand/category/specsShort/
                    // specsFull permanently blank on the upgraded row. Fill-if-empty via the shared
                    // helper: a field the row already carries a value for is preserved untouched.
                    //
                    // PREFIX-FLOOR BRAND LOCK FIX (owner-reported live bug, 2026-07-21, 310-row review:
                    // rows 049000242201/049000245462 showed a real tire's decoded name next to Brand
                    // "Coca-Cola" - 049000 is Coca-Cola's GS1 prefix): p.brand at this point may be
                    // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
                    // synchronously BEFORE this decode ever ran (p.name is still exactly the floor's own
                    // placeholder text). That guess is not "another source" that fill-if-empty must
                    // protect - it must yield to whatever THIS decode determines (its own brand, or a
                    // name-parsed brand, or genuinely empty), never silently lock in the wrong brand next
                    // to a now-correct decoded name. A brand set by any OTHER means (a prior real decode,
                    // a human edit) still wins untouched, since p.name would no longer equal the floor text.
                    //
                    // CLASS FIX (2026-08-04, cocacola-bug-report.md): this used to be the ONLY of three
                    // vulnerable call sites carrying this guard - moved into enrichProductIdentity itself
                    // (via existingBrandIsFloorGuess) so the other two call sites (resolveUnknown's
                    // reuse/orphan-upgrade branches) can share the exact same protection.
                    const enrichIdentity = enrichProductIdentity({
                      payload: { name: provName, brand: best?.brand, category: best?.category, specsShort: best?.specsShort, specsFull: best?.specsFull },
                      existing: { name: p.name, brand: p.brand, category: p.category, specsShort: p.specsShort, specsFull: p.specsFull },
                      existingBrandIsFloorGuess: brandIsOnlyFloorGuess(p.name, code),
                    });
                    return {
                          ...p,
                          name: provName,
                          brand: enrichIdentity.brand,
                          category: enrichIdentity.category,
                          specsShort: enrichIdentity.specsShort,
                          specsFull: enrichIdentity.specsFull,
                          ...(!p.structuredModel && enrichIdentity.structuredModel ? { structuredModel: enrichIdentity.structuredModel } : {}),
                          primarySku: p.primarySku || (best?.primarySku ?? ""),
                          // PN-BARCODE-CARRY: upgrade the placeholder primaryBarcode (empty, or the
                          // scanned PN itself) to the decode's corpus barcode - never a real scanned
                          // GTIN (carriedProvisionalBarcode returns "" in that case, keeping p.primaryBarcode).
                          primaryBarcode:
                            carriedProvisionalBarcode({
                              currentPrimaryBarcode: p.primaryBarcode,
                              scannedCleanCode: code,
                              scannedCodeType: codeType,
                              candidateBarcode: best?.primaryBarcode,
                              partNumber: best?.primarySku ?? p.primarySku,
                            }) || p.primaryBarcode,
                          gtin: p.gtin || (best?.gtin ?? ""),
                          upc: p.upc || (best?.upc ?? ""),
                          ean: p.ean || (best?.ean ?? ""),
                          imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? p.imageUrl) : p.imageUrl,
                          productUrl: best?.productUrl || p.productUrl,
                          confidence: decision?.confidence ?? p.confidence,
                          updatedAt: now(),
                          updatedBy: "ai",
                    };
                  }),
                }));
              }
              // Count it on the EXISTING scan event for this code (idempotent by event id), and surface the
              // provisional product + qty on that feed row while keeping the "Suggested" badge.
              const ev = get().scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
              if (ev) {
                const countEvent: ScanEvent = { ...ev, matchedProductId: provId!, status: "known", quantityDelta: 1 };
                const { counts, count } = incrementInventoryCount(get().finalCounts, countEvent, idFactory);
                set((st) => ({
                  finalCounts: counts,
                  // Clear lastSyncError so provisionally counted items don't show a stale error banner.
                  lastSyncError: null,
                  scanFeed: st.scanFeed.map((e) =>
                    e.id === ev.id
                      ? { ...e, matchedProductId: provId!, status: "known", quantityAfterScan: count.quantity, decodeStatus: hasUsableName ? "suggested" : "needs_review", syncStatus: "synced" as const }
                      : e,
                  ),
                }));
              } else {
                // Already counted synchronously at scan time: just refresh the decode badge on the known
                // provisional row (no re-count). Never downgrade a row already flipped to "verified".
                const badge: ScanEvent["decodeStatus"] = hasUsableName ? "suggested" : "needs_review";
                set((st) => ({
                  scanFeed: st.scanFeed.map((e) =>
                    e.cleanCode === code && e.status === "known" && e.decodeStatus !== "verified" && e.matchedProductId === provId
                      ? { ...e, decodeStatus: badge }
                      : e,
                  ),
                }));
              }
              // F5 bundle-surgery: no usable AI name and the client-safe (SEED/LEARNED) lookup found no
              // brand - worth an async check for a DERIVED-tier hit. The row already appeared + counted
              // above either way (TOP-LEVEL LAW unaffected).
              if (!hasUsableName && !floor && provId) get().enrichPrefixFloorLabel(code, provId);
            }
            // STABLE-ID FIX: the decode-everything block just above minted/reused this code's provisional
            // placeholder. Look its id up fresh (it is scoped inside the block above) so resolveUnknown can
            // re-link by id after a customer reload, instead of by reconstructed name.
            const provIdForReview = get().products.find(
              (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === review.cleanCode,
            )?.id;
            // Needs Review: keep it in the queue, show the score + why; write a PENDING catalog
            // candidate when the name is usable so the catalog still accumulates knowledge.
            get().recordFeedback("catalog_candidate_blocked", { code: review.cleanCode, meta: { score: plan.score } });
            if (isUsableProductName(best?.productName ?? "")) {
              set({
                catalog: applyAiCandidate(
                  get().catalog,
                  {
                    barcode: review.cleanCode,
                    normalizedBarcode: review.cleanCode,
                    barcodeType: codeType,
                    name: cleanName,
                    brand: best?.brand ?? "",
                    category: best?.category ?? "",
                    sourceUrls: best?.sourceUrls ?? [],
                    evidenceScore: plan.score,
                    blockingReasons: plan.blockingReasons,
                  },
                  nowIso,
                ),
              });
            }
            // Prefer the server's HONEST reason (rate-limited / timed-out / not-found-after-search /
            // fallback) over the generic gate text, so the row never lies about why it needs review.
            // TASK T3 fix (2026-08-06, audit-9 finding B): this decode-everything settle site has its
            // OWN reason write (reviewReason below), independent of the earlier one - it must not fall
            // back to the raw generic reasonText and silently undo the config-gap override computed
            // above (finalDecisionReason). Same rule: only substitute when this review's probe really
            // was the config-gap outcome AND the raw text is exactly the generic all-miss bucket.
            const honest =
              wasConfigGapProbe && data.reasonText === MISS_REASON_TEXT.product_not_found
                ? finalDecisionReason
                : typeof data.reasonText === "string" ? data.reasonText : "";
            // Phase 8: a category/brand conflict gives the safe, product-facing reason (highest priority).
            // Phase 7: a usable tire decode blocked only for missing specs gets a precise reason.
            const tireIncomplete = isUsableProductName(best?.productName ?? "") && isTireContext(best) && !hasRequiredTireSpecs(best);
            const reviewReason = contextConflict
              ? conflictReason(contextConflict)
              : tireIncomplete
                ? "Tire decode missing size / load index / speed rating - confirm full specs before counting (incomplete_specs)."
                : honest || plan.blockingReasons[0] || plan.reason || "Needs review";
            set((st) => ({
              // Phase 9: a category-context conflict drives the dismissible scan-page warning banner.
              lastCategoryWarning:
                contextConflict === "category_context_conflict"
                  ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                  : st.lastCategoryWarning,
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId
                  ? {
                      ...r,
                      autoVerifyScore: plan.score,
                      blockingReasons: plan.blockingReasons,
                      reason: reviewReason,
                      provisionalProductId: r.provisionalProductId ?? provIdForReview ?? null,
                    }
                  : r,
              ),
              // Never leave a "Verified AI Decode + Unknown" feed row: if the decode said "verified" but
              // did NOT auto-save, rewrite the feed badge to needs_review. Conflict/suggested keep their
              // (already accurate) decode status.
              scanFeed:
                decision?.status === "verified"
                  ? st.scanFeed.map((e) =>
                      e.cleanCode === review.cleanCode && e.status !== "known" && e.status !== "resolved"
                        ? { ...e, decodeStatus: "needs_review", reason: reviewReason }
                        : e,
                    )
                  : st.scanFeed,
            }));

            // AUTO-SUGGEST-APPLY (owner order 2026-07-10): this decode did NOT clear the full auto-count
            // gate above, but it may still be high-trust enough to skip Needs Review entirely. The
            // identity was ALREADY applied onto the provisional row in place a few lines up (the
            // hasUsableName enrich branch runs regardless of this gate) - the only thing left is to close
            // the review instead of leaving it open, when confidence >= 0.8 OR this is an app-verified
            // exact decode (Go-UPC exact class: status "verified" + exactCodeEvidenceVerifiedByApp true).
            // TRUST RULES: no alias is created here, the product stays provisional:true/verified:false,
            // and the feed badge stays "suggested" (never "verified") - markFeedRowVerified is not called.
            // MULTI-VARIANT GATE (Group C): a listing naming several distinct speed ratings for one
            // size describes multiple product variants, not one confident identity - never let it
            // skip Needs Review via auto-suggest-apply, regardless of confidence/evidence.
            const multiVariantIdentity = enrichProductIdentity({ payload: { name: best?.productName ?? "" } }).multiVariant;
            const autoSuggestApplied =
              !multiVariantIdentity &&
              autoSuggestApplyOk({
                autoAddOn,
                contextConflict,
                productName: best?.productName ?? "",
                confidence: decision?.confidence ?? 0,
                status: decision?.status,
                exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              });
            if (autoSuggestApplied) {
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                    : r,
                ),
              }));
            }

            // Tasks 5+6: CLIENT-ORCHESTRATED BACKGROUND VERIFY. The fast hot path (mode:"decode") did
            // NOT auto-count this scan (the else branch ran -> not verified-and-clean). For a TIRE scan
            // that is still open, fire ONE background `mode:"decode-deep"` request WITH scanContext
            // "tire" - that is what makes the route page-fetch + app-verify the exact UPC and lets
            // decideDecode return "verified" (proven live: Hankook 715459332915). On success it routes
            // through the SAME verified-decode handling below to count + learn the alias.
            //
            // Never fire when the fast pass was a firewall context CONFLICT (a poisoned/off-domain
            // identity in tire context): re-fetching would just re-confirm the poison and the firewall
            // would block the count anyway, so we keep it in human review instead of spending a fetch.
            // The tire trigger reads BOTH the scan context (tire) and the decoded identity, so a clearly
            // non-tire decode in tire context does not escalate. Also skip when this decode was just
            // auto-suggest-applied above: the review is already closed, so a deep re-check would find
            // status !== "open" and no-op anyway (idempotency guard) - skip the wasted network call.
            const tireScan =
              (s.scanContext ?? "any") === "tire" && (isTireContext(best) || lookupTirePrefix(review.cleanCode) !== null);
            const fastWasVerified = decision?.status === "verified";
            if (tireScan && !fastWasVerified && !contextConflict && !autoSuggestApplied) {
              // Fire-and-forget: it must NEVER block the scan UI or throw into this flow. The action
              // self-guards on the review still being open (idempotent against a late/duplicate response).
              void get().backgroundVerifyDeep(reviewId);
            }

            // Task 9b (owner-ratified 2026-07-14): a suggestion-bearing decode NO LONGER sits in Needs
            // Review. The scan already counted (count-decouple, above); the suggestion concerns only the
            // NAME, so it moves onto the counted feed row as a PENDING inline suggestion (approve/decline
            // controls) and the review record is PARKED at status "suggested" (kept for the audit trail +
            // the batch-approve surface; dropped from the open queue/badge). APPROVED SEAM: only a decision
            // that is honestly "suggested", with a usable name, no firewall conflict, not auto-suggest-
            // applied, and NOT a tire scan awaiting the background deep-verify escalation just fired above
            // (that proven owner-loved path keeps its open review until it completes; backgroundVerifyDeep
            // performs the same conversion itself when it finishes WITHOUT verifying). Conflicts, empty
            // decodes, and blocked-verified decodes still create/keep open reviews (unchanged).
            // autoAddOn gate: with autoAddDecodedProducts OFF the owner asked for EVERY decode to go to
            // manual review (documented master switch) - suggestions then keep landing in the open queue.
            // BEST-GUESS DISPLAY (owner decision 2026-08-19): the inline suggestion is no longer limited
            // to an honestly-"suggested" decision. A WEAKER "needs_review" decision that still produced a
            // usable name carries that best guess on the counted row too, banded and correctable, instead
            // of showing the operator nothing. Every trust exclusion above is unchanged - only the
            // status clause widened, and nothing here creates an alias or marks anything verified.
            // FLOOR-GUESS EXCLUSION (F5): the prefix-floor naming aid ("<Brand> / product unconfirmed")
            // passes isUsableProductName and carries a brand, but it names NO product - it is a GS1
            // prefix statistic, not a candidate identity. Putting a one-tap Approve on it would teach an
            // approved alias for a product nobody ever identified, which is exactly the trust line the
            // best-guess decision kept strict. Such a row keeps the honest floor text with Edit/Identify.
            const suggestionInline =
              autoAddOn &&
              !autoSuggestApplied &&
              !multiVariantIdentity &&
              (decision?.status === "suggested" || decision?.status === "needs_review") &&
              isUsableProductName(best?.productName ?? "") &&
              !isFloorGuessOnlyLabel(suggestionFields.suggestedProductName) &&
              !contextConflict &&
              !(tireScan && !fastWasVerified);
            if (suggestionInline) {
              const pendingSuggestion = {
                productName: suggestionFields.suggestedProductName,
                brand: suggestionFields.suggestedBrand,
                confidence: decision?.confidence ?? 0,
                band: getIdentityConfidenceBand(decision),
                status: "pending" as const,
              };
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId && r.status === "open" ? { ...r, status: "suggested" as const } : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" && !e.suggestion
                    ? { ...e, suggestion: pendingSuggestion }
                    : e,
                ),
              }));
            }
            syncDecodedState(reviewId);
          }
        } catch (e) {
          if (wasInvalidated()) return;
          if (deterministicOnly && trustedExactProbes.has(reviewId)) {
            materializeTrustedExactMiss(
              reviewId,
              "Trusted exact lookup was unavailable. Saved locally and counted as unverified; retry to identify when back online.",
            );
            return;
          }
          const nextBreaker = recordFailure(gate.breaker, nowMs);
          // Emit only on the closed/half-open -> open transition. This best-effort request must not
          // participate in the scan/decode control flow or report a raw scan/provider error.
          if (gate.breaker.state !== "open" && nextBreaker.state === "open") {
            void postTelemetry("breaker_open", "decode_failure_threshold_reached");
          }
          // Task 2: a daily_cap 429 gets its own honest, non-retry-promising copy - there is no
          // automatic decode-on-cap-reset queue, so telling the user to just wait would be false.
          // Every other failure (network / self-inflicted rate limit / provider error) keeps the
          // existing generic copy unchanged.
          const failReason =
            e instanceof DailyCapReachedError
              ? e.accountScoped
                ? "Your account's daily AI lookup cap is reached. This scan is saved and counted as unverified. Retry after the cap resets."
                : "Daily AI lookup cap reached. This scan is saved and counted as unverified. Retry after the cap resets."
              : e instanceof DecodeAbortedError
                ? "Decode is taking longer than expected - it keeps working in the background; check Needs Review shortly"
                : // DEFECT 2 (untrusted string leak): NEVER surface the raw browser/provider error
                  // ("Failed to fetch", DNS errors, etc.) in the user-facing Reason column. Map every
                  // network/provider failure to honest human copy; the technical detail stays only in
                  // the debug-only aiLookupLogs error entry written below (mkLog), never on the row.
                  "Live decode failed (network / rate-limit / provider error). Saved locally and counted as unverified; retry to identify when back online.";
          // DECODE-EVERYTHING (owner): a FAILED decode (timeout / 429 rate-limit / provider error / AI down)
          // must NOT leave the scan blank. We still COUNT it as an UNVERIFIED, reviewable provisional row with
          // a SAFE label and the scanned code - never a fabricated product identity, never an approved alias,
          // never a verified product. The review STAYS OPEN so a retry can identify it.
          const code = review.cleanCode;
          // PREFIX FLOOR (Plan C Task 3): a failed decode must not leave a bare "Unidentified item"
          // when the GS1 prefix maps to a known brand - see prefixFloorName. Label text comes from the
          // shared provisionalPlaceholderName helper (same one ensureProvisionalCount uses) so this
          // mint can never drift from what resolveUnknown's reload-resilient fallback expects to match.
          // P2 (Task 8): on a daily_cap block the SERVER already resolved the floor and threaded it through
          // the 429 body; prefer that authoritative floor when present (falls back to the identical local
          // recompute for every other failure). The honest cap reason text (failReason) is unchanged.
          const capFloor = e instanceof DailyCapReachedError ? e.floor : undefined;
          const floor = capFloor ?? prefixFloorName(code, codeType);
          const fbName = capFloor?.name ?? provisionalPlaceholderName(code);
          const cur = get();
          const countedIds = new Set(cur.finalCounts.map((c) => c.productId));
          let provId = cur.products.find(
            (p) =>
              countedIds.has(p.id) &&
              p.status !== "archived" &&
              [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
          )?.id;
          if (!provId) {
            provId = `prod-${idFactory()}`;
            const provProduct: Product = {
              id: provId, businessId: cur.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
              specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
              aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_gemini",
              confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
            };
            set((st) => ({ products: [...st.products, provProduct] }));
          } else if (floor) {
            // F5 bundle-surgery: the row was pre-counted at scan time by ensureProvisionalCount, whose
            // CLIENT-SAFE (SEED/LEARNED) lookup may have missed a DERIVED-tier brand the server knows
            // (capFloor from the 429 body, or a local hit). If the existing row still carries the bare
            // "Unidentified item" fallback for this code, upgrade it in place with the floor's
            // brand-confident naming aid - exactly what the pre-split synchronous path produced. Never
            // clobbers a real decoded/human name (bare-label guard), never verified, never a re-count.
            const targetId = provId;
            set((st) => ({
              products: st.products.map((p) =>
                p.id === targetId && p.provisional === true && p.verified !== true && isBareUnidentifiedLabel(p.name, code)
                  ? { ...p, name: floor.name, brand: floor.brand, updatedAt: now(), updatedBy: "ai" }
                  : p,
              ),
            }));
          }
          const evF = get().scanFeed.find((ev) => ev.cleanCode === code && ev.status !== "known");
          let countsF = get().finalCounts;
          let qtyF = 0;
          if (evF) {
            const r = incrementInventoryCount(countsF, { ...evF, matchedProductId: provId, status: "known", quantityDelta: 1 }, idFactory);
            countsF = r.counts;
            qtyF = r.count.quantity;
          }
          set((st) => ({
            finalCounts: countsF,
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    decodeStatus: "needs_review",
                    reason: failReason,
                    // F5 bundle-surgery: a bare "Unidentified item" suggestion (stamped at scan time by
                    // the client-safe SEED/LEARNED lookup) upgrades to the floor's brand-confident name
                    // (fbName carries the server-authoritative capFloor when present) - exactly what the
                    // pre-split synchronous path produced. A REAL suggestion is never overwritten.
                    suggestedProductName:
                      r.suggestedProductName && !isBareUnidentifiedLabel(r.suggestedProductName, code)
                        ? r.suggestedProductName
                        : fbName,
                    // STABLE-ID FIX: capture the placeholder id (freshly minted above, or reused if one
                    // already existed) so resolveUnknown can re-link by id after a customer reload.
                    provisionalProductId: r.provisionalProductId ?? provId ?? null,
                  }
                : r,
            ),
            scanFeed: st.scanFeed.map((ev) =>
              evF && ev.id === evF.id
                ? { ...ev, matchedProductId: provId!, status: "known", quantityAfterScan: qtyF, decodeStatus: "suggested", reason: failReason }
                : ev.cleanCode === code && ev.decodeStatus === "decoding"
                  ? { ...ev, decodeStatus: "needs_review", reason: failReason }
                  : ev,
            ),
            aiLookupLogs: [mkLog("error", "decode", 0, nextBreaker), ...st.aiLookupLogs],
            breaker: nextBreaker,
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastFailureReason: failReason },
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
          // F5 bundle-surgery: only worth enriching when neither the server-authoritative cap floor nor
          // the client-safe (SEED/LEARNED) lookup found a brand - capFloor already used the FULL index.
          if (!capFloor && !floor && provId) get().enrichPrefixFloorLabel(code, provId);
        }
      },

      ensureProvisionalCount: (code, reason, opts) => {
        const st0 = get();
        const freshTransferKeys = opts?.freshTransferKeys === true;
        const countIfFeedMissing = opts?.countIfFeedMissing !== false;
        // IDEMPOTENT: if this code is already counted (any path), do nothing - never double count.
        const counted = new Set(st0.finalCounts.map((c) => c.productId));
        const existing = st0.products.find(
          (p) =>
            counted.has(p.id) &&
            p.status !== "archived" &&
            [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
        );
        if (existing) {
          if (!opts?.verifyEventId) return existing.id;
          // FINDING 2 FIX (Codex clean-room review, 2026-08-16): do not trust "a count already exists
          // for this code" as proof THIS physical scan's own event was ever applied - the caller (the
          // Layer C recovery fallback) only reaches this opt-in path after an unexpected throw, and the
          // existing ledger row may be exactly the stale/corrupted record that caused it. Verify the
          // event id is actually present before treating this as a genuine idempotent no-op.
          const ledgerRow = st0.finalCounts.find(
            (c) => c.productId === existing.id && c.sessionId === st0.sessionId,
          );
          const alreadyLanded =
            Array.isArray(ledgerRow?.scanEventIds) && ledgerRow.scanEventIds.includes(opts.verifyEventId);
          if (alreadyLanded) return existing.id;
          // Not landed: force-count THIS scan against the SAME existing product now - never mint a
          // duplicate product row for a code that already has one, and never silently drop the scan
          // just because an (unrelated or stale) count for the same code happened to already exist.
          const forceReason = reason || "Recovered count (existing ledger entry for this code did not include this scan).";
          const forcedEvent: ScanEvent = {
            id: opts.verifyEventId,
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            rawCode: code,
            cleanCode: code,
            normalizedCandidates: [],
            matchedProductId: existing.id,
            matchType: "unknown",
            status: "known",
            resolverStatus: "needs_review",
            codeType: detectCodeType(code),
            reason: forceReason,
            quantityDelta: 1,
            quantityAfterScan: 0,
            createdAt: now(),
            source: "scan",
            notes: forceReason,
            syncStatus: "pending",
            syncError: null,
            idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, opts.verifyEventId, "INCREMENT_COUNT"),
          };
          const forced = incrementInventoryCount(st0.finalCounts, forcedEvent, idFactory);
          forcedEvent.quantityAfterScan = forced.count.quantity;
          set((st) => ({
            finalCounts: forced.counts,
            scanFeed: st.scanFeed.some((e) => e.id === forcedEvent.id)
              ? st.scanFeed.map((e) =>
                  e.id === forcedEvent.id
                    ? { ...e, matchedProductId: existing.id, status: "known" as const, quantityAfterScan: forcedEvent.quantityAfterScan, quantityDelta: 1 }
                    : e,
                )
              : [forcedEvent, ...st.scanFeed],
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();
          const forcedIncPayload: IncrementPayload = {
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            productId: existing.id,
            scanEventId: forcedEvent.id,
            quantityDelta: 1,
            idempotencyKey: forcedEvent.idempotencyKey,
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "ScanEvent", entityId: forcedEvent.id, operation: "SAVE_SCAN_EVENT",
              payload: forcedEvent,
              idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, forcedEvent.id, "SAVE_SCAN_EVENT"),
              scanEventId: forcedEvent.id,
            }),
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "InventoryCount", entityId: forced.count.id, operation: "INCREMENT_COUNT",
              payload: forcedIncPayload,
              idempotencyKey: forcedEvent.idempotencyKey,
              scanEventId: forcedEvent.id,
            }),
          ]);
          return existing.id;
        }
        // Code-type aware label: a SAFE "Unidentified item" + the scanned code. NEVER fabricate manufacturer
        // anatomy here (no decode response). PREFIX FLOOR (Plan C Task 3): unless the GS1 prefix maps to a
        // known brand, in which case the row states the brand with confidence and flags the product
        // unconfirmed - see prefixFloorName. Label text comes from the shared provisionalPlaceholderName
        // helper so resolveUnknown's reload-resilient provOrphanId fallback can reconstruct the identical
        // name purely from the code, even after the customer persist split strips this row's identity fields.
        const ct = detectCodeType(code);
        const floor = prefixFloorName(code, ct);
        const fbName = provisionalPlaceholderName(code);
        const provId = `prod-${idFactory()}`;
        const provProduct: Product = {
          id: provId, businessId: st0.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
          specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
          aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_gemini",
          confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
        };
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        let countId: string | null = null;
        // LAW FIX: no matching scanFeed row exists for this code (e.g. a persist-trimmed feed, or a
        // review whose backing event was otherwise lost) is NOT a reason to silently count nothing -
        // this function still mints the provisional product below, and a scan that already went to
        // Needs Review must still count once it is resolved. Mint a SYNTHETIC BACKING EVENT (same
        // precedent as markWrong's feed-trim safety net, scanStore.ts ~5622) so replayLedgerCounts can
        // reproduce the quantity from feed events alone - never a naked quantity bump.
        const countedEvent = ev
          ? { ...ev, matchedProductId: provId, status: "known" as const, quantityDelta: 1 }
          : countIfFeedMissing
            ? ({
              id: idFactory(),
              businessId: st0.businessId,
              sessionId: st0.sessionId,
              rawCode: code,
              cleanCode: code,
              normalizedCandidates: [],
              matchedProductId: provId,
              matchType: "unknown",
              status: "known" as const,
              resolverStatus: "needs_review",
              codeType: ct,
              reason: reason || "Recovered count (scan record was missing)",
              quantityDelta: 1,
              quantityAfterScan: 0,
              createdAt: now(),
              source: "scan",
              notes: reason || "Recovered count (scan record was missing)",
              syncStatus: "pending",
              syncError: null,
              idempotencyKey: "",
            } as ScanEvent)
            : null;
        if (!ev && countedEvent) {
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, st0.sessionId, countedEvent.id, "INCREMENT_COUNT");
        } else if (freshTransferKeys && countedEvent && ev) {
          // F-03: markWrong/orphan-transfer callers repoint an EXISTING feed row that may already have
          // been synced under its PREVIOUS (wrong) identity. Reusing its inherited idempotencyKey here
          // would resend the SAME key against a DIFFERENT productId - Firestore's applied-key dedupe
          // stores the ORIGINAL marker (targetId = old productId) and rejects the mismatched replay as
          // idempotency_conflict (retryable:false), so the correction never reaches the backend. Mint a
          // FRESH transfer key (never the original counting key) so this repoint is a genuinely new,
          // never-before-applied write.
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, ev.sessionId, `${ev.id}:transfer:${provId}`, "INCREMENT_COUNT");
        }
        if (countedEvent) {
          const r = incrementInventoryCount(counts, countedEvent, idFactory);
          counts = r.counts.map((c) =>
            c.productId === countedEvent.matchedProductId && c.sessionId === countedEvent.sessionId
              ? { ...c, location: countedEvent.location }
              : c,
          );
          qty = r.count.quantity;
          countId = r.count.id;
          countedEvent.quantityAfterScan = qty;
        }
        set((st) => ({
          products: [...st.products, provProduct],
          finalCounts: counts,
          needsReviewQueue: st.needsReviewQueue.map((r) =>
            r.cleanCode === code && r.status === "open"
              ? {
                  ...r,
                  decodeStatus: "needs_review",
                  reason: r.reason || reason,
                  suggestedProductName: r.suggestedProductName || fbName,
                  // STABLE-ID FIX: this placeholder (provId, minted just above) belongs to THIS review's
                  // code. Stamp its id so resolveUnknown can re-link by id after a customer reload, instead
                  // of by reconstructed name (see provisionalProductId doc comment in types.ts). Only set
                  // when not already stamped (idempotent; never clobber a value set earlier).
                  provisionalProductId: r.provisionalProductId ?? provId,
                }
              : r,
          ),
          scanFeed: ev
            ? st.scanFeed.map((e) =>
                e.id === ev.id
                  ? {
                      ...e,
                      matchedProductId: provId,
                      status: "known",
                      quantityAfterScan: qty,
                      // Preserve an IN-FLIGHT "Decoding..." badge (a live decode is actually running) so the
                      // documented "Decoding -> Verified / Suggested / Conflict / Needs review" UI stays visible;
                      // only stamp "suggested" when there is no decode in flight.
                      decodeStatus: e.decodeStatus === "decoding" ? "decoding" : "suggested",
                      // D1 FIX: the stored feed event and the counted delta are the SAME FACT - the row a
                      // provisional count was applied from must carry the delta it contributed (North-star #2:
                      // sum(feed deltas) === quantity). And the fake optimistic "synced" stamp is GONE: the
                      // row's syncStatus is derived from pendingSyncQueue membership (see the reconcile at
                      // scanStore.ts:907-922) and only reads "synced" after a real sync ack.
                      quantityDelta: 1,
                      reason: e.reason || reason,
                    }
                  : e,
              )
            // No matching feed row: prepend the synthetic backing event so the feed still carries the
            // exact fact that was counted (North-star #2: sum(feed deltas) === quantity), same
            // precedent as markWrong's residual-repoint synthetic event.
            : countedEvent
              ? [countedEvent, ...st.scanFeed]
              : st.scanFeed,
        }));
        // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW) - and only
        // when this call actually counted something (countedEvent), never on a no-op/idempotent re-entry.
        if (countedEvent) markFirstScanIfNeeded();
        // D1 FIX: a provisional count is real inventory. Enqueue its ledger writes through the SAME sync
        // queue mechanism every counted scan uses. SAVE_SCAN_EVENT + INCREMENT_COUNT mirror the countable
        // branch's two ops (scanStore.ts:1397-1422); SAVE_PRODUCT for the freshly minted provisional is a
        // NEW op on the scan path (precedent: resolveUnknown's SAVE_PRODUCT enqueue, :3912-3930). The
        // INCREMENT_COUNT key is the event's own key minted in processScan - reused verbatim, never
        // regenerated (Idempotent Sync Rules).
        if (countedEvent && countId) {
          const bId = st0.businessId;
          const sId = countedEvent.sessionId;
          const incPayload: IncrementPayload = {
            businessId: bId, sessionId: sId, productId: provId, scanEventId: countedEvent.id,
            quantityDelta: 1, idempotencyKey: countedEvent.idempotencyKey,
          };
          // F-03: the SAVE_SCAN_EVENT key normally reconstructs deterministically from the event's own id
          // (safe on the FIRST-ever sync of that id). A freshTransferKeys repoint reuses an id that may
          // ALREADY be synced under the previous identity, so it needs the SAME `:transfer:${provId}`
          // suffix as the INCREMENT_COUNT key above (never the bare id) or Firestore's applied-key dedupe
          // rejects the corrected payload as idempotency_conflict.
          const saveScanEventKey = freshTransferKeys
            ? buildIdempotencyKey(bId, sId, `${countedEvent.id}:transfer:${provId}`, "SAVE_SCAN_EVENT")
            : buildIdempotencyKey(bId, sId, countedEvent.id, "SAVE_SCAN_EVENT");
          enqueueAndSync([
            // Task 1b fix (same recipe as correctProduct, commit 024c849): a bare
            // `businessId:sessionId:provId:SAVE_PRODUCT` key collides with resolveUnknown's later
            // orphan-merge SAVE_PRODUCT for this SAME id (it reuses provOrphanId - scanStore.ts ~4791),
            // which would otherwise be swallowed as "alreadyApplied" and the resolved identity would
            // never reach the backend. Suffix `:provisional` so the first (placeholder) write and any
            // later distinct write to this id mint different keys; the key is still minted once here and
            // reused verbatim on every retry of THIS item, so retry dedupe is unaffected.
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "Product", entityId: provId, operation: "SAVE_PRODUCT", payload: provProduct, idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"), scanEventId: null }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "ScanEvent", entityId: countedEvent.id, operation: "SAVE_SCAN_EVENT", payload: countedEvent, idempotencyKey: saveScanEventKey, scanEventId: countedEvent.id }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "InventoryCount", entityId: countId, operation: "INCREMENT_COUNT", payload: incPayload, idempotencyKey: countedEvent.idempotencyKey, scanEventId: countedEvent.id }),
          ]);
        } else if (!countedEvent) {
          const bId = st0.businessId;
          const sId = st0.sessionId;
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId: bId,
              sessionId: sId,
              entityType: "Product",
              entityId: provId,
              operation: "SAVE_PRODUCT",
              payload: provProduct,
              idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"),
              scanEventId: null,
            }),
          ]);
        }
        // F5 bundle-surgery: the row already appeared + counted above (TOP-LEVEL LAW unaffected). Only
        // worth an enrichment fetch when the client-safe (SEED/LEARNED) lookup found nothing - a
        // DERIVED-tier hit is still possible server-side.
        if (!floor) get().enrichPrefixFloorLabel(code, provId);
        return provId;
      },

      enrichPrefixFloorLabel: (code, productId) => {
        // Fire-and-forget: never awaited by any caller, never blocks/delays the row that already
        // appeared + counted synchronously. Deferred a tick so any SYNCHRONOUS same-call resolution
        // (catalog-first hit, deterministic alias, a decode landing in the same stack) renames the row
        // first and the pre-fetch bare-label check below skips the network call entirely - the fetch
        // only fires for a row that genuinely settled as a bare "Unidentified item".
        setTimeout(() => {
          if (!get().online) return; // offline: no fetch, label silently stays (retry is not needed - naming aid only)
          if (enrichInFlight.has(productId)) return; // one enrichment round-trip per row, never a duplicate fetch
          const before = get().products.find((p) => p.id === productId);
          if (!before || !isBareUnidentifiedLabel(before.name, code)) return; // already identified: no fetch
          enrichInFlight.add(productId);
          void fetchPrefixFloorEnrichment(code).finally(() => enrichInFlight.delete(productId)).then((floor) => {
            if (!floor) return; // offline / no derived-tier hit / non-barcode-shaped code: silent no-op
            const prod = get().products.find((p) => p.id === productId);
            // Re-check after the round-trip too: only upgrade if the row STILL carries the exact bare
            // fallback label for this code - a decode may have landed (real name), or a human may have
            // edited it, while the fetch was in flight. Never clobber anything but the bare placeholder.
            if (!prod || !isBareUnidentifiedLabel(prod.name, code)) return;
            set((s) => ({
              products: s.products.map((p) =>
                p.id === productId ? { ...p, name: floor.name, brand: floor.brand } : p,
              ),
            }));
          });
        }, 0);
      },

      markFeedRowVerified: (cleanCode, reason, provenance) => {
        set((s) => ({
          scanFeed: s.scanFeed.map((e) =>
            e.cleanCode === cleanCode && e.status !== "resolved" && e.decodeStatus !== "verified"
              ? {
                  ...e,
                  decodeStatus: "verified" as ScanEvent["decodeStatus"],
                  reason: reason || e.reason,
                  // STALE-NOTE FIX (goupc-cap-rootcause item 3): the row just settled to verified - drop
                  // any leftover in-flight "Decoding with AI..." note (see the main settle block above).
                  decodeNote: undefined,
                  // P5 Task 5: additive, optional. Only set when the caller passed one (see the
                  // interface comment) - display only, never gates counting/auto-count.
                  provenance,
                }
              : e,
          ),
        }));
      },

      applyDecodeFallback: (reviewId, reason) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        get().ensureProvisionalCount(review.cleanCode, reason);
      },

      backgroundVerifyDeep: async (reviewId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        // IDEMPOTENCY GUARD: only an OPEN review is ever acted on. The fast-path resolveUnknown (or an
        // earlier deep response) flips the review to "resolved" the instant it counts, so a late or
        // duplicate deep response that re-enters here finds status !== "open" and returns - it can never
        // double-count or duplicate the alias. This reuses the SAME open-status gate liveDecode relies on.
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        // Reuse the EXACT auto-decode gate (online + AI on + configured + not stopped + under cap +
        // breaker closed). No new gating is invented; a blocked state simply leaves the review open.
        // GOD CLIENT (owner-approved 2026-08-07): background deep-verify follow-up must not silently
        // re-block the platform owner either - see `applyGodGateOverride`.
        const gate = applyGodGateOverride(
          evaluateAiGate({
            enabled: s.aiLookupEnabled,
            online: state.online,
            dailyCount,
            dailyLimit: s.dailyLookupLimit,
            breaker: state.breaker,
            now: nowMs,
          }),
          isPlatformOwnerForGateBypass(state.userId),
        );
        if (!gate.allowed) return;

        const rawCodeSanitized = sanitizeForAiLookup(review.rawCode).clean;
        const cleanCodeSanitized = sanitizeForAiLookup(review.cleanCode).clean;
        const codeType = detectCodeType(review.cleanCode);

        let data: {
          decision?: DecodeDecision;
          results?: AiLookupResult[];
        };
        try {
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST (route.ts:294-324)
          // or this 401s "unauthenticated" - mock mode resolves {} and is unaffected.
          // P4 (#28): shared backoff helper - background enrichment only, still silently gives up
          // (`if (!res.ok) return;` below) on a final 429, unchanged; this only adds honest-Retry-
          // After/jittered resilience before that give-up point.
          const res = await fetchWithBackoff("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(await aiRequestAuth(state.businessId)),
              mode: "decode-deep",
              // MANDATORY: without scanContext "tire" the route's page-fetch verify gate cannot fire,
              // so the exact UPC is never app-verified and decideDecode can never return "verified"
              // (proven live). This is the whole point of the background pass.
              scanContext: "tire",
              rawCode: rawCodeSanitized,
              cleanCode: cleanCodeSanitized,
              codeType,
              confidenceThreshold: 0.85,
              allowImageSuggestions: s.allowImageSuggestions,
            }),
          });
          if (!res.ok) return; // never throw into the scan flow; leave the review open for the human
          data = await res.json();
        } catch {
          // Network/provider failure on the BACKGROUND pass must be silent: the row is already shown as
          // suggested/needs_review and the human can still resolve it. Never surface a scary error here.
          return;
        }

        // COST METERING: a successful deep fetch is a REAL provider call, so it must count against the
        // daily cap exactly like liveDecode does (same field, same +1, same set/persist pattern). Only a
        // real provider call reaches here - a non-OK response or a thrown fetch returned above, uncounted.
        set((st) => ({
          settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
        }));

        const decision = data.decision;
        const results: AiLookupResult[] = data.results ?? [];
        const best = results[0] ?? null;

        // Re-read the review: it may have been resolved (fast path / a concurrent deep response) while we
        // awaited the fetch. Only an OPEN review is upgraded - the idempotency backstop.
        const fresh = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!fresh || fresh.status !== "open") return;

        // NON-VERIFIED deep result: NEVER counts. If it carries a fuller product than the fast pass, refresh
        // the review's suggestion so the human sees better data; otherwise leave it untouched. No gate weakened.
        if (decision?.status !== "verified") {
          if (best && isUsableProductName(best.productName ?? "")) {
            const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
            set((st) => ({
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId && r.status === "open"
                  ? {
                      ...r,
                      suggestedProductName: tireFields?.description || best.productName || r.suggestedProductName,
                      suggestedBrand: tireFields?.brand ?? best.brand ?? r.suggestedBrand,
                      suggestedCategory: best.category ?? r.suggestedCategory,
                      suggestedSpecsShort: tireFields?.size ?? best.specsShort ?? r.suggestedSpecsShort,
                      suggestedSpecsFull: best.specsFull ?? r.suggestedSpecsFull,
                      suggestedPrimarySku: tireFields?.partNumber ?? best.primarySku ?? r.suggestedPrimarySku,
                      suggestedImageUrl: s.allowImageSuggestions ? (best.imageUrl ?? r.suggestedImageUrl) : r.suggestedImageUrl,
                      suggestedProductUrl: best.productUrl ?? r.suggestedProductUrl,
                      sourceUrls: best.sourceUrls ?? r.sourceUrls,
                      hasSuggestion: true,
                    }
                  : r,
              ),
            }));
          }
          // Task 9b (owner-ratified 2026-07-14 addition): the deep pass has now COMPLETED without
          // verifying - the identity is still only a suggestion, and suggestions never sit in Needs
          // Review. Convert this review to the same PENDING inline-suggestion state the fast path
          // uses (status "suggested" + approve/decline controls on the counted feed row). Guarded on
          // the review still being open (idempotent against duplicate/late deep responses) and on a
          // usable suggested identity; a deep result that returned a NEW identity is re-checked
          // against the context firewall first (the fast identity was already cleared before this
          // escalation ever fired - see the backgroundVerifyDeep trigger in runLiveDecodeOnce).
          const freshAfter = get().needsReviewQueue.find((r) => r.id === reviewId);
          // Same autoAddOn master-switch gate as the fast path: with autoAddDecodedProducts OFF the
          // owner asked for every decode to sit in manual review, so no inline conversion happens.
          // MULTI-VARIANT GATE (Group C): same rule as the fast path - never convert a multi-variant
          // listing into a pending inline suggestion, regardless of confidence/evidence.
          const deepMultiVariant = enrichProductIdentity({ payload: { name: freshAfter?.suggestedProductName ?? "" } }).multiVariant;
          if (
            (s.autoAddDecodedProducts ?? true) &&
            freshAfter &&
            freshAfter.status === "open" &&
            freshAfter.hasSuggestion &&
            isUsableProductName(freshAfter.suggestedProductName) &&
            !deepMultiVariant
          ) {
            const deepConflict =
              best && isUsableProductName(best.productName ?? "")
                ? detectScanContextConflict({
                    scanContext: s.scanContext ?? "any",
                    code: review.cleanCode,
                    codeType,
                    result: best,
                    brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
                    exactCodeVerifiedByApp: false,
                  })
                : null; // no new deep identity: the fast pass already cleared the firewall before escalating
            if (!deepConflict) {
              const pendingSuggestion = {
                productName: freshAfter.suggestedProductName,
                brand: freshAfter.suggestedBrand,
                confidence: freshAfter.confidence,
                band: getIdentityConfidenceBand(decision),
                status: "pending" as const,
              };
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId && r.status === "open" ? { ...r, status: "suggested" as const } : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" && !e.suggestion
                    ? { ...e, suggestion: pendingSuggestion }
                    : e,
                ),
              }));
            }
          }
          return;
        }

        // VERIFIED deep result: route through the SAME auto-count gate + verified-decode handling as
        // liveDecode (Task 6 alignment). This must reuse resolveUnknown so the count + alias-learn +
        // idempotency keys are identical to the fast path - we never re-implement counting here.
        const cleanName = cleanProductName(best?.productName ?? "");
        const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
        const avSettings = {
          autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
          autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
          trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
          aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
          allowNonPublicAutoCount: s.autoCountNonPublicWithEvidence ?? true,
        };
        const plan = planAutoVerify({
          code: review.cleanCode,
          codeType,
          decision: {
            status: decision.status,
            evidenceStrength: decision.evidenceStrength ?? "none",
            exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
            crossCheck: decision.crossCheck ?? {
              decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
            },
          },
          best,
          catalog: get().catalog,
          settings: avSettings,
        });

        const newProduct = {
          name: tireFields?.description || cleanName,
          brand: tireFields?.brand ?? best?.brand ?? "",
          category: best?.category ?? "",
          specsShort: tireFields?.size ?? best?.specsShort ?? "",
          specsFull: best?.specsFull ?? "",
          primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
          primaryBarcode: best?.primaryBarcode || review.cleanCode,
          gtin: best?.gtin ?? "",
          upc: best?.upc ?? "",
          ean: best?.ean ?? "",
          imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
          productUrl: best?.productUrl ?? "",
        };

        const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate (unchanged): false -> manual review
        // SAME Phase 7 evidence gate + Phase 8 firewall as liveDecode. A non-verified result never reaches
        // here, and a firewall/brand-prefix conflict (poison in tire context) still blocks the count.
        const tireOk = tireAutoCountOk(best);
        // Task 9 (owner-ratified 2026-07-14, decode-anything): app-verified exact-code evidence clears the
        // tire category hard-block; weak/unverified identities still hard-block (poison guard intact).
        const exactCodeVerifiedByApp =
          decision?.exactCodeEvidenceVerifiedByApp === true && decision?.status === "verified";
        const firewallParams = {
          scanContext: s.scanContext ?? "any",
          code: review.cleanCode,
          codeType,
          result: best,
          brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
          exactCodeVerifiedByApp,
        };
        const contextConflict = detectScanContextConflict(firewallParams);
        const offCategory = detectOffCategoryAdvisory(firewallParams);
        // SAME pure evidence gate as liveDecode (src/stores/scanGates.ts): Phase-7 corroboration + GPT
        // trust tier + T20/code-1225 public-barcode firewall, kept in sync so the two decode paths can
        // never drift apart again. tireOk + contextConflict are computed here and passed in.
        const evidenceGatePassed = canAutoCount({
          codeType,
          decision,
          productName: best?.productName ?? "",
          productNameUsable: isUsableProductName(best?.productName ?? ""),
          tireOk,
          contextConflict,
        }).allowed;

        if (autoAddOn && evidenceGatePassed && (plan.status === "auto_verify" || plan.status === "auto_count")) {
          // OPTION 3: non-public codes never write the global catalog ("auto_verify") - shop-local "ai" only.
          const isPublicCode = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(codeType);
          const origin = plan.status === "auto_count" ? "auto_count" : (plan.verifiedBy && isPublicCode) ? "auto_verify" : "ai";
          get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
          if (origin === "auto_verify") {
            get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
          }
          get().resolveUnknown(reviewId, "create_new", {
            applyToCount: true,
            origin,
            autoVerify:
              origin === "auto_verify"
                ? {
                    score: plan.score,
                    verifiedBy: plan.verifiedBy ?? "evidence_score",
                    sourceTier: plan.sourceTier,
                    reason: plan.reason,
                    evidenceSummary: plan.evidenceSummary,
                    sourceUrls: best?.sourceUrls ?? [],
                  }
                : undefined,
            newProduct,
          });
          // Flip the scan-feed badge to verified AFTER resolveUnknown, and ONLY when it actually resolved
          // the review (status "resolved"). The row may be "known" (counted synchronously) - markFeedRowVerified
          // flips it regardless of that, as long as it is not already resolved. BUG FIX (verified-shows-
          // Unidentified): resolveUnknown can silently no-op (fuzzy identity-merge suggest_link, or a dedup
          // conflict) and leave the review "open" with the placeholder product untouched - marking the row
          // "verified" in that case would show "Verified match" over the unresolved placeholder name.
          if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
            get().markFeedRowVerified(review.cleanCode, decision.reason ?? "");
          } else {
            // FIX (rung self-poisoning audit, owner-approved): resolveUnknown's create_new branch
            // already stamps "resolved" on every ACTUAL resolution. The only ways a review is still
            // open/suggested here are the two DELIBERATE human-required early-returns: the fuzzy
            // identity-merge suggest_link path (stamps suggestedLinkProductId + returns, keeping the
            // review open on purpose) and the multi-match dedup-conflict path (pushes this reviewId onto
            // lastAliasConflicts + returns, keeping it open on purpose). Only stamp when NEITHER
            // deliberate-hold signal fired for this exact review - status metadata only, never
            // scanFeed/finalCounts.
            const stillOpen = get().needsReviewQueue.find((r) => r.id === reviewId);
            const heldForSuggestLink = Boolean(stillOpen?.suggestedLinkProductId);
            const heldForConflict = (get().lastAliasConflicts ?? []).some((c) => c.reviewId === reviewId);
            if (stillOpen && (stillOpen.status === "open" || stillOpen.status === "suggested") && !heldForSuggestLink && !heldForConflict) {
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const }
                    : r,
                ),
              }));
            }
          }
          // Task 9: tag an app-verified off-category decode so the feed shows "Off-category item".
          if (offCategory) {
            set((st) => ({
              scanFeed: st.scanFeed.map((e) =>
                e.cleanCode === review.cleanCode ? { ...e, offCategory: true } : e,
              ),
            }));
          }
        } else if (contextConflict) {
          // FALSE-AUTO-COUNT BACKSTOP: a "verified" deep decode that contradicts the tire context (poison)
          // must NOT count. Keep it open with the safe conflict reason; the human relinks. Never weaken.
          set((st) => ({
            lastCategoryWarning:
              contextConflict === "category_context_conflict"
                ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                : st.lastCategoryWarning,
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId && r.status === "open" ? { ...r, reason: conflictReason(contextConflict) } : r,
            ),
          }));
        } else {
          // AUTO-SUGGEST-APPLY (owner order 2026-07-10, kept in sync with the same gate in liveDecode):
          // a verified deep decode that missed the full auto-count gate above (e.g. tireOk failed) can
          // still skip Needs Review as a SUGGESTION when confidence >= 0.8, OR this is an app-verified
          // exact decode (Go-UPC exact class). Apply the identity onto the existing provisional row IN
          // PLACE - product stays provisional:true/verified:false - and close the review. TRUST RULES:
          // no alias created, markFeedRowVerified never called, feed badge stays "suggested".
          const autoSuggestApplied = autoSuggestApplyOk({
            autoAddOn,
            contextConflict,
            productName: best?.productName ?? "",
            confidence: decision.confidence ?? 0,
            status: decision.status,
            exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
          });
          if (autoSuggestApplied) {
            const ownProvId =
              review.provisionalProductId ??
              get().products.find((p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === review.cleanCode)?.id;
            // BUG FIX (scan-order merge asymmetry, same class as the fast-path decode-everything branch):
            // before enriching THIS scan's own placeholder in place, check whether the decoded identity
            // already matches a DIFFERENT, already-verified product (e.g. an earlier scan of this same
            // physical item's barcode). Reuse the SAME size-aware findIdentityMerge primitive; auto_link
            // only (never the fuzzy suggest_link - that stays a human decision, unchanged).
            const countedIds = new Set(get().finalCounts.map((c) => c.productId));
            let mergeTargetId: string | null = null;
            if (best) {
              const mergeCandidates = get().products.filter(
                (p) => p.status !== "archived" && p.provisional !== true && p.id !== ownProvId,
              );
              // NOTE: deliberately OMITS primaryBarcode - canonicalOf (identityMerge.ts) reads it, and a
              // carried/decoded barcode must never become a merge key here (probe-B footgun); only the
              // decoded identity fields below are trusted for matching.
              const merge = findIdentityMerge(mergeCandidates, {
                gtin: best.gtin ?? null,
                upc: best.upc ?? null,
                ean: best.ean ?? null,
                brand: best.brand ?? null,
                name: best.productName ?? null,
                specsShort: best.specsShort ?? null,
                specsFull: best.specsFull ?? null,
              });
              if (merge.kind === "auto_link" && countedIds.has(merge.productId) && merge.productId !== ownProvId) {
                mergeTargetId = merge.productId;
                emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code: review.cleanCode } });
              }
            }
            if (mergeTargetId) {
              const targetProduct = get().products.find((p) => p.id === mergeTargetId);
              if (targetProduct) {
                const built = buildAliasesForCodes({
                  product: targetProduct,
                  codes: [review.cleanCode],
                  existingAliases: get().aliases,
                  businessId: state.businessId,
                  sessionId: state.sessionId,
                  idFactory,
                  now,
                  source: "ai_gemini",
                  createdBy: "ai",
                });
                if (built.aliases.length > 0) {
                  set((st) => ({
                    aliases: [...st.aliases, ...built.aliases],
                    pendingSyncQueue: [...st.pendingSyncQueue, ...built.queued],
                  }));
                }
              }
              if (ownProvId && ownProvId !== mergeTargetId) {
                const oid = ownProvId;
                const targetId = mergeTargetId;
                // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
                // local-only transfer leaves the backend holding the orphan's count forever.
                const transferOps = buildOrphanTransferSyncOps({
                  finalCountsBeforeTransfer: get().finalCounts,
                  scanFeedBeforeTransfer: get().scanFeed,
                  oid,
                  targetId,
                  businessId: state.businessId,
                  idFactory,
                  now,
                });
                set((st) => {
                  const finalCounts = transferOrphanCount(st.finalCounts, oid, targetId, now());
                  return {
                    products: st.products.filter((p) => p.id !== oid),
                    finalCounts,
                    scanFeed: st.scanFeed.map((e) =>
                      e.matchedProductId === oid
                        ? { ...e, matchedProductId: targetId, decodeStatus: e.decodeStatus !== "verified" ? ("suggested" as const) : e.decodeStatus }
                        : e,
                    ),
                    needsReviewQueue: st.needsReviewQueue.map((r) =>
                      r.id === reviewId
                        ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                        : r,
                    ),
                  };
                });
                if (transferOps.length > 0) enqueueAndSync(transferOps);
              } else {
                set((st) => ({
                  needsReviewQueue: st.needsReviewQueue.map((r) =>
                    r.id === reviewId
                      ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                      : r,
                  ),
                }));
              }
            } else if (ownProvId) {
              const provId = ownProvId;
              set((st) => ({
                products: st.products.map((p) =>
                  p.id === provId
                    ? {
                        ...p,
                        name: tireFields?.description || cleanName || p.name,
                        brand: tireFields?.brand ?? best?.brand ?? p.brand,
                        category: best?.category ?? p.category,
                        specsShort: tireFields?.size ?? best?.specsShort ?? p.specsShort,
                        specsFull: best?.specsFull ?? p.specsFull,
                        primarySku: p.primarySku || (tireFields?.partNumber ?? best?.primarySku ?? ""),
                        gtin: p.gtin || (best?.gtin ?? ""),
                        upc: p.upc || (best?.upc ?? ""),
                        ean: p.ean || (best?.ean ?? ""),
                        imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? p.imageUrl) : p.imageUrl,
                        productUrl: best?.productUrl || p.productUrl,
                        confidence: decision.confidence ?? p.confidence,
                        updatedAt: now(),
                        updatedBy: "ai",
                      }
                    : p,
                ),
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                    : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" ? { ...e, decodeStatus: "suggested" as const } : e,
                ),
              }));
            }
          }
          // else: verified-but-gate-blocked-for-another-reason (e.g. autoAdd off, incomplete specs, or no
          // usable name/confidence < 0.8 and not app-verified-exact). The fast pass already left an
          // accurate review row; we leave it for the human (never count a blocked result).
        }
      },

      resolveUnknown: (reviewId, action, payload) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        // Idempotency / re-entry guard: only act on a review still AWAITING a decision - OPEN, or a
        // PENDING inline suggestion ("suggested", Task 9b owner-ratified 2026-07-14: the feed row's
        // inline approve routes through this exact core, so a parked suggestion must be resolvable
        // here). A double-click, or a race where a background decode resolves the same review while a
        // human approves it, must NOT re-run applyToCount -> a second count of the same physical item:
        // resolved/ignored stays a hard no-op. Matches the open-status guard already used by
        // liveDecode / backgroundVerifyDeep / cloudCatalogResolve / correctionRecheck.
        if (!review || (review.status !== "open" && review.status !== "suggested")) return;

        if (action === "ignore") {
          set({
            needsReviewQueue: state.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? { ...r, status: "ignored", resolvedAt: now(), resolutionAction: "ignore" }
                : r,
            ),
          });
          get().recordFeedback("product_rejected", { code: review.cleanCode });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_rejected", metadata: { code: review.cleanCode } });
          return;
        }

        // Determine target product (existing or newly created).
        let products = state.products;
        let productId = payload.productId ?? "";
        let createdProduct: Product | null = null; // persisted to Firestore (cloud backend) via SAVE_PRODUCT
        // Phase-2 POISON GUARD: set true in the mint branch below when create_new is ACCEPTING the
        // review's evidence-less AI suggestion (the 078742051451 -> "Velvet Torch dress" class). A weak
        // guess is minted UNVERIFIED, its alias is left UNAPPROVED, no verified catalog entry is written,
        // and it is NOT counted - so a future scan never resolves deterministically to a wrong product.
        let weakGuessProduct = false;
        // PHASE 2: set true when this resolution is CONFIRMING an existing PROVISIONAL count (the reused
        // product was provisional). The provisional was already counted, so the approval must NOT re-count
        // (no double-count) - it only upgrades the product to verified + adds the approved alias.
        let approvingProvisional = false;

        // TASK 3 (scan N = count N): ensureProvisionalCount mints a provisional placeholder product for every
        // unresolved scan and counts it synchronously. When the human/decode later resolves that code to a
        // DIFFERENT product (or a genuine conflict), the placeholder must be merged/removed so a unique code
        // never leaves a duplicate product row. `provOrphanId` is that placeholder for THIS review's code;
        // `removeOrphanId` / `orphanTransferTargetId` drive the merge at commit time.
        const countedIdsForOrphan = new Set(state.finalCounts.map((c) => c.productId));
        // STABLE-ID FIX (kills the prefix-floor placeholder-name collision, task-STABLEID): try the review's
        // OWN stable `provisionalProductId` FIRST - captured at review-creation/mint time (see the doc
        // comment on the field in types.ts) and reload-resilient because it is a local product id, never a
        // barcode/gtin (safe to persist to a customer's disk; survives the customer persist split). This is
        // bulletproof against name collisions: a prefix-floor placeholder name is BRAND-ONLY
        // ("<Brand> / product unconfirmed", not code-specific), so two different unresolved codes sharing a
        // GS1-prefix brand mint the IDENTICAL name - the old name-based fallback below could then attribute
        // one code's count to the OTHER code's review. A plain id has no such collision.
        const stableOrphanId =
          review.provisionalProductId &&
          state.products.find(
            (p) => p.id === review.provisionalProductId && countedIdsForOrphan.has(p.id) && p.status !== "archived",
          )?.id;
        const provOrphanId =
          stableOrphanId ??
          state.products.find(
            (p) =>
              p.provisional === true &&
              countedIdsForOrphan.has(p.id) &&
              p.status !== "archived" &&
              [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku]
                .map((c) => (c ?? "").trim())
                .includes(review.cleanCode),
          )?.id ??
          // BACKWARD-COMPAT NAME FALLBACK: only reached when the review has no usable `provisionalProductId`
          // (a review persisted/created before this field existed) AND the strict identifier match above
          // found nothing. A customer's localStorage persist strips a product's `provisional` flag AND its
          // identifier fields (primaryBarcode/gtin/upc/ean/primarySku - CUSTOMER_SAFE_PRODUCT_FIELDS never
          // persists them; see scanPersist.ts / sensitiveFields.ts), so for an OLD review minted before the
          // stable id existed, this reconstructed-name match is the only way left to re-identify the scan's
          // own placeholder after a reload. Known limitation (accepted, low-likelihood, non-blocking per
          // task-FINALREVIEW-report.md): a prefix-floor name is brand-only, so this fallback can still
          // collide for two OLD reviews sharing a prefix-floor brand - closed for every review going forward
          // by the stable id above.
          state.products.find(
            (p) =>
              countedIdsForOrphan.has(p.id) &&
              p.status !== "archived" &&
              p.name === provisionalPlaceholderName(review.cleanCode),
          )?.id ??
          null;
        let removeOrphanId: string | null = null;
        let orphanTransferTargetId: string | null = null;

        if (action === "create_new") {
          const np = payload.newProduct ?? {};
          // A person confirmed this identity (typed it or tapped Approve on it): the weak-guess poison
          // guard, which exists to stop an evidence-less AI suggestion becoming verified by itself, does
          // not apply. "tenant_approval" differs from "human" ONLY in what is written platform/device-wide.
          const humanConfirmed = payload.origin === "human" || payload.origin === "tenant_approval";

          // DEDUP GUARD (data correctness): every auto-add path (AI auto-add, catalog auto-count) funnels
          // through create_new, so without this one barcode could spawn dozens of identical product rows
          // (the 235x "Manstel rivet kit" bug). Before minting a product, look for an existing one this
          // identity already belongs to, using the SAME deterministic matcher the resolver uses (approved
          // alias OR verified product identifier) so dedup never drifts from resolve.
          const identityCodes = [...new Set(
            [review.cleanCode, np.primaryBarcode, np.gtin, np.upc, np.ean, np.primarySku]
              .map((c) => (c ?? "").trim())
              .filter(Boolean),
          )];
          // P5/D5: use the cross-tier-conflict-aware resolver here too so a code that conflicts across
          // tiers (e.g. an approved alias for one product vs. a verified identifier for another) is
          // never silently dedup-merged into a single product row. Master slot stays empty on purpose
          // (GC2/AC6): this dedup guard is a sync helper inside resolveUnknown, not the async
          // cloudCatalogResolve enrichment path where Phase 5b (Task 4, ~scanStore.ts:2460) wires the
          // real tenant-vs-master conflict feed via services/catalog/masterCandidates.ts.
          const matchedIds = new Set<string>();
          for (const codeStr of identityCodes) {
            const res = resolveScanToProductTiered(
              cleanScanCode(codeStr),
              { products: state.products, aliases: state.aliases, masterCandidates: [] },
              state.businessId,
            );
            if (res.matchType === "conflict") (res.conflictProductIds ?? []).forEach((id) => matchedIds.add(id));
            else if (res.productId) matchedIds.add(res.productId);
          }

          // ORPHANED-COUNT DEDUP: also reuse a product that is STILL COUNTED (has a surviving finalCounts
          // row) whose own identifier fields exactly match the scanned code - even if it is no longer
          // verified or approved-aliased. A persist/session reset can drop a counted product's approved
          // alias AND its `verified` flag (the customer-safe persist strips both) while its count survives,
          // which makes resolveScanToProduct miss it and used to mint a duplicate. This is a DETERMINISTIC
          // exact identifier match (never fuzzy name), and it is scoped to products that are ACTIVELY
          // COUNTED, so a markWrong'd product (whose count was removed) is never silently reused.
          //
          // B2 FIX (owner-reported, 268-row review, 2026-07-20): raw string equality here missed a
          // leading-zero GTIN variant of an already-counted identity (848983027580 vs 00848983027580),
          // minting a duplicate product row instead of aggregating the quantity onto the existing one.
          // Compare via the SAME canonical-GTIN key universal import already uses (aggKeyFor, below in
          // this file) - canonicalGtin strips leading zeros then re-pads to 14 digits for any
          // GTIN-shaped code; a non-GTIN-shaped code (e.g. a part number) falls through unchanged, so a
          // part number's leading zeros still carry meaning and are never canonicalized away.
          const canon = (c: string): string => canonicalGtin(c) ?? c;
          const identityCodesCanonical = identityCodes.map(canon);
          const countedProductIds = new Set(state.finalCounts.map((c) => c.productId));
          for (const p of state.products) {
            if (!countedProductIds.has(p.id) || p.status === "archived") continue;
            // The provisional placeholder for THIS code is the row being resolved, not a competing owner -
            // exclude it so it never causes a false "multiple products own this identity" conflict.
            if (p.id === provOrphanId) continue;
            const pCodes = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).filter(Boolean);
            if (pCodes.some((c) => identityCodesCanonical.includes(canon(c)))) matchedIds.add(p.id);
            // BARCODE-IN-NAME DEDUP (P2): a legacy product can carry its barcode ONLY inside the name
            // (e.g. "UPC 029142712886 - Discoverer A/T3"), so the identifier-field check above misses it
            // and re-scanning that barcode mints a duplicate. Reuse it when the scanned code appears as an
            // EXACT whole token in its name (never fuzzy name matching). >1 match -> conflict block below.
            else if (blobContainsCodeToken(p.name, identityCodes)) matchedIds.add(p.id);
          }
          if (provOrphanId) matchedIds.delete(provOrphanId); // never let the placeholder count as an owner

          // IDENTITY-MERGE (decode ladder Task 9): when the deterministic dedup above finds NO owner, still
          // check whether this decoded identity is the SAME countable product as one already in the shop, by
          // canonical GTIN (auto_link) or a fuzzy brand+name match (suggest_link). This links two DIFFERENT
          // scannable codes that resolve to the same product across encodings, so a second scan increments
          // the existing row instead of minting a duplicate. Only consider real (active, non-placeholder)
          // products; the scan's own provisional placeholder is excluded so it is never matched to itself.
          if (matchedIds.size === 0) {
            const mergeCandidates = state.products.filter(
              (p) => p.status !== "archived" && p.id !== provOrphanId && p.provisional !== true,
            );
            const merge = findIdentityMerge(mergeCandidates, {
              gtin: np.gtin ?? null,
              upc: np.upc ?? null,
              ean: np.ean ?? null,
              brand: np.brand ?? null,
              name: np.name ?? null,
              specsShort: np.specsShort ?? null,
              specsFull: np.specsFull ?? null,
            });
            if (merge.kind === "auto_link") {
              // Same product across encodings -> reuse its row (the size===1 path below adds the alias +
              // counts). Never a duplicate.
              matchedIds.add(merge.productId);
              emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code: review.cleanCode } });
            } else if (merge.kind === "suggest_link") {
              // Fuzzy match (brand+name, or a plus-generation / tire-size difference) -> NEVER auto-link.
              // Attach the candidate to the review as a one-tap "link to existing product?" suggestion and
              // keep it OPEN. The scan already counted provisionally (scan N = count N); this only refuses to
              // guess the merge. The review keeps its existing provisional placeholder + count untouched.
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, suggestedLinkProductId: merge.productId, decodeStatus: "suggested" as const }
                    : r,
                ),
              }));
              emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "identity_merge_suggest_link", metadata: { code: review.cleanCode, productId: merge.productId } });
              return; // stop: do NOT mint a product; wait for the human to confirm the link
            }
          }

          if (matchedIds.size > 1) {
            // MORE THAN ONE existing product owns this identity -> never guess; keep it in Needs Review
            // (same rule as the resolver conflict guard). The human picks the right one via link_existing.
            //
            // OWNER RULE "scan N = count N" (a count already taken is NEVER silently lost): do NOT delete
            // this code's provisional placeholder or its finalCounts row here. The scan may already have
            // counted N times; dropping the placeholder would vanish all N with no transfer. Instead KEEP
            // the placeholder product row + its full retained quantity, keep the review OPEN, and only flip
            // the feed row's badge to "conflict" so the human sees action is needed. When the human resolves
            // (link_existing, or a create_new pick), resolveUnknown recomputes provOrphanId, finds this
            // surviving placeholder, and the orphan merge/transfer machinery below moves the FULL retained
            // quantity onto the chosen product (one product row, one count row, no double-count, no orphan).
            if (provOrphanId) {
              const oid = provOrphanId;
              set((st) => ({
                scanFeed: st.scanFeed.map((e) =>
                  e.matchedProductId === oid
                    ? { ...e, status: "conflict" as const, decodeStatus: "conflict" as ScanEvent["decodeStatus"] }
                    : e,
                ),
              }));
            }
            set({ lastAliasConflicts: [...matchedIds].map((existingProductId) => ({ reviewId, code: review.cleanCode, existingProductId })) });
            emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_conflict_blocked", metadata: { code: review.cleanCode, reason: "dedup_multiple_match", productIds: [...matchedIds].join(",") } });
            return;
          }

          if (matchedIds.size === 1) {
            // EXACTLY ONE existing product owns this identity -> reuse it (count the existing row) and fall
            // through to the alias-add + applyToCount path. Do NOT create a duplicate.
            productId = [...matchedIds][0];
            // TASK 3: this code's provisional placeholder is being merged into a DIFFERENT existing product.
            // Move its count onto that product and remove the placeholder; do NOT re-count (approvingProvisional).
            if (provOrphanId && provOrphanId !== productId) {
              removeOrphanId = provOrphanId;
              orphanTransferTargetId = productId;
              approvingProvisional = true;
            }
            // PHASE 2: if the reused row is a PROVISIONAL count, this resolution CONFIRMS it -> upgrade it
            // in place to a verified, non-provisional product (the approved alias is added below, so future
            // scans resolve it as a normal Known) and do NOT re-count it (it was already counted).
            // POISON GUARD (dedup path): apply the same weak-guess check here. If the user is approving
            // the review's evidence-less AI suggestion, the provisional must NOT be upgraded to verified
            // (same rule as the create-new branch). Only a human typing their OWN product or a suggestion
            // with real evidence upgrades the provisional.
            if (products.find((p) => p.id === productId)?.provisional === true) {
              approvingProvisional = true;
              // When a person confirmed it, they are deliberately confirming the provisional - skip the guard.
              const isWeakGuessReuse = isWeakGuess(review, np) && !humanConfirmed;
              if (isWeakGuessReuse) {
                weakGuessProduct = true;
                // Leave the provisional as-is (not upgraded to verified).
              } else {
                // Upgrade the provisional to a verified product. When the human typed a DIFFERENT name
                // (not the AI suggestion), apply the human's product details to the upgraded row so the
                // product identity reflects what the human actually intended, not the AI's provisional guess.
                const normName = (s: string) => cleanProductName(s ?? "").trim().toLowerCase();
                products = products.map((p) => {
                  if (p.id !== productId) return p;
                  const updates: Partial<Product> = { verified: true, provisional: false, updatedAt: now(), updatedBy: "human" };
                  // FALKEN FIX (owner-reported live bug, 2026-07-20): a name-only decode payload (no
                  // separate brand/category/specsShort/specsFull fields) used to leave every structured
                  // column blank forever, even though the size/brand/model are cleanly parseable from
                  // the name itself (e.g. "Falken Azenis RT660 P 245 /40 R18 97W XL BSW"). Route every
                  // apply through the single shared enrichProductIdentity helper: the payload's own
                  // structured field always wins; a still-empty field falls back to a deterministic
                  // parse of the (cleaned) name - never a guess. `enriched.name` is the CLEANED name
                  // (tireListingNormalizer's cleanListingTitle) - use it wherever np.name would have
                  // been written raw before.
                  // CLASS FIX (2026-08-04, cocacola-bug-report.md): `p.brand` at this point may be
                  // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
                  // synchronously before any decode ever ran (this is the second EXACT unguarded sibling
                  // of the 2026-07-21 "PREFIX-FLOOR BRAND LOCK FIX" - the dedup-reuse path). Compute it
                  // once and pass it through so enrichProductIdentity treats that guess as empty rather
                  // than a trustworthy prior brand.
                  const pBrandIsFloorGuess = brandIsOnlyFloorGuess(p.name, p.primaryBarcode || review.cleanCode);
                  const enriched = enrichProductIdentity({
                    payload: { name: np.name ?? p.name, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
                    existing: { name: p.name, brand: p.brand, category: p.category, specsShort: p.specsShort, specsFull: p.specsFull },
                    existingBrandIsFloorGuess: pBrandIsFloorGuess,
                  });
                  // B1 FIX (owner-reported, 268-row review, 2026-07-20): this re-match/reuse path used to
                  // drop specsShort/specsFull/primarySku/category entirely - a decode payload's structured
                  // fields never landed on an existing (already-counted) provisional row, so Brand/Model/
                  // Category/Specs/Size stayed blank forever once a row was first counted, even when a
                  // LATER, richer decode re-matched the same physical item. Fill-if-empty ONLY: any field
                  // this row already carries a non-empty value for (human-entered or from an earlier
                  // decode) is never clobbered by a weaker/different later suggestion.
                  if (np.name && normName(np.name) !== normName(p.name)) {
                    updates.name = enriched.name;
                    if (np.brand !== undefined) updates.brand = np.brand;
                    if (np.category !== undefined) updates.category = np.category;
                  }
                  if (!p.category) updates.category = enriched.category;
                  if (!p.specsShort) updates.specsShort = enriched.specsShort;
                  if (!p.specsFull) updates.specsFull = enriched.specsFull;
                  if (!p.primarySku && np.primarySku) updates.primarySku = np.primarySku;
                  // CLASS FIX: a floor-guess-only brand must yield to enrichProductIdentity's resolution
                  // (payload brand, then a name-parsed brand) even though p.brand is technically
                  // non-empty - it was never a trustworthy prior identity in the first place.
                  if (!p.brand || pBrandIsFloorGuess) updates.brand = enriched.brand;
                  if (!p.structuredModel && enriched.structuredModel) updates.structuredModel = enriched.structuredModel;
                  // Task 4: (re)structure only when the name/brand actually changed above; the guard
                  // inside structuredFieldsFor never overwrites a row already stamped "human". Uses
                  // the safe wrapper: a structurer throw must never break this scan flow (Task 4 review fix).
                  Object.assign(updates, safeStructuredFieldsFor(updates.name ?? p.name, updates.brand ?? p.brand, p.structuredBy));
                  // safeStructuredFieldsFor may return its own structuredModel guess (name-only
                  // structurer); prefer OUR still-empty fill above when the structurer found nothing.
                  if (!updates.structuredModel && enriched.structuredModel && !p.structuredModel) {
                    updates.structuredModel = enriched.structuredModel;
                  }
                  return { ...p, ...updates };
                });
              }
            }
            emitAudit({ entityType: "Product", entityId: productId, action: "product_dedup_reused", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
          } else if (provOrphanId) {
            // TASK 3: no OTHER product owns this identity, but this code already has a provisional placeholder
            // (counted synchronously at scan time). Upgrade THAT row in place into the created product: reuse
            // its id + its existing count (never re-count), and run the full create machinery below (multi-code
            // aliases, product_created audit, catalog write) exactly like a fresh mint. The Phase-2 poison
            // guard still applies (an evidence-less AI suggestion stays unverified + provisional).
            productId = provOrphanId;
            approvingProvisional = true;
            weakGuessProduct = isWeakGuess(review, np) && !humanConfirmed;
            const orphan = products.find((p) => p.id === provOrphanId)!;
            // FALKEN FIX (owner-reported live bug, 2026-07-20): this upgrade path used to write
            // np.brand/np.category/np.specsShort/np.specsFull verbatim with no fallback, so a
            // name-only decode payload (all structured fields empty) left every structured column
            // permanently blank even though the size/brand/model are cleanly parseable from the
            // name. Route through the shared helper: payload field wins when present; a still-empty
            // field falls back to a deterministic parse of the (cleaned) name - never a guess.
            //
            // CLASS FIX (2026-08-04, cocacola-bug-report.md): `orphan.brand` at this point may be
            // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
            // synchronously before any decode ever ran (this is the EXACT unguarded sibling of the
            // 2026-07-21 "PREFIX-FLOOR BRAND LOCK FIX" above - the fresh-single-scan path a brand-new
            // 049000-prefixed tire scan actually takes). existingBrandIsFloorGuess tells
            // enrichProductIdentity to treat that guess as empty rather than a trustworthy prior brand.
            const orphanEnriched = enrichProductIdentity({
              payload: { name: np.name, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
              existing: { name: orphan.name, brand: orphan.brand, category: orphan.category, specsShort: orphan.specsShort, specsFull: orphan.specsFull },
              existingBrandIsFloorGuess: brandIsOnlyFloorGuess(orphan.name, review.cleanCode),
            });
            const upgraded: Product = {
              ...orphan,
              name: orphanEnriched.name || orphan.name,
              brand: orphanEnriched.brand,
              category: orphanEnriched.category,
              specsShort: orphanEnriched.specsShort,
              specsFull: orphanEnriched.specsFull,
              primarySku: np.primarySku ?? orphan.primarySku,
              primaryBarcode: orphan.primaryBarcode || review.cleanCode,
              ...(function () {
                const gated = gateIdentityBarcodeFields(np);
                return {
                  gtin: np.gtin !== undefined ? gated.gtin : orphan.gtin,
                  upc: np.upc !== undefined ? gated.upc : orphan.upc,
                  ean: np.ean !== undefined ? gated.ean : orphan.ean,
                };
              })(),
              vendorCodes: orphan.vendorCodes ?? [],
              aliases: [review.cleanCode],
              imageUrl: np.imageUrl ?? orphan.imageUrl,
              productUrl: np.productUrl ?? orphan.productUrl,
              location: np.location ?? orphan.location,
              source: np.source ?? orphan.source,
              confidence: 1,
              verified: !weakGuessProduct,
              provisional: weakGuessProduct ? true : false,
              updatedAt: now(),
              updatedBy: humanConfirmed ? "human" : orphan.updatedBy,
              // Task 4: structure the upgraded identity (deterministic only, never LLM on the hot
              // path). Guarded against clobbering a prior "human" stamp.
              ...safeStructuredFieldsFor(np.name ?? orphan.name, orphanEnriched.brand, orphan.structuredBy),
            };
            if (!upgraded.structuredModel && orphanEnriched.structuredModel) {
              upgraded.structuredModel = orphanEnriched.structuredModel;
            }
            products = products.map((p) => (p.id === provOrphanId ? upgraded : p));
            createdProduct = upgraded;
          } else {
            productId = `prod-${idFactory()}`;
            // POISON GUARD: is this create_new accepting the review's AI suggestion (the new product's
            // name equals the suggested name)? If so, and the suggestion has NO real evidence the app
            // could back - no brand, no gtin/upc/ean, no source URL - it must not become trusted identity.
            // A human typing their OWN product name (not the AI's guess) is unaffected.
            // Compare NORMALIZED names (cleanProductName + lowercase) so a case difference or an AI hedge
            // phrase (e.g. "(likely wholesale)") that cleanProductName strips cannot slip the guard.
            // NOTE: unlike the two provisional-reuse sites above, this fresh-mint site does NOT gate on
            // origin !== "human" (behavior preserved from before the extraction).
            weakGuessProduct = isWeakGuess(review, np);
            const mintedName = np.name ?? review.cleanCode;
            // FALKEN FIX (owner-reported live bug, 2026-07-20): a fresh mint used to take np.brand/
            // np.category/np.specsShort/np.specsFull verbatim (defaulting to "" when absent) with no
            // fallback to parse them from the name - exactly the shape of the owner's bug row (a
            // single fresh scan whose decode payload carried only a name, no separate structured
            // fields). Route through the shared helper so a still-empty field is deterministically
            // parsed from the (cleaned) name instead of staying blank forever.
            const mintEnriched = enrichProductIdentity({
              payload: { name: mintedName, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
            });
            const mintedBrand = mintEnriched.brand;
            const newProduct: Product = {
              id: productId,
              businessId: state.businessId,
              name: mintedName,
              brand: mintedBrand,
              category: mintEnriched.category,
              specsShort: mintEnriched.specsShort,
              specsFull: mintEnriched.specsFull,
              primarySku: np.primarySku ?? "",
              // Identity = the scanned code, so the product's primaryBarcode and its first approved alias
              // agree (prevents the alias-miss -> identifier-conflict -> re-decode -> duplicate cascade).
              primaryBarcode: review.cleanCode,
              ...gateIdentityBarcodeFields(np),
              vendorCodes: [],
              aliases: [review.cleanCode],
              imageUrl: np.imageUrl ?? "",
              productUrl: np.productUrl ?? "",
              location: np.location ?? "",
              notes: "",
              status: "active",
              source: np.source ?? "human_review",
              confidence: 1,
              verified: !weakGuessProduct, // trusted ONLY if not accepting an evidence-less AI suggestion (Phase-2 poison guard)
              createdAt: now(),
              updatedAt: now(),
              createdBy: "human",
              updatedBy: "human",
              // Task 4: fresh mint - always deterministic-structure (no prior stamp to protect).
              ...safeStructuredFieldsFor(mintedName, mintedBrand),
            };
            if (!newProduct.structuredModel && mintEnriched.structuredModel) {
              newProduct.structuredModel = mintEnriched.structuredModel;
            }
            products = [...products, newProduct];
            createdProduct = newProduct;
          }
        }

        if (!productId) return;

        // Human-mistake guard: before linking a code to an EXISTING product, check it doesn't look like
        // a different product entirely (e.g. a Falken tire part number being linked to Camel cigarettes).
        // High-risk links are BLOCKED until the human explicitly overrides (confirmedMismatch: true).
        if (action === "link_existing") {
          const target = state.products.find((p) => p.id === productId);
          const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
          const verdict = evaluateMismatch({
            scannedCode: review.cleanCode,
            suggested: hasSuggestion
              ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
              : undefined,
            target: { name: target?.name, brand: target?.brand, category: target?.category },
          });
          if (verdict.risk === "high_risk" && !payload.confirmedMismatch) {
            set({ lastMismatchWarning: { reviewId, productId, verdict } });
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_warning_shown", metadata: { code: review.cleanCode, productId, reason: verdict.reason, suggestedName: verdict.suggestedName ?? "", targetProductName: target?.name ?? "" } });
            return; // do NOT link until the owner explicitly confirms the override
          }
          if (verdict.risk === "high_risk" && payload.confirmedMismatch) {
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_override", metadata: { code: review.cleanCode, productId, targetProductName: target?.name ?? "", suggestedName: verdict.suggestedName ?? "", suggestedDomain: verdict.suggestedDomain ?? "", reason: verdict.reason } });
          }
          // TASK 3: linking this code to an EXISTING product orphans its provisional placeholder. Merge it -
          // move its count onto the linked product and remove the placeholder (no duplicate row, no re-count).
          if (provOrphanId && provOrphanId !== productId) {
            removeOrphanId = provOrphanId;
            orphanTransferTargetId = productId;
            approvingProvisional = true;
          }
        }

        // Permanently learn the alias (deterministic from now on, even before sync completes).
        const aliasId = `alias-${idFactory()}`;
        const aliasKeyOp = buildIdempotencyKey(
          state.businessId,
          state.sessionId,
          aliasId,
          "RESOLVE_ALIAS",
        );
        const newAlias: Alias = {
          id: aliasId,
          businessId: state.businessId,
          productId,
          rawCodeExample: review.rawCode,
          cleanCode: review.cleanCode,
          // normalizedCandidates is stripped from a customer's persisted (rehydrated) review for privacy;
          // fall back to the cleanCode, which is what this alias is keyed on anyway.
          normalizedCode:
            review.normalizedCandidates?.[review.normalizedCandidates.length - 1] ?? review.cleanCode,
          aliasType: codeTypeToAliasType(detectCodeType(review.cleanCode)),
          source: "human_review",
          confidence: 1,
          approved: !weakGuessProduct, // NOT approved when minting from an evidence-less AI suggestion (Phase-2 poison guard)
          createdAt: now(),
          updatedAt: now(),
          createdBy: "human",
          lastSeenAt: now(),
          syncStatus: "pending",
          idempotencyKey: aliasKeyOp,
        };

        // Avoid duplicate aliases for the same clean code + product.
        const aliasExists = state.aliases.some(
          (a) => a.cleanCode === newAlias.cleanCode && a.productId === productId,
        );
        const aliases = aliasExists ? state.aliases : [...state.aliases, newAlias];

        const needsReviewQueue = state.needsReviewQueue.map((r) =>
          r.id === reviewId
            ? {
                ...r,
                status: "resolved" as const,
                resolvedAt: now(),
                resolvedBy: "human",
                resolutionAction: (action === "create_new" ? "create_new" : "link_existing") as
                  | "create_new"
                  | "link_existing",
              }
            : r,
        );

        // UI-1 FIX (2026-08-13, docs/superpowers/reports/2026-08-13-loop1-ui.md): quantityAfterScan on
        // these rows is a snapshot of the PROVISIONAL PLACEHOLDER's own running count at scan time - only
        // still correct when this resolution reuses that same placeholder id (create_new / dedup-reuse of
        // the SAME product). When removeOrphanId is set, the placeholder is being MERGED into a DIFFERENT,
        // already-counted product (transferOrphanCount below adds the placeholder's quantity onto that
        // product's own pre-merge quantity) - carrying the stale snapshot forward unchanged would make the
        // feed display a number that no longer matches the finalCounts ledger. mergeBaselineQty is that
        // target product's own pre-merge quantity (session-scoped, mirroring transferOrphanCount's own
        // scoping); adding it to each row's already-recorded running value reproduces exactly what
        // finalCounts becomes after the merge, so the feed never shows a stale or wrong quantity.
        const mergeBaselineQty = removeOrphanId
          ? (get().finalCounts.find((c) => c.productId === productId && c.sessionId === state.sessionId)?.quantity ?? 0)
          : 0;

        // Mark any earlier "unknown" feed rows for this code as resolved, so the feed reflects the
        // learned mapping instead of staying red.
        const resolvedScanEvents: ScanEvent[] = [];
        const scanFeed = get().scanFeed.map((e) => {
          if (
            e.cleanCode === review.cleanCode &&
            (e.status === "unknown" || e.status === "needs_review" || e.status === "conflict" || e.matchedProductId !== productId)
          ) {
            const resolved = {
              ...e,
              status: "resolved" as const,
              resolverStatus: "resolved" as const,
              matchedProductId: productId,
              quantityAfterScan: mergeBaselineQty + (e.quantityAfterScan ?? 0),
            };
            resolvedScanEvents.push(resolved);
            return resolved;
          }
          return e;
        });

        // TASK 3: drop the merged provisional placeholder from the product list before committing so the
        // resolved identity never coexists with its own duplicate row.
        if (removeOrphanId) {
          products = products.filter((p) => p.id !== removeOrphanId);
        }

        set({ products, aliases, needsReviewQueue, scanFeed, lastMismatchWarning: null, lastAliasConflicts: null, lastCategoryWarning: null });

        // TASK 3: transfer the merged placeholder's count onto the resolved product and re-point its feed
        // row, then remove its count row. This preserves the scanned quantity (scan N = count N) while
        // keeping exactly one product row + one count row per identity (no double count, no orphan).
        if (removeOrphanId) {
          const oid = removeOrphanId;
          const targetId = orphanTransferTargetId;
          // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
          // local-only transfer leaves the backend holding the orphan's count forever.
          const transferOps = targetId
            ? buildOrphanTransferSyncOps({
                finalCountsBeforeTransfer: get().finalCounts,
                scanFeedBeforeTransfer: get().scanFeed,
                oid,
                targetId,
                businessId: state.businessId,
                idFactory,
                now,
              })
            : [];
          set((st) => ({
            finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
            scanFeed: st.scanFeed.map((e) =>
              e.matchedProductId === oid ? { ...e, matchedProductId: targetId ?? null } : e,
            ),
          }));
          if (transferOps.length > 0) enqueueAndSync(transferOps);
        }

        // Queue idempotent SAVE_PRODUCT (new products only) BEFORE the alias, so a reloaded alias always
        // references a persisted product. Then queue idempotent RESOLVE_ALIAS.
        const queued: PendingSyncItem[] = [];
        if (createdProduct) {
          // Task 1b fix (same recipe as correctProduct, commit 024c849): in the orphan-merge branch
          // above, createdProduct.id === provOrphanId - the SAME id ensureProvisionalCount already
          // enqueued a SAVE_PRODUCT for (scanStore.ts ~3748). A bare
          // `businessId:sessionId:<id>:SAVE_PRODUCT` key would be identical to that earlier write's key,
          // so this resolved-identity write would be swallowed as "alreadyApplied" and never reach the
          // backend - real data loss (the resolved name never syncs, only the placeholder does). Fold a
          // content fingerprint of the resolved product into the key, minted once here; every retry of
          // this queue item (drain loop / manual retrySync) replays the same PendingSyncItem object, so
          // retry dedupe on THIS write is unaffected.
          const createdFingerprint = `${JSON.stringify(createdProduct)}@${createdProduct.updatedAt}`;
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Product",
              entityId: createdProduct.id,
              operation: "SAVE_PRODUCT",
              payload: createdProduct,
              idempotencyKey: buildIdempotencyKey(
                state.businessId,
                state.sessionId,
                `${createdProduct.id}:${createdFingerprint}`,
                "SAVE_PRODUCT",
              ),
              scanEventId: null,
            }),
          );
        }
        if (!aliasExists) {
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Alias",
              entityId: aliasId,
              operation: "RESOLVE_ALIAS",
              payload: newAlias,
              idempotencyKey: aliasKeyOp,
              scanEventId: null,
            }),
          );
        }
        for (const event of resolvedScanEvents) {
          const resolutionFingerprint = `${event.id}:${event.matchedProductId}:${event.status}:${event.resolverStatus}`;
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: event.sessionId,
              entityType: "ScanEvent",
              entityId: event.id,
              operation: "SAVE_SCAN_EVENT",
              payload: event,
              idempotencyKey: buildIdempotencyKey(
                state.businessId,
                event.sessionId,
                `${resolutionFingerprint}:human-resolution`,
                "SAVE_SCAN_EVENT",
              ),
              scanEventId: event.id,
            }),
          );
        }
        if (queued.length > 0) {
          set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }

        // Multi-code: a newly created product registers an approved alias for EVERY other code it carries
        // (part number / SKU / GTIN / UPC / EAN), so scanning the tire's barcode OR its part-number QR both
        // resolve to the same product. Deduped against the scanned alias and any pre-existing aliases.
        if (createdProduct) {
          const extra = buildProductCodeAliases({
            product: createdProduct,
            alreadyAliasedCleanCodes: [newAlias.cleanCode],
            businessId: state.businessId,
            sessionId: state.sessionId,
            idFactory,
            now,
          });
          const existingForProduct = new Set(
            get().aliases.filter((a) => a.productId === createdProduct!.id).map((a) => a.cleanCode),
          );
          const freshAliases = extra.aliases.filter((a) => !existingForProduct.has(a.cleanCode));
          if (freshAliases.length > 0) {
            const freshIds = new Set(freshAliases.map((a) => a.id));
            set((s) => ({
              aliases: [...s.aliases, ...freshAliases],
              pendingSyncQueue: [...s.pendingSyncQueue, ...extra.queued.filter((q) => freshIds.has(q.entityId))],
            }));
            for (const a of freshAliases) {
              emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId: createdProduct.id, origin: "multi_code" } });
            }
          }
        }

        // W2: approve the human-SELECTED discovered identifiers as APPROVED aliases onto the resolved
        // product (new or existing). Only codes the human explicitly selected reach here; deduped per
        // product; a code already owned by a DIFFERENT product is a conflict (surfaced, never overwritten).
        const selectedAliasCodes = (payload.selectedAliasCodes ?? []).filter(Boolean);
        if (selectedAliasCodes.length > 0) {
          const targetProduct = get().products.find((p) => p.id === productId);
          if (targetProduct) {
            const built = buildAliasesForCodes({
              product: targetProduct,
              codes: selectedAliasCodes,
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
            });
            if (built.aliases.length > 0) {
              const builtIds = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => builtIds.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "human_discovered" } });
              }
            }
            if (built.conflicts.length > 0) {
              set({ lastAliasConflicts: built.conflicts.map((c) => ({ reviewId, code: c.code, existingProductId: c.otherProductId })) });
              for (const c of built.conflicts) {
                emitAudit({ entityType: "Alias", entityId: c.code, action: "alias_conflict_blocked", metadata: { code: c.code, attemptedProductId: productId, existingProductId: c.otherProductId } });
              }
            }
          }
        }

        // Persist any decode-SUGGESTED identifiers the human did NOT approve as UNAPPROVED "discovered"
        // aliases on the resolved product. They never match or count until a human approves them (the
        // resolver ignores approved !== true); they are offered for one-click approval from the count
        // table. Grounded only - we persist codes the decode actually returned, never an invented one.
        const discoveryTarget = get().products.find((p) => p.id === productId);
        if (discoveryTarget) {
          const selectedSet = new Set(selectedAliasCodes.map((c) => normalizeCode(c).clean));
          const grounded = collectGroundedIdentifiers({ extras: review.suggestedAliases ?? [] });
          const discoverable = discoverableIdentifiers(grounded, get().aliases, productId, state.businessId).filter(
            (g) => g.cleanCode !== newAlias.cleanCode && !selectedSet.has(g.cleanCode),
          );
          if (discoverable.length > 0) {
            const built = buildAliasesForCodes({
              product: discoveryTarget,
              codes: discoverable.map((g) => g.rawCode),
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
              approved: false, // DISCOVERED: never trusted until a human approves it
              source: discoveryTarget.source,
              createdBy: "discovered",
            });
            if (built.aliases.length > 0) {
              const ids = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => ids.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_discovered", metadata: { code: a.cleanCode, productId, origin: "decode_discovered" } });
              }
            }
          }
        }

        // Audit the human/system resolution (product creation + alias approval). Fire-and-forget.
        if (createdProduct) {
          emitAudit({ entityType: "Product", entityId: createdProduct.id, action: "product_created", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
        }
        if (!aliasExists) {
          emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_approved", metadata: { code: review.cleanCode, productId, origin: payload.origin ?? "human" } });
        }

        // Feed the shared knowledge base (privacy-safe; only barcode/product/evidence is written).
        // Origin controls trust: human -> verified catalog write; ai -> pending only (NEVER overwrites
        // a verified entry, rule #1/#2); catalog -> already observed on the read path, no write here.
        const origin = payload.origin ?? "human";
        const resolvedProduct = products.find((p) => p.id === productId);
        if (resolvedProduct && isCatalogWritable(resolvedProduct.name)) {
          const candidate = {
            barcode: review.cleanCode,
            normalizedBarcode: review.cleanCode,
            barcodeType: detectCodeType(review.cleanCode),
            name: resolvedProduct.name,
            brand: resolvedProduct.brand,
            category: resolvedProduct.category,
            imageUrl: resolvedProduct.imageUrl,
            sourceUrls: review.sourceUrls ?? [],
            confidence: review.confidence || 1,
          };
          if (origin === "human" && !weakGuessProduct) set({ catalog: upsertVerified(get().catalog, candidate, now(), "owner") });
          else if (origin === "ai") set({ catalog: applyAiCandidate(get().catalog, candidate, now()) });
          else if (origin === "auto_verify") {
            const av = payload.autoVerify;
            set({
              catalog: upsertVerified(
                get().catalog,
                {
                  ...candidate,
                  sourceUrls: av?.sourceUrls ?? candidate.sourceUrls,
                  autoVerified: true,
                  autoVerifyReason: av?.reason ?? "",
                  evidenceScore: av?.score ?? 0,
                  sourceTier: av?.sourceTier ?? "",
                  evidenceSummary: av?.evidenceSummary ?? "",
                },
                now(),
                av?.verifiedBy ?? "evidence_score",
              ),
            });
          }
          // origin "tenant_approval" (a tenant's own confirmation: tenant product + alias only), "auto_count"
          // (learning off) and "catalog" -> no shared-catalog write here.
        }
        if (origin === "human" || origin === "tenant_approval") {
          get().recordFeedback(action === "create_new" ? "product_approved" : "alias_linked", {
            code: review.cleanCode,
            productId,
          });
        }

        // Optionally apply this code to the current session count immediately. Fall back to cleanCode:
        // a customer review rehydrated from disk has its rawCode stripped (privacy), but cleanCode is kept
        // and is what the approved alias is keyed on, so the re-scan still matches + counts.
        if (payload.applyToCount && !weakGuessProduct && !approvingProvisional) {
          // Phase 4: an import-origin review carries importQuantity - the full quantity from the source
          // row (already aggregated across duplicate codes by applyUniversalImport) must land in one
          // confirmation, not just 1 unit. A plain scan-born review has no importQuantity, so this stays
          // the existing single-unit processScan call for every non-import path.
          const applications = review.importQuantity ?? 1;
          if (!Number.isSafeInteger(applications) || applications < 0) return;
          for (let index = 0; index < applications; index += 1) {
            get().processScan(review.rawCode || review.cleanCode);
          }
        } else {
          get().syncPending();
        }
      },

      batchApprove: (reviewIds) => {
        const approved: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];
        // CHUNK_SIZE is cosmetic bookkeeping only: it slices reviewIds into readable groups for the code
        // below and gives per-row containment inside a bounded slice (a throw is still caught per-row by
        // the inner try/catch, chunk or no chunk). It does NOT commit or yield per chunk - there is no
        // intermediate `set()`/persist between chunks and no `await`/tick boundary, so the whole loop
        // (all chunks) runs in one synchronous pass and one synchronous state update per row, exactly as
        // if CHUNK_SIZE were reviewIds.length. It provides no state isolation between chunks and no
        // resumability if the tab closes mid-loop.
        const CHUNK_SIZE = 25;

        for (let i = 0; i < reviewIds.length; i += CHUNK_SIZE) {
          const chunk = reviewIds.slice(i, i + CHUNK_SIZE);
          for (const reviewId of chunk) {
            try {
              const review = get().needsReviewQueue.find((r) => r.id === reviewId);
              if (!review) {
                failed.push({ id: reviewId, reason: "Review not found" });
                continue;
              }
              // Idempotent: a review already resolved/ignored (this call or an earlier one) is silently
              // skipped, exactly like resolveUnknown's own open-status guard - a re-click or a retried
              // batch never double-counts and is not reported as a failure. Task 9b (owner-ratified
              // 2026-07-14): a PENDING inline suggestion (status "suggested") is approvable here too -
              // resolveUnknown accepts it exactly like "open", so the same core path runs unchanged.
              if (review.status !== "open" && review.status !== "suggested") continue;
              if (!review.hasSuggestion || !review.suggestedProductName) {
                failed.push({ id: reviewId, reason: "No suggestion to approve" });
                continue;
              }
              // Task 9b: capture the feed row(s) carrying this suggestion BEFORE resolveUnknown runs
              // (it may remap the row's matchedProductId), so the inline tag can be settled afterwards.
              const pendingRowIds = get()
                .scanFeed.filter(
                  (e) =>
                    e.suggestion?.status === "pending" &&
                    ((e.cleanCode && e.cleanCode === review.cleanCode) ||
                      (e.matchedProductId && e.matchedProductId === review.provisionalProductId)),
                )
                .map((e) => e.id);

              const discovered = buildDiscoveredIdentifiers(review);
              // TRUST RULE (Build 3 review Finding 1): do NOT pass origin: "human" here. That value disables
              // the weak-guess poison guard at the two provisional-reuse branches in resolveUnknown
              // (`isWeakGuess(review, np) && payload.origin !== "human"`), which exists to stop an
              // evidence-less AI suggestion from becoming a verified product/approved alias. The single-row
              // "Approve suggestion" button (NeedsReviewTable.tsx) passes NO origin - batch approval must call
              // resolveUnknown with the IDENTICAL payload shape so the poison guard applies exactly the same
              // way whether a suggestion is approved one at a time or in bulk.
              get().resolveUnknown(reviewId, "create_new", {
                applyToCount: true,
                newProduct: {
                  name: review.suggestedProductName,
                  brand: review.suggestedBrand,
                  category: review.suggestedCategory,
                  specsShort: review.suggestedSpecsShort,
                  primarySku: review.suggestedPrimarySku,
                  primaryBarcode: review.suggestedPrimaryBarcode || review.cleanCode,
                  gtin: review.suggestedGtin,
                  upc: review.suggestedUpc,
                  ean: review.suggestedEan,
                  imageUrl: review.suggestedImageUrl,
                  productUrl: review.suggestedProductUrl,
                },
                // Default = every discovered identifier approved, matching the single-approve row's
                // default UI state (all checked; the human unchecks to exclude) since batch approval
                // has no per-row checkbox interaction.
                selectedAliasCodes: discovered.map((d) => d.code),
              });

              // resolveUnknown silently no-ops on a guard it hit (e.g. a dedup conflict); only count this
              // row as approved if it actually left the awaiting states (open / suggested).
              const after = get().needsReviewQueue.find((r) => r.id === reviewId);
              if (after && after.status !== "open" && after.status !== "suggested") {
                approved.push(reviewId);
                // Task 9b: settle the inline tag on the row(s) this suggestion belonged to.
                if (pendingRowIds.length > 0) {
                  set((st) => ({
                    scanFeed: st.scanFeed.map((e) =>
                      pendingRowIds.includes(e.id) && e.suggestion?.status === "pending"
                        ? { ...e, suggestion: { ...e.suggestion, status: "approved" as const } }
                        : e,
                    ),
                  }));
                }
              } else {
                // Task 9b: an approve that could NOT auto-resolve (identity-merge suggest_link / dedup
                // conflict) surfaces honestly in the OPEN queue for the human instead of staying parked,
                // and the row's dead inline controls are dropped (the review-derived "(suggested)" tag
                // takes over, exactly the pre-9b display for an open suggestion-bearing review).
                if (after && after.status === "suggested") {
                  set((st) => ({
                    needsReviewQueue: st.needsReviewQueue.map((r) =>
                      r.id === reviewId && r.status === "suggested" ? { ...r, status: "open" as const } : r,
                    ),
                    scanFeed: st.scanFeed.map((e) =>
                      pendingRowIds.includes(e.id) ? { ...e, suggestion: undefined } : e,
                    ),
                  }));
                }
                failed.push({ id: reviewId, reason: "Could not resolve automatically - needs manual review" });
              }
            } catch (e) {
              failed.push({ id: reviewId, reason: e instanceof Error ? e.message : String(e) });
            }
          }
        }

        return { approved, failed };
      },

      // Task 9b (owner-ratified 2026-07-14): inline approve on the feed row. REUSE, never duplicate:
      // batchApprove -> resolveUnknown "create_new" IS the single-row human-approval path, so the
      // idempotency-keyed alias write, Phase-2 poison guard, dedup guard, and no-double-count
      // provisional upgrade are all inherited. The review is located by the row's cleanCode, with the
      // reload-resilient provisionalProductId fallback (a customer persist strips the event's code).
      approveSuggestion: (scanEventId) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId);
        if (!ev || ev.suggestion?.status !== "pending") return; // idempotent double-tap guard
        const review = st.needsReviewQueue.find(
          (r) =>
            r.status === "suggested" &&
            ((ev.cleanCode && r.cleanCode === ev.cleanCode) ||
              (ev.matchedProductId && r.provisionalProductId === ev.matchedProductId)),
        );
        if (!review) return;
        get().batchApprove([review.id]); // settles the row tag itself on success
      },

      // Best-guess identity (owner decision 2026-08-19): confirm a HUMAN-TYPED identity from the feed
      // row. REUSE, never duplicate: everything after locating the review is resolveUnknown
      // "create_new", the same core the Needs Review "Save product" button calls - so the tenant
      // approved alias, the no-double-count provisional upgrade, and the dedup guard are inherited.
      // Nothing platform-wide is written here (no corpus, no learned tier, no shared decode cache).
      confirmRowIdentity: (scanEventId, fields) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId);
        const name = (fields.name ?? "").trim();
        if (!ev || !name) return;
        // Double-tap / re-confirm guards: a settled suggestion, or a code that is ALREADY taught as an
        // approved alias, is a hard no-op - a second confirm must never mint a second product or count.
        if (ev.suggestion && ev.suggestion.status !== "pending") return;
        const code = ev.cleanCode || "";
        if (code && st.aliases.some((a) => a.cleanCode === code && a.approved)) return;
        const ownsRow = (r: UnknownCodeReview) =>
          (code !== "" && r.cleanCode === code) || (!!ev.matchedProductId && r.provisionalProductId === ev.matchedProductId);
        let review = st.needsReviewQueue.find((r) => (r.status === "open" || r.status === "suggested") && ownsRow(r));
        if (!review) {
          // AUTO-APPLIED row (>= 0.8 suggestion applied onto the provisional, review auto-closed, product
          // still unverified): the human's Approve/Edit confirms THAT review, not a blank reopened one, so
          // the decode's confidence/evidence fields stay on the record. Reactivate it in place as OPEN
          // (not "suggested"): if resolveUnknown then refuses to guess (dedup conflict, suggest_link) the
          // review is exactly where those branches expect it - visible in Needs Review - instead of
          // parked in "suggested" where no surface can finish it.
          const autoApplied = st.needsReviewQueue.find((r) => r.status === "resolved" && r.resolvedBy === "auto" && ownsRow(r));
          if (autoApplied) {
            // Stale click: another path already verified this product, so there is nothing left to
            // confirm - never fall through to the blank-reopen fallback on a settled review.
            if (st.products.find((p) => p.id === autoApplied.provisionalProductId)?.verified) return;
            set((s2) => ({
              needsReviewQueue: s2.needsReviewQueue.map((r) =>
                r.id === autoApplied.id
                  ? { ...r, status: "open" as const, resolvedAt: null, resolvedBy: null, resolutionAction: null }
                  : r,
              ),
            }));
            review = get().needsReviewQueue.find((r) => r.id === autoApplied.id);
          }
        }
        if (!review) {
          // No awaiting review (e.g. an old row whose review was already settled): open one through the
          // existing path so the resolution below runs on a real review record, never on a synthetic one.
          if (!code) return;
          const createdId = get().reopenNeedsReview(code, "Identity typed by the operator");
          // NO-DOUBLE-COUNT (F6): reopenNeedsReview mints a review with NO provisionalProductId, and
          // resolveUnknown's legacy fallbacks for finding the already-counted provisional (identifier
          // fields, reconstructed placeholder name) are exactly what a customer persist strips and what
          // the prefix-floor rename overwrites. Without the row's OWN provisional the resolution mints a
          // fresh product and re-counts the scan - one physical scan, two units. Stamp the row's
          // provisional onto the review so the existing approve-the-provisional path is taken instead.
          if (createdId && ev.matchedProductId) {
            set((s2) => ({
              needsReviewQueue: s2.needsReviewQueue.map((r) =>
                r.id === createdId && !r.provisionalProductId ? { ...r, provisionalProductId: ev.matchedProductId } : r,
              ),
            }));
          }
          review = createdId ? get().needsReviewQueue.find((r) => r.id === createdId) : undefined;
          if (!review) return;
        }
        const reviewId = review.id;
        // origin "tenant_approval" (and deliberately not in batchApprove): a person typed or tapped
        // Approve on this identity, so the weak-guess poison guard - which exists to stop an
        // evidence-less AI suggestion becoming a verified product by itself - must not fire on it; but
        // the confirmation is the TENANT's knowledge only (verified product + approved alias), never a
        // device-shared verified-catalog entry that would auto-resolve the code for another tenant.
        get().resolveUnknown(reviewId, "create_new", {
          applyToCount: true,
          origin: "tenant_approval",
          newProduct: { name, brand: fields.brand ?? "", category: fields.category ?? "", primaryBarcode: code },
        });
        // Settle the inline tag on every row carrying this code's pending suggestion (same bookkeeping
        // batchApprove does), and only when the review really left the awaiting states.
        const settled = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (settled && settled.status !== "open" && settled.status !== "suggested") {
          set((s2) => ({
            scanFeed: s2.scanFeed.map((e) =>
              e.suggestion?.status === "pending" && (e.id === scanEventId || (code !== "" && e.cleanCode === code))
                ? { ...e, suggestion: { ...e.suggestion, status: "approved" as const } }
                : e,
            ),
          }));
        }
      },

      // Task 9b: inline decline ("Not this product"). Order is owner-ratified: rename the counted row
      // to the prefix floor FIRST (a declined identity never stays on the count; the floor/placeholder
      // is a naming aid, NEVER a verified identity), and ONLY THEN create/reopen the OPEN Needs Review
      // item - decline is now the only suggestion path that creates one. reopenNeedsReview is the
      // existing core: it opens (or creates) the review with the decline reason and clears the
      // (declined) suggestion fields so the Suggested batch pile can never re-offer it.
      declineSuggestion: (scanEventId) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId);
        if (!ev || ev.suggestion?.status !== "pending") return; // idempotent double-tap guard
        const review = st.needsReviewQueue.find(
          (r) =>
            (r.status === "suggested" || r.status === "open") &&
            ((ev.cleanCode && r.cleanCode === ev.cleanCode) ||
              (ev.matchedProductId && r.provisionalProductId === ev.matchedProductId)),
        );
        const code = ev.cleanCode || review?.cleanCode || "";
        const floor = code ? prefixFloorName(code, detectCodeType(code)) : null;
        const floorName = code ? provisionalPlaceholderName(code) : "Unidentified item";
        const declineReason = "Suggestion declined by operator - needs a correct name";
        const prodId = ev.matchedProductId ?? review?.provisionalProductId ?? null;
        set((s2) => ({
          products: prodId
            ? s2.products.map((p) =>
                p.id === prodId && p.provisional === true && p.verified !== true
                  ? {
                      ...p,
                      name: floorName,
                      brand: floor?.brand ?? "",
                      category: "",
                      specsShort: "",
                      specsFull: "",
                      imageUrl: "",
                      productUrl: "",
                      confidence: 0,
                      updatedAt: now(),
                      updatedBy: "human",
                    }
                  : p,
              )
            : s2.products,
          // The repeat-scan attach puts the SAME pending suggestion on every row of this code, so a
          // decline settles them ALL (the same shape confirmRowIdentity uses). Settling only the clicked
          // row would leave live Approve controls on an identity the operator just rejected.
          scanFeed: s2.scanFeed.map((e) =>
            e.suggestion?.status === "pending" && (e.id === scanEventId || (code !== "" && e.cleanCode === code))
              ? { ...e, suggestion: { ...e.suggestion, status: "declined" as const }, reason: declineReason }
              : e,
          ),
        }));
        if (code) get().reopenNeedsReview(code, declineReason);
        get().recordFeedback("product_rejected", { code });
        emitAudit({
          entityType: "UnknownCodeReview",
          entityId: review?.id ?? code,
          action: "alias_rejected",
          metadata: { code, kind: "inline_suggestion_declined" },
        });
        // F5 bundle-surgery: the declined row was just renamed to the bare/local-floor placeholder above
        // - if the client-safe lookup found no brand, check for a DERIVED-tier hit asynchronously.
        if (code && !floor && prodId) get().enrichPrefixFloorLabel(code, prodId);
      },

      evaluateLinkMismatch: (reviewId, productId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review) return null;
        const target = state.products.find((p) => p.id === productId);
        const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
        return evaluateMismatch({
          scannedCode: review.cleanCode,
          suggested: hasSuggestion
            ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
            : undefined,
          target: { name: target?.name, brand: target?.brand, category: target?.category },
        });
      },

      clearMismatchWarning: () => set({ lastMismatchWarning: null }),

      clearCategoryWarning: () => set({ lastCategoryWarning: null }),

      approveDiscoveredIdentifiers: (productId, cleanCodes) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        const { businessId, sessionId } = state;
        const codes = [...new Set(cleanCodes.map((c) => normalizeCode(c).clean).filter(Boolean))];
        if (codes.length === 0) return;
        const aliases = state.aliases;
        const flipIds = new Set<string>();
        const toCreate: string[] = [];
        const conflicts: { code: string; otherProductId: string }[] = [];
        for (const code of codes) {
          const approvedElsewhere = aliases.find(
            (a) => a.businessId === businessId && a.cleanCode === code && a.approved && a.productId !== productId,
          );
          if (approvedElsewhere) {
            conflicts.push({ code, otherProductId: approvedElsewhere.productId }); // never hijack another product
            continue;
          }
          const mine = aliases.find((a) => a.businessId === businessId && a.cleanCode === code && a.productId === productId);
          if (mine) {
            if (!mine.approved) flipIds.add(mine.id); // flip the discovered alias -> approved
            // already approved -> idempotent no-op
          } else {
            toCreate.push(code); // grounded code with no alias yet -> create approved
          }
        }
        const built =
          toCreate.length > 0
            ? buildAliasesForCodes({ product, codes: toCreate, existingAliases: aliases, businessId, sessionId, idFactory, now })
            : { aliases: [] as Alias[], queued: [] as PendingSyncItem[], conflicts: [] as { code: string; otherProductId: string }[] };
        for (const c of built.conflicts) conflicts.push(c);

        if (flipIds.size > 0 || built.aliases.length > 0) {
          const flipped = aliases.filter((a) => flipIds.has(a.id));
          const flipQueue = flipped.map((a) =>
            makeQueueItem({
              idFactory, now, businessId, sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS",
              payload: { ...a, approved: true },
              idempotencyKey: buildIdempotencyKey(businessId, sessionId, a.id, "RESOLVE_ALIAS"),
              scanEventId: null,
            }),
          );
          set((s) => ({
            aliases: s.aliases
              .map((a): Alias => (flipIds.has(a.id) ? { ...a, approved: true, updatedAt: now(), syncStatus: "pending" } : a))
              .concat(built.aliases),
            pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued, ...flipQueue],
          }));
          for (const a of [...flipped, ...built.aliases]) {
            emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "discovered_approved" } });
          }
        }
        if (conflicts.length > 0) {
          set({ lastAliasConflicts: conflicts.map((c) => ({ reviewId: "", code: c.code, existingProductId: c.otherProductId })) });
        }
      },

      clearAliasConflicts: () => set({ lastAliasConflicts: null }),

      unlinkAlias: (aliasId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias) return;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:unlink:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        // Mark related feed rows as needing review again (scan HISTORY is preserved, just no longer "known").
        const scanFeed = state.scanFeed.map((e) =>
          e.matchedProductId === alias.productId && e.cleanCode === alias.cleanCode
            ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
            : e,
        );
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          scanFeed,
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct: alias.productId, toProduct: "", cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      moveAlias: (aliasId, toProductId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias || !toProductId || toProductId === alias.productId) return;
        const fromProduct = alias.productId;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:move:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, productId: toProductId, approved: true, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct, toProduct: toProductId, cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      // --- Phase 6: wrong-decode correction -------------------------------------------------------

      removeFromCount: (productId) => {
        if (get().currentSession?.locked) return; // locked session: counts are read-only until unlocked
        const state = get();
        const removed = state.finalCounts.find((c) => c.productId === productId);
        if (!removed) return;
        // Session-only: drop the count row. Product + aliases are untouched (reversible by re-scanning).
        set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
        emitAudit({ entityType: "InventoryCount", entityId: removed.id, action: "count_removed", metadata: { productId, quantity: removed.quantity, reason: "remove_from_count" } });
      },

      correctProduct: (productId, fields) => {
        if (get().currentSession?.locked) return; // locked session: product edits are blocked until unlocked
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        // Whitelist editable, product-facing fields only. Alias trust (approved/verified) is NEVER touched here.
        const safe: Partial<Product> = {};
        for (const k of ["name", "brand", "category", "specsShort", "specsFull", "primarySku", "imageUrl", "location", "unitCost"] as const) {
          if (k === "unitCost") {
            if (Object.hasOwn(fields, k)) safe.unitCost = fields.unitCost;
          } else if (fields[k] !== undefined) {
            safe[k] = fields[k];
          }
        }
        const updated: Product = { ...product, ...safe, updatedAt: now(), updatedBy: "human" };
        // Task 4: a human editing the name or brand is a PERMANENT correction - stamp structuredBy
        // "human" so no later automatic re-structuring (hot path or the offline backfill) ever
        // overwrites it. Mirror the corrected brand into structuredBrand so the table's Brand column
        // (which prefers structuredBrand) reflects the edit immediately rather than a stale value.
        if (safe.name !== undefined || safe.brand !== undefined) {
          updated.structuredBy = "human";
          if (safe.brand !== undefined) updated.structuredBrand = safe.brand;
        }
        // Task 1 fix: a SAVE_PRODUCT idempotency key built from businessId:sessionId:productId:SAVE_PRODUCT
        // alone is identical for every edit to the same product in the same session - MockDb/
        // FirebaseSyncTarget dedupe on that key, so edit #2 was silently swallowed as "alreadyApplied"
        // and never persisted. Fold a content fingerprint of THIS edit (the changed field values +
        // updatedAt, minted once here) into the key so distinct edits mint distinct keys, matching the
        // existing "${entityId}:<suffix>" pattern used elsewhere in this file (unlink/move/markwrong).
        // A genuine RETRY never calls this function again - the drain loop replays the exact same
        // PendingSyncItem object (same key) via db.apply(), so idempotency on repeated network retries
        // of ONE edit is unaffected.
        const editFingerprint = `${JSON.stringify(safe)}@${updated.updatedAt}`;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${productId}:${editFingerprint}`, "SAVE_PRODUCT");
        set((s) => ({ products: s.products.map((p) => (p.id === productId ? updated : p)) }));
        enqueueAndSync([
          makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: updated, idempotencyKey: key, scanEventId: null }),
        ]);
        emitAudit({ entityType: "Product", entityId: productId, action: "product_corrected", metadata: { fields: Object.keys(safe).join(",") } });
      },

      reopenNeedsReview: (cleanCode, reason, importContext) => {
        const state = get();
        const code = (cleanCode ?? "").trim();
        if (!code) return null;
        const existing = state.needsReviewQueue.find((r) => r.cleanCode === code);
        if (existing) {
          set((s) => ({
            needsReviewQueue: s.needsReviewQueue.map((r) =>
              r.id === existing.id
                ? {
                    ...r, status: "open", reason, resolvedAt: null, resolvedBy: null, resolutionAction: null,
                    hasSuggestion: Boolean(importContext?.suggestion), suggestedProductName: importContext?.suggestion?.name ?? "",
                    suggestedBrand: importContext?.suggestion?.brand ?? "", suggestedCategory: importContext?.suggestion?.category ?? "",
                    suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "", suggestedSpecsFull: "",
                    suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "", suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "",
                    suggestedGtin: "", suggestedUpc: "", suggestedEan: "", suggestedImageUrl: "", suggestedProductUrl: "",
                    suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0, providerName: "",
                    decodeStatus: "needs_review", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
                    correctionRecheckStatus: undefined, correctionRecheckedAt: null, correctionRecheckMissingKeys: undefined,
                    reopenedFromWrong: true,
                    importQuantity: importContext?.importQuantity,
                  }
                : r,
            ),
          }));
          return existing.id;
        }
        const id = idFactory();
        const review: UnknownCodeReview = {
          id, businessId: state.businessId, sessionId: state.sessionId, rawCode: code, cleanCode: code,
          normalizedCandidates: normalizeCode(code).searchVariants ?? [code],
          suggestedProductName: importContext?.suggestion?.name ?? "", suggestedBrand: importContext?.suggestion?.brand ?? "",
          suggestedCategory: importContext?.suggestion?.category ?? "", suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "",
          suggestedSpecsFull: "", suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "",
          suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
          suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
          reason, providerName: "", confidence: 0, hasSuggestion: Boolean(importContext?.suggestion), decodeStatus: "needs_review",
          evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "", reopenedFromWrong: true,
          status: "open", createdAt: now(), resolvedAt: null, resolvedBy: null, resolutionAction: null,
          syncStatus: "pending", idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
          importQuantity: importContext?.importQuantity,
        };
        set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
        enqueueAndSync([
          makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "UnknownCodeReview", entityId: id, operation: "SAVE_UNKNOWN_SCAN", payload: review, idempotencyKey: review.idempotencyKey, scanEventId: null }),
        ]);
        return id;
      },

      applyUniversalImport: (rows) => {
        get().ensureAutoSession();
        if (!get().currentSession || get().currentSession?.status !== "active") {
          throw new Error("Start or unlock an active session before applying this import.");
        }
        const summary: UniversalImportApplySummary = { applied: 0, queuedForReview: 0, rejected: 0 };

        // C5 fix (plan-review-mandated): reopenNeedsReview reuses the FIRST review sharing a cleanCode, so
        // two source rows for the same code would otherwise OVERWRITE importQuantity (last row wins) and
        // silently drop the earlier row's quantity - or, on the exact path, mint/count the code twice.
        // Aggregate by resolved code BEFORE any review/count write so each unique code yields exactly one
        // review/count carrying the TOTAL quantity. Order of first appearance is preserved for the summary.
        type AggregatedRow = {
          code: string;
          /** cleanCode passed to reopenNeedsReview. Equal to `code` except on a divergent-identity
           *  collision, where it is disambiguated so the two conflicting identities land as TWO separate
           *  review entries instead of colliding onto one (reopenNeedsReview keys reviews by cleanCode). */
          reviewCode: string;
          status: ImportPreviewRow["status"];
          reason: string;
          quantity: number;
          suggestion: { name: string; brand: string; category: string; specsShort: string; primarySku: string; primaryBarcode: string };
          /** Finding 3 fix (P4 ultra-review HIGH): the resolved identity this aggregate was built from,
           *  used to detect a DIVERGENT collision (same raw key, different real product) so it is never
           *  silently merged under the first row's identity. */
          identitySignature: string;
        };
        // Finding 3 fix: two source rows can share the same raw aggregation key (barcode/partNumber/name
        // fallback) yet resolve to genuinely DIFFERENT products - e.g. two blank-barcode/blank-PN rows
        // that both fall back to a generic name like "Tire" but carry different candidate identities.
        // Merging those under the first row's identity silently discards the second row's identity and
        // misattributes its quantity (resolver-trust law: wrong identity is FAILURE). Compute a resolved
        // identity signature per row - prefer the matched candidate/catalog identity over raw free text -
        // and only sum quantities when two rows for the same raw key share that signature. A divergent
        // collision is routed to its own review entry instead (never merged, never dropped).
        const identitySignature = (preview: ImportPreviewRow, source: NonNullable<ImportPreviewRow["source"]>): string => {
          if (preview.candidate?.uid) return `uid:${preview.candidate.uid}`;
          if (preview.retailCatalogMatch) {
            return `catalog:${preview.retailCatalogMatch.brand}|${preview.retailCatalogMatch.productName}|${preview.retailCatalogMatch.barcode}`;
          }
          // No matched identity at all - fall back to the same brand/name/sku/barcode fields the
          // suggestion itself is built from, so two rows with materially different suggestions (e.g.
          // different brand) are treated as different identities even without a corpus match. DEFECT 1
          // (padded-GTIN equivalence law): a GTIN-shaped barcode is compared by its CANONICAL form so
          // 086699866707 (UPC-A) and 0086699866707 (zero-padded EAN-13) share one signature; non-GTIN
          // codes (part numbers) fall through untouched - their leading zeros carry meaning.
          const sigBarcode = canonicalGtin(source.barcode) ?? source.barcode;
          return `raw:${source.brand}|${source.partNumber}|${sigBarcode}|${source.name}`;
        };
        // DEFECT 1 (padded-GTIN equivalence law): the aggregation MAP key must collapse zero-padded GTIN
        // encodings of one product onto a single entry. Key on the CANONICAL GTIN when the code is
        // GTIN-shaped; otherwise fall back to the raw string (a part number is NEVER canonicalized away).
        // The raw code is still preserved verbatim on the row/alias/product records below.
        const aggKeyFor = (rawCode: string): string => canonicalGtin(rawCode) ?? rawCode;
        const aggregated = new Map<string, AggregatedRow>();
        for (const preview of rows) {
          if (preview.status === "reject" || !preview.source) {
            summary.rejected += 1;
            continue;
          }
          const source = preview.source;
          const rawCode = source.barcode || source.partNumber || source.name;
          if (!rawCode) {
            summary.rejected += 1;
            continue;
          }
          const aggKey = aggKeyFor(rawCode);
          const suggestion = {
            name: preview.retailCatalogMatch?.productName || preview.candidate?.name || source.expected.name || rawCode,
            brand: preview.retailCatalogMatch?.brand || preview.candidate?.brand || source.brand,
            category: preview.retailCatalogMatch?.category || source.category,
            specsShort: [source.model, source.size].filter(Boolean).join(" "),
            primarySku: source.partNumber,
            primaryBarcode: source.barcode,
          };
          const signature = identitySignature(preview, source);
          const existing = aggregated.get(aggKey);
          if (existing) {
            if (existing.identitySignature === signature) {
              // Genuinely the same resolved product - safe to sum (unchanged C5 behavior).
              existing.quantity += source.quantity;
              // A later row for the same code never downgrades an already-exact status to fuzzy/review;
              // an exact match on ANY row for this code is enough to treat the aggregate as exact.
              if (preview.status === "exact") existing.status = "exact";
              continue;
            }
            // Divergent identity collision: do NOT merge under the first identity and do NOT drop this
            // row's identity/quantity. Route BOTH the existing aggregate and this row to Needs Review
            // under distinct keys, each keeping its own quantity, with an honest conflict reason.
            const conflictReason = "This code maps to more than one product in the file; confirm which.";
            if (existing.reason !== conflictReason) {
              existing.status = "review";
              existing.reason = conflictReason;
              // Re-key both the map entry and the reviewCode passed to reopenNeedsReview onto a
              // signature-qualified value, so this aggregate (a) no longer collides in this map with a
              // future row sharing the same raw key but a third distinct identity, and (b) mints its OWN
              // review row below instead of colliding with the review keyed on the bare raw code.
              existing.reviewCode = `${rawCode} (${existing.identitySignature})`;
              aggregated.delete(aggKey);
              aggregated.set(`${aggKey} ${existing.identitySignature}`, existing);
            }
            aggregated.set(`${aggKey} ${signature}`, {
              code: rawCode,
              reviewCode: `${rawCode} (${signature})`,
              status: "review",
              reason: conflictReason,
              quantity: source.quantity,
              suggestion,
              identitySignature: signature,
            });
            continue;
          }
          aggregated.set(aggKey, { code: rawCode, reviewCode: rawCode, status: preview.status, reason: preview.reason, quantity: source.quantity, suggestion, identitySignature: signature });
        }

        get().snapshotCount("Before universal import");
        for (const row of aggregated.values()) {
          const reviewId = get().reopenNeedsReview(row.reviewCode, row.reason, {
            importQuantity: row.quantity,
            suggestion: row.suggestion,
          });
          if (!reviewId) {
            summary.rejected += 1;
            continue;
          }
          if (row.status !== "exact") {
            summary.queuedForReview += 1;
            continue;
          }
          get().resolveUnknown(reviewId, "create_new", {
            origin: "human",
            applyToCount: true,
            newProduct: {
              name: row.suggestion.name,
              brand: row.suggestion.brand,
              category: row.suggestion.category,
              specsShort: row.suggestion.specsShort,
              primarySku: row.suggestion.primarySku,
              primaryBarcode: row.suggestion.primaryBarcode || row.code,
            },
          });
          if (get().needsReviewQueue.find((review) => review.id === reviewId)?.status === "resolved") {
            summary.applied += 1;
          } else {
            summary.queuedForReview += 1;
          }
        }
        get().snapshotCount("After universal import");
        return summary;
      },

      markWrong: async (productId, opts) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        const counts = state.finalCounts.filter((c) => c.productId === productId);
        // Codes that resolved to this product this session (scan feed is the reliable source; the count's
        // aliasesSeen is a fallback). These approved aliases are the ones to deactivate.
        const seenCodes = Array.from(
          new Set([
            ...state.scanFeed.filter((e) => e.matchedProductId === productId).map((e) => e.cleanCode),
            ...counts.flatMap((count) => count.aliasesSeen),
          ]),
        );
        const retainedFeedCodes = Array.from(
          new Set(state.scanFeed.filter((event) => event.matchedProductId === productId).map((event) => event.cleanCode)),
        );
        // 1. Deactivate the APPROVED aliases that mapped the scanned code(s) to this (wrong) product.
        const deactivate = state.aliases.filter(
          (a) => a.productId === productId && a.approved && (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)),
        );
        if (deactivate.length > 0) {
          const ids = new Set(deactivate.map((a) => a.id));
          const queued: PendingSyncItem[] = [];
          const updatedAliases = state.aliases.map((a) => {
            if (!ids.has(a.id)) return a;
            const key = buildIdempotencyKey(state.businessId, state.sessionId, `${a.id}:markwrong:${idFactory()}`, "RESOLVE_ALIAS");
            const u: Alias = { ...a, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
            queued.push(makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: u, idempotencyKey: key, scanEventId: null }));
            emitAudit({ entityType: "Alias", entityId: a.id, action: "wrong_alias_removed", metadata: { productId, cleanCode: a.cleanCode, reason: opts?.reason ?? "marked_wrong" } });
            return u;
          });
          set((s) => ({ aliases: updatedAliases, pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }
        // 1b. Un-verify the wrong product so the DETERMINISTIC resolver can no longer match it by its
        // identifier fields (matchProductByIdentifiers only trusts verified === true). Without this, the
        // next scan of the same barcode would re-match this wrong product and re-count it - bypassing the
        // firewall entirely. The product row is kept (status unchanged) for audit/repair, just untrusted.
        if (product && product.verified) {
          const key = buildIdempotencyKey(state.businessId, state.sessionId, `${product.id}:markwrong:unverify`, "SAVE_PRODUCT");
          const unverified: Product = { ...product, verified: false, updatedAt: now(), updatedBy: "human" };
          set((s) => ({
            products: s.products.map((p) => (p.id === productId ? unverified : p)),
            pendingSyncQueue: [
              ...s.pendingSyncQueue,
              makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: unverified, idempotencyKey: key, scanEventId: null }),
            ],
          }));
          emitAudit({ entityType: "Product", entityId: productId, action: "product_unverified", metadata: { reason: opts?.reason ?? "marked_wrong" } });
        }
        // 2. Reset related feed rows to needs_review (scan history preserved; no longer "known").
        set((s) => ({
          scanFeed: s.scanFeed.map((e) =>
            e.matchedProductId === productId && (seenCodes.length === 0 || seenCodes.includes(e.cleanCode))
              ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
              : e,
          ),
        }));
        // 3. Transfer the wrong product's physical quantity to a SAFE "Unidentified item" provisional
        //    keyed by the representative scanned code, then reopen review. Total physical quantity is
        //    INVARIANT across any identity correction (North-star #2): the items are still on the
        //    shelf; only their identity was wrong.
        const code = seenCodes[0] || product?.primaryBarcode || "";
        if (counts.length > 0) {
          const wrongQty = counts.reduce((total, count) => total + count.quantity, 0);
          // (a) Remove the wrong count row FIRST. ensureProvisionalCount's idempotency guard
          //     (scanStore.ts:2952) short-circuits when any CURRENTLY-COUNTED product carries this
          //     code in its identifier fields - the wrong product still does (step 1b un-verifies but
          //     does not blank primaryBarcode). Its `counted` set is built from finalCounts, so removing
          //     the row here is what lets the mint below proceed.
          set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
          // F-03 FIX: sync the removal (mirrors deleteProductsInternal's "SYNC THE REPOINT" balanced-pair
          // fix, reviewed defect 2026-07-22, scanStore.ts ~6809) - without this the backend keeps the
          // wrong product's InventoryCount doc forever, so a fresh cloud reload / second-device load
          // would restore its quantity even as the corrected identity below also counts it (2 becomes 4).
          // FRESH per-transfer key (never the original counting key) so the applied-key dedupe cannot
          // reject this as an idempotency_conflict.
          for (const count of counts) {
            if (count.quantity <= 0) continue;
            const outKey = buildIdempotencyKey(state.businessId, count.sessionId, `${count.id}:markwrong-transfer-out`, "INCREMENT_COUNT");
            const outPayload: IncrementPayload = {
              businessId: state.businessId,
              sessionId: count.sessionId,
              productId,
              scanEventId: `${count.id}:markwrong-transfer`,
              quantityDelta: -count.quantity,
              idempotencyKey: outKey,
            };
            enqueueAndSync([
              makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "InventoryCount", entityId: count.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
            ]);
          }
          if (code && wrongQty > 0) {
            const transferProvisionals = new Map<string, Product>();
            // A count may retain alias metadata for rows already trimmed from the feed. Only a retained
            // feed row gets its own provisional; otherwise ensureProvisionalCount would manufacture an
            // extra physical scan before the residual logic can account for the trimmed quantity.
            const transferCodes = retainedFeedCodes.length > 0
              ? retainedFeedCodes
              : Array.from(new Set(counts.flatMap((count) => count.aliasesSeen.length > 0 ? count.aliasesSeen : [code])));
            for (const transferCode of transferCodes) {
            // (b) Mint + count the Unidentified provisional off the first reopened feed row (step 2
            //     already reset the wrong product's rows to matchedProductId: null / needs_review, which
            //     is exactly the shape ensureProvisionalCount's feed lookup matches). Task 2's D1 repair
            //     makes this mint enqueue SAVE_PRODUCT + SAVE_SCAN_EVENT + INCREMENT_COUNT too.
            //     TASK 9 FIX (provisional-wrong inflation): the mint target id comes from
            //     ensureProvisionalCount's own return, NEVER re-derived via an unordered
            //     products.find on primaryBarcode. When the marked-wrong product is ITSELF a
            //     provisional, the old find matched it (its primaryBarcode is never blanked) and the
            //     repoint loop re-counted the same physical scans on the OLD row while the mint had
            //     already counted one event on the NEW row - inflating the total. The id-keyed lookup
            //     below is deterministic; excluding productId is defense in depth so the repoint can
            //     never target the product being corrected away from.
            const mintedId = get().ensureProvisionalCount(
              transferCode,
              `Marked wrong - re-identify. Previous match "${product?.name ?? ""}" removed.`,
              // F-03: this repoints an EXISTING reopened feed row that may already be synced under the
              // wrong identity - see ensureProvisionalCount's freshTransferKeys comment for why the
              // inherited key must not be reused.
              {
                freshTransferKeys: true,
                // With no retained feed row, the per-session residual loop below owns the full
                // physical quantity. Mint only the safe identity here so no synthetic +1 is added
                // before that exact residual is reconstructed.
                countIfFeedMissing: retainedFeedCodes.length > 0,
              },
            );
            const provRow = get().products.find(
              (p) => p.id === mintedId && p.id !== productId && p.provisional === true && p.status !== "archived",
            );
            if (provRow) {
              transferProvisionals.set(transferCode, provRow);
              // (c) Repoint every REMAINING reopened feed event for this code onto the provisional and
              //     apply each through the ledger (incrementInventoryCount dedupes by event id), stamping
              //     the same-fact quantityDelta: 1 on the row. The transferred quantity is carried by
              //     REAL events - the ledger replay reproduces it exactly (North-star #2).
              const pending = get().scanFeed.filter(
                (e) => e.cleanCode === transferCode && e.matchedProductId === null && e.status === "needs_review",
              );
              for (const ev2 of pending) {
                const stNow = get();
                const cur = stNow.finalCounts.find((c) => c.productId === provRow.id);
                if (cur?.scanEventIds.includes(ev2.id)) continue;
                const repointedEvent: ScanEvent = { ...ev2, matchedProductId: provRow.id, status: "known", quantityDelta: 1 };
                const r = incrementInventoryCount(stNow.finalCounts, repointedEvent, idFactory);
                repointedEvent.quantityAfterScan = r.count.quantity;
                set((s2) => ({
                  finalCounts: r.counts,
                  scanFeed: s2.scanFeed.map((e) =>
                    e.id === ev2.id
                      ? { ...e, matchedProductId: provRow.id, status: "known" as const, quantityDelta: 1, quantityAfterScan: r.count.quantity }
                      : e,
                  ),
                }));
                // F-03 FIX: sync this repointed event. FRESH transfer keys (never ev2's original
                // SAVE_SCAN_EVENT/INCREMENT_COUNT keys, which were stamped against the OLD (wrong)
                // product's Firestore applied-key marker and would be rejected as idempotency_conflict
                // on replay against the new productId) - same reasoning as ensureProvisionalCount's
                // freshTransferKeys path above.
                const saveKey = buildIdempotencyKey(state.businessId, ev2.sessionId, `${ev2.id}:markwrong-transfer:${provRow.id}`, "SAVE_SCAN_EVENT");
                const incKey = buildIdempotencyKey(state.businessId, ev2.sessionId, `${ev2.id}:markwrong-transfer:${provRow.id}`, "INCREMENT_COUNT");
                const repointedIncPayload: IncrementPayload = {
                  businessId: state.businessId,
                  sessionId: ev2.sessionId,
                  productId: provRow.id,
                  scanEventId: ev2.id,
                  quantityDelta: 1,
                  idempotencyKey: incKey,
                };
                enqueueAndSync([
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: ev2.sessionId, entityType: "ScanEvent", entityId: ev2.id, operation: "SAVE_SCAN_EVENT", payload: repointedEvent, idempotencyKey: saveKey, scanEventId: ev2.id }),
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: ev2.sessionId, entityType: "InventoryCount", entityId: r.count.id, operation: "INCREMENT_COUNT", payload: repointedIncPayload, idempotencyKey: incKey, scanEventId: ev2.id }),
                ]);
              }
            }
            }
            // (d) Feed-trim safety net: account for retained rows across ALL reopened codes before
            //     minting any synthetic remainder. A wrong identity may have multiple real barcodes;
            //     those codes must retain distinct provisional identities rather than becoming a
            //     representative-code residual.
            const transferProductIds = new Set([...transferProvisionals.values()].map((provisional) => provisional.id));
            const transferredEvents = new Map(
              get().scanFeed
                .filter((event) => event.matchedProductId !== null && transferProductIds.has(event.matchedProductId))
                .map((event) => [event.id, event.quantityDelta] as const),
            );
            for (const count of counts) {
              const represented = count.scanEventIds.reduce(
                (total, eventId) => total + (transferredEvents.get(eventId) ?? 0),
                0,
              );
              const missing = count.quantity - represented;
              if (missing <= 0) continue;
              const residualCode = count.aliasesSeen.find((alias) => transferProvisionals.has(alias)) ?? code;
              const residualProvisional = transferProvisionals.get(residualCode);
              if (!residualProvisional) continue;
              const residualId = idFactory();
              const residualEvent: ScanEvent = {
                id: residualId,
                businessId: state.businessId,
                sessionId: count.sessionId,
                rawCode: residualCode,
                cleanCode: residualCode,
                normalizedCandidates: [],
                matchedProductId: residualProvisional.id,
                matchType: "unknown",
                status: "known",
                resolverStatus: "needs_review",
                codeType: detectCodeType(residualCode),
                reason: "markWrong residual repoint (feed trimmed by persist).",
                quantityDelta: missing,
                quantityAfterScan: 0,
                createdAt: now(),
                source: "scan",
                notes: "markWrong residual repoint (feed trimmed by persist).",
                syncStatus: "pending",
                syncError: null,
                idempotencyKey: buildIdempotencyKey(state.businessId, count.sessionId, residualId, "INCREMENT_COUNT"),
              };
              const rr = incrementInventoryCount(get().finalCounts, residualEvent, idFactory);
              residualEvent.quantityAfterScan = rr.count.quantity;
              set((s2) => ({ scanFeed: [residualEvent, ...s2.scanFeed], finalCounts: rr.counts }));
              const residualInc: IncrementPayload = {
                businessId: state.businessId, sessionId: count.sessionId, productId: residualProvisional.id,
                scanEventId: residualId, quantityDelta: missing, idempotencyKey: residualEvent.idempotencyKey,
              };
              enqueueAndSync([
                makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "ScanEvent", entityId: residualId, operation: "SAVE_SCAN_EVENT", payload: residualEvent, idempotencyKey: buildIdempotencyKey(state.businessId, count.sessionId, residualId, "SAVE_SCAN_EVENT"), scanEventId: residualId }),
                makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "InventoryCount", entityId: rr.count.id, operation: "INCREMENT_COUNT", payload: residualInc, idempotencyKey: residualEvent.idempotencyKey, scanEventId: residualId }),
              ]);
            }
          }
          emitAudit({ entityType: "InventoryCount", entityId: counts[0].id, action: "count_transferred", metadata: { productId, quantity: wrongQty, toCode: code, reason: "marked_wrong" } });
        }
        // 4. Reopen Needs Review for the representative scanned code.
        const reviewId = code
          ? get().reopenNeedsReview(code, `Marked wrong by owner. Previous match ${product?.name ? `"${product.name}"` : ""} removed - re-identify the product.`)
          : null;
        if (reviewId) {
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "needs_review_reopened", metadata: { code, fromProduct: productId } });
          // 5. Correction recheck through the decode pipeline (cost-guarded; never auto-saves or counts).
          await get().correctionRecheck(reviewId, { reason: opts?.reason });
        }
        // 6. Catalog revocation round (design §2.3): report the wrong identity to the shared master
        // catalog so other shops stop replaying it. Best-effort and NON-BLOCKING - mirrors how
        // correctionRecheck above is a trailing side-effect, not a dependency: markWrong's local
        // correction (count transfer, alias deactivation) already succeeded regardless of whether
        // this call lands, times out, the user has no session, or the server is unreachable. Never
        // awaited into the return path; every failure mode is swallowed here on purpose (matches the
        // project's "never block scanning/correction on the backend" rule for the sync queue).
        if (code) {
          void (async () => {
            try {
              const user = await getSession();
              if (!user) return;
              const idToken = await user.getIdToken();
              await fetch("/api/catalog-dispute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  idToken,
                  normalizedBarcode: code,
                  businessId: state.businessId,
                  reason: opts?.reason ?? "marked_wrong",
                }),
              });
            } catch {
              // best-effort; local correction already succeeded regardless of this call
            }
          })();
        }
        return reviewId;
      },

      correctionRecheck: async (reviewId, opts) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        // Cost guard: one Pro recheck per marked-wrong code unless the user explicitly retries.
        if (review.correctionRecheckStatus && review.correctionRecheckStatus !== "requested" && !opts?.retry) return;
        const ai = get().aiStatus;
        const patch = (extra: Partial<UnknownCodeReview>) =>
          set((s) => ({ needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, ...extra } : r)) }));

        emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_requested", metadata: { code: review.cleanCode, reason: opts?.reason ?? "" } });

        // Decode unavailable: do NOT fail the correction. Mark unavailable and keep it in Needs Review.
        // The recheck runs the SAME decode pipeline as a normal scan (corpus -> Go-UPC -> Fetch V2 -> GPT,
        // never Gemini), and that pipeline has free rungs, so a missing provider key is NOT a blocker. The
        // only conditions that stop it running at all are the server kill switch and the server-side
        // live-AI disable - the same two server flags the normal decode path honors. Key NAMES only.
        if (ai.killSwitchOn || !ai.liveEnabled) {
          const reason = ai.killSwitchOn ? "kill_switch" : "live_ai_disabled";
          patch({
            correctionRecheckStatus: "unavailable",
            correctionRecheckedAt: now(),
            ...(ai.missingKeys.length > 0 ? { correctionRecheckMissingKeys: [...ai.missingKeys] } : {}),
          });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "unavailable", reason } });
          return;
        }

        patch({ correctionRecheckStatus: "requested", correctionRecheckedAt: now() });
        try {
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST (route.ts:294-324)
          // or this 401s "unauthenticated" - mock mode resolves {} and is unaffected.
          // P4 (#28): shared backoff helper - a human-triggered single action, not a storm contributor,
          // but gets the same honest-Retry-After/jitter resilience for consistency.
          const res = await fetchWithBackoff("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(await aiRequestAuth(get().businessId)),
              mode: "decode", rawCode: review.rawCode, cleanCode: review.cleanCode, codeType: detectCodeType(review.cleanCode), confidenceThreshold: 0.85,
            }),
          });
          const data = await res.json();
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          const status: "verified_correction" | "insufficient_evidence" | "conflict" =
            decision?.status === "verified" ? "verified_correction" : decision?.status === "conflict" ? "conflict" : "insufficient_evidence";

          if (status === "verified_correction" && best) {
            // Recommendation is a SUGGESTION only - the human still approves it via Needs Review (no auto-save/count).
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              suggestedProductName: best.productName, suggestedBrand: best.brand, suggestedCategory: best.category,
              suggestedSpecsShort: best.specsShort, suggestedPrimarySku: best.primarySku,
              suggestedPrimaryBarcode: scrubSuggestedBarcode(best.primaryBarcode, best.primarySku),
              suggestedGtin: scrubSuggestedBarcode(best.gtin, best.primarySku),
              suggestedUpc: scrubSuggestedBarcode(best.upc, best.primarySku),
              suggestedEan: scrubSuggestedBarcode(best.ean, best.primarySku),
              suggestedAliases: best.aliases ?? [],
              sourceUrls: best.sourceUrls ?? [], verifiedFacts: best.verifiedFacts ?? [], guesses: best.guesses ?? [],
              hasSuggestion: true, decodeStatus: "verified", confidence: decision?.confidence ?? best.confidence ?? 0,
              evidenceStrength: decision?.evidenceStrength ?? "none", exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheckDecision: decision?.crossCheck?.decision ?? "",
              reason: "Correction recheck: verified correction suggested. Approve to save (still requires your confirmation).",
            });
          } else {
            // insufficient_evidence | conflict -> keep in Needs Review, safe message, NO trusted suggestion.
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              decodeStatus: status === "conflict" ? "conflict" : "needs_review",
              reason: status === "conflict"
                ? "Correction recheck: sources conflict on identity. Kept in Needs Review - resolve manually."
                : "Correction recheck: insufficient evidence to auto-correct. Kept in Needs Review.",
            });
          }
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status } });
        } catch {
          patch({ correctionRecheckStatus: "unavailable", correctionRecheckedAt: now() });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "error" } });
        }
      },

      importProductsCsv: (text) => {
        const state = get();
        const { rows } = parseCsv(text);
        const plan = buildProductImport({
          rows,
          existingProducts: state.products,
          existingAliases: state.aliases,
          businessId: state.businessId,
          idFactory,
          now,
        });
        applyImportedUnitCosts(rows, plan.products);

        if (plan.products.length > 0 || plan.aliases.length > 0 || plan.refreshedProducts.length > 0) {
          set((s) => {
            const refreshedById = new Map(plan.refreshedProducts.map((p) => [p.id, p]));
            return {
              products: [
                ...s.products.map((p) => refreshedById.get(p.id) ?? p),
                ...plan.products,
              ],
              aliases: [...s.aliases, ...plan.aliases],
            };
          });

          // Queue idempotent SAVE_PRODUCT (each new product) BEFORE its aliases, then RESOLVE_ALIAS, so a
          // reloaded alias always references a persisted product. Same durable path Loop 4 proved.
          // QA Task 7: a refreshed (existing-barcode) product is ALSO queued as SAVE_PRODUCT with the
          // SAME id (idempotency key is id-based, so it upserts) - never a quantity change, only the
          // descriptive fields buildProductImport already refreshed on plan.refreshedProducts.
          const items: PendingSyncItem[] = [];
          for (const p of [...plan.products, ...plan.refreshedProducts]) {
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: p,
              idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, p.id, "SAVE_PRODUCT"),
              scanEventId: null,
            }));
          }
          for (const a of plan.aliases) {
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: a,
              idempotencyKey: a.idempotencyKey, scanEventId: null,
            }));
          }
          enqueueAndSync(items);
        }

        emitAudit({
          entityType: "ImportBatch",
          entityId: `import-${idFactory()}`,
          action: "csv_import",
          metadata: {
            rowsParsed: plan.rowsParsed,
            productsCreated: plan.products.length,
            aliasesCreated: plan.aliases.length,
            duplicates: plan.duplicates.length,
            conflicts: plan.conflicts.length,
            refreshed: plan.refreshed.length,
          },
        });

        return {
          rowsParsed: plan.rowsParsed,
          productsCreated: plan.products.length,
          aliasesCreated: plan.aliases.length,
          duplicates: plan.duplicates.length,
          conflicts: plan.conflicts,
          refreshed: plan.refreshed.length,
        };
      },

      auditCsvExport: (kind, rowCount, format) => {
        // Backward-compatible: action + entityId unchanged; format defaults to "csv" so existing 2-arg
        // callers and the csvImport audit test keep working, while new multi-format exports record which.
        emitAudit({ entityType: "Export", entityId: kind, action: "csv_export", metadata: { kind, rowCount, format: format ?? "csv" } });
      },

      pendingCount: () => get().pendingSyncQueue.length,
      getProduct: (id) => (id ? get().products.find((p) => p.id === id) : undefined),

      clearSession: () => {
        clearTrustedExactProbes();
        set({
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
        });
      },

      clearLocalCache: () => {
        clearTrustedExactProbes();
        // Clear ONLY browser-local data. In CLOUD mode we must NEVER call db.reset() (FirebaseSyncTarget
        // guards against a destructive cloud wipe and throws) and must NEVER reseed mock data over the
        // real cloud catalog - the cloud data re-loads on the next page load. In MOCK mode, reset the
        // local MockDb and reload clean seed (the original behavior).
        if (!cloudBackend) db.reset();
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            // F-4 fix (resurrection leak, 2026-08-09): cancel any coalesced write still pending for
            // these keys FIRST via the wrapper's own removeItem, before the direct dual-store delete -
            // otherwise a write already queued for "sis-scan-v1" (or the per-uid key) can land AFTER
            // this clears it, resurrecting the just-wiped blob for the next user on a shared device.
            if (deps.persistName) scanPersistBackingStorage.removeItem("sis-scan-v1");
            removePersistedKeyEverywhere("sis-scan-v1");
            const currentUid = get().userId;
            if (currentUid) {
              if (deps.persistName) scanPersistBackingStorage.removeItem(persistKeyForUid(currentUid));
              removePersistedKeyEverywhere(persistKeyForUid(currentUid));
            }
            window.localStorage.removeItem("sis-mockdb-v1");
          } catch {
            // ignore
          }
        }
        const common = {
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          aiLookupLogs: [],
          lastSyncError: null,
          lastMismatchWarning: null,
          lastAliasConflicts: null,
          lastCategoryWarning: null,
          breaker: initBreaker(),
          lastCleanupBackup: null,
          lastProductDeleteBackup: null,
          catalog: [],
          shopOverrides: [],
          feedbackEvents: [],
        };
        if (cloudBackend) {
          // Cloud: empty the local catalog; products/aliases re-load from Firestore on reload. No reseed.
          set({ ...common, products: [], aliases: [] });
        } else {
          const fresh = getSeed();
          set({ ...common, products: fresh.products, aliases: fresh.aliases });
        }
      },

      applyCleanupSelections: (selectedCountIds) => {
        const state = get();
        const sel = new Set(selectedCountIds);
        const removedCounts = state.finalCounts.filter((c) => sel.has(c.id));
        if (removedCounts.length === 0) return { removed: 0, backup: null };

        const remainingCounts = state.finalCounts.filter((c) => !sel.has(c.id));
        const survivingProductIds = new Set(remainingCounts.map((c) => c.productId));
        // Remove a product/alias ONLY when no surviving count references it AND it is not a protected
        // (seed/manual) product. Good rows can never lose their product.
        const removableProductIds = new Set(
          removedCounts
            .map((c) => c.productId)
            .filter((pid) => {
              if (survivingProductIds.has(pid)) return false;
              const p = state.products.find((x) => x.id === pid);
              return !!p && p.source !== "seed" && p.source !== "manual";
            }),
        );

        const backup: CleanupBackup = {
          removedCounts,
          removedProducts: state.products.filter((p) => removableProductIds.has(p.id)),
          removedAliases: state.aliases.filter((a) => removableProductIds.has(a.productId)),
          removedAt: now(),
        };

        set({
          finalCounts: remainingCounts,
          products: state.products.filter((p) => !removableProductIds.has(p.id)),
          aliases: state.aliases.filter((a) => !removableProductIds.has(a.productId)),
          lastCleanupBackup: backup,
        });
        get().recordFeedback("ran_cleanup", { code: "", meta: { removed: removedCounts.length } });
        return { removed: removedCounts.length, backup };
      },

      cleanupJunkCounts: () => {
        const { finalCounts, products, aliases, catalog } = get();
        const { recommendations } = buildCleanupRecommendations({ finalCounts, products, aliases, catalog });
        const highIds = recommendations.filter((r) => r.defaultChecked).map((r) => r.id);
        return get().applyCleanupSelections(highIds);
      },

      undoCleanup: () => {
        const backup = get().lastCleanupBackup;
        if (!backup) return false;
        // Restore additively (dedupe by id) so any scans made after the cleanup are preserved.
        const mergeById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const ids = new Set(current.map((x) => x.id));
          return [...current, ...restored.filter((x) => !ids.has(x.id))];
        };
        set((s) => ({
          finalCounts: mergeById(s.finalCounts, backup.removedCounts),
          products: mergeById(s.products, backup.removedProducts),
          aliases: mergeById(s.aliases, backup.removedAliases),
          lastCleanupBackup: null,
        }));
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: backup.removedCounts.length } });
        return true;
      },

      deleteProduct: (productId) => {
        const r = deleteProductsInternal(get, set, emitAudit, now, idFactory, [productId], "product_deleted");
        return r.backup;
      },

      purgePoisonedProducts: () => {
        // Targeted, safe purge of the known poison: NON-protected (non seed/manual) products whose identity
        // is the poison code 745125495781, or whose name is a rivet/Manstel kit sitting on that code. Seed/
        // manual products are never touched. Reversible via undoDeleteProduct. (The persist version bump
        // additionally resets every browser's local cache to clean seed on next load.)
        const state = get();
        const ids = state.products
          .filter((p) => {
            if (p.source === "seed" || p.source === "manual") return false;
            const codes = productIdentityCodes(p, state.aliases);
            const onPoison = codes.some((c) => POISON_CODES.has(c));
            const rivet = /\bmanstel\b|\brivet\b/i.test(`${p.name} ${p.brand}`);
            return onPoison || (rivet && codes.some((c) => POISON_CODES.has(c)));
          })
          .map((p) => p.id);
        if (ids.length === 0) return { removed: 0, backup: null };
        const r = deleteProductsInternal(get, set, emitAudit, now, idFactory, ids, "product_purged");
        return { removed: ids.length, backup: r.backup };
      },

      undoDeleteProduct: () => {
        const backup = get().lastProductDeleteBackup;
        if (!backup) return false;
        // EXACT restore: put the product/alias/count rows back as they were, restore the catalog/shop
        // entries, and re-attach the scan-feed rows. Replace-by-id so a row that still exists (archived) is
        // restored to its pre-delete value; rows fully removed (counts) are re-added.
        const upsertById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const map = new Map(current.map((x) => [x.id, x]));
          for (const x of restored) map.set(x.id, x);
          return [...map.values()];
        };
        const restoredProductIds = new Set(backup.products.map((p) => p.id));
        const feedById = new Map(backup.feed.map((e) => [e.id, e]));
        // SYNC THE UNDO (reviewed defect 2026-07-22): the delete shipped archive + transfer ops to the
        // backend, so a local-only restore is silently re-reverted by the next refreshFromCloud - the
        // remote still says "archived + quantity on the provisional", the products merge re-deletes the
        // undone product, and the remote provisional row re-adds the transferred quantity ALONGSIDE the
        // restored local row (2 became 4). Mirror every delete op with a compensator: a restore
        // SAVE_PRODUCT per product, a reverse transfer PAIR per backed-up count row (net zero per
        // session), and an archive SAVE_PRODUCT for a minted provisional the undo removes. Compensators
        // APPEND after any still-pending delete ops, so undoing before the queue drains nets out to the
        // same restored remote state. Keys are distinct from the delete's, so the backend dedupe never
        // swallows the reversal.
        const s0 = get();
        const bid = s0.businessId;
        const liveCountById = new Map(s0.finalCounts.map((c) => [c.id, c]));
        const mintedProducts = s0.products.filter((p) => (backup.mintedProvisionalIds ?? []).includes(p.id));
        const syncOps: PendingSyncItem[] = [];
        for (const p of backup.products) {
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: s0.sessionId, entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: { ...p }, idempotencyKey: buildIdempotencyKey(bid, s0.sessionId, `${p.id}:delete:undo-restore`, "SAVE_PRODUCT"), scanEventId: null }),
          );
        }
        for (const c of backup.counts) {
          if (c.quantity <= 0) continue; // the delete transferred nothing for zero rows -> nothing to reverse
          const live = liveCountById.get(c.id);
          if (live && live.productId !== c.productId) {
            // The row is still repointed at the provisional: pull the transferred units back off it.
            // Post-delete scans incremented the SAME remote row, so subtracting exactly the backup's
            // quantity leaves any residual units on the provisional (matches the local carve below).
            const outKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-undo-out`, "INCREMENT_COUNT");
            const outPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: live.productId, scanEventId: `${c.id}:delete-transfer-undo`, quantityDelta: -c.quantity, idempotencyKey: outKey };
            syncOps.push(
              makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
            );
          }
          const inKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-undo-in`, "INCREMENT_COUNT");
          const inPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: c.productId, scanEventId: `${c.id}:delete-transfer-undo`, quantityDelta: c.quantity, idempotencyKey: inKey };
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
          );
        }
        set((s) => {
          // The repointed count rows share ids with the backed-up originals, so upsertById below
          // restores them onto the original product. LAW GUARD: a scan made AFTER the delete
          // incremented the SAME repointed row (Phase-2 re-scan bridge), so a plain restore would
          // absorb that unit - carve the surplus (quantity + event ids beyond the backup's) onto a
          // residual row that stays on the provisional. Total quantity is invariant across undo.
          const backupCountById = new Map(backup.counts.map((c) => [c.id, c]));
          const residuals: InventoryCount[] = [];
          for (const live of s.finalCounts) {
            const orig = backupCountById.get(live.id);
            if (!orig || live.quantity <= orig.quantity) continue;
            residuals.push({
              ...live,
              id: idFactory(),
              quantity: live.quantity - orig.quantity,
              scanEventIds: live.scanEventIds.filter((id) => !orig.scanEventIds.includes(id)),
              appliedIdempotencyKeys: live.appliedIdempotencyKeys.filter((k) => !orig.appliedIdempotencyKeys.includes(k)),
            });
          }
          const restoredCounts = [...upsertById(s.finalCounts, backup.counts), ...residuals];
          const stillCounted = new Set(restoredCounts.map((c) => c.productId));
          const minted = new Set(backup.mintedProvisionalIds ?? []);
          return {
          products: upsertById(s.products, backup.products).filter((p) => !(minted.has(p.id) && !stillCounted.has(p.id))),
          aliases: upsertById(s.aliases, backup.aliases),
          finalCounts: restoredCounts,
          catalog: [...s.catalog, ...backup.catalog.filter((c) => !s.catalog.some((x) => x.normalizedBarcode === c.normalizedBarcode && x.name === c.name))],
          shopOverrides: [...s.shopOverrides, ...backup.shopOverrides.filter((o) => !s.shopOverrides.some((x) => x.businessId === o.businessId && x.normalizedBarcode === o.normalizedBarcode))],
          scanFeed: s.scanFeed.map((e) => feedById.get(e.id) ?? e),
          lastProductDeleteBackup: null,
          };
        });
        // A minted provisional the undo just removed locally (no residual count kept it) must be
        // archived remotely too, or refreshFromCloud re-adds it as an active ghost product.
        for (const prov of mintedProducts) {
          if (get().products.some((p) => p.id === prov.id)) continue; // residual kept it -> keep remotely
          const archivedProv: Product = { ...prov, status: "archived", verified: false, updatedBy: "human" };
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: s0.sessionId, entityType: "Product", entityId: prov.id, operation: "SAVE_PRODUCT", payload: archivedProv, idempotencyKey: buildIdempotencyKey(bid, s0.sessionId, `${prov.id}:provisional:undo-archive`, "SAVE_PRODUCT"), scanEventId: null }),
          );
        }
        set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...syncOps] }));
        get().syncPending(); // drain the compensating ops now (same pattern as the delete)
        for (const p of backup.products) emitAudit({ entityType: "Product", entityId: p.id, action: "product_delete_undone", metadata: { name: p.name } });
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: restoredProductIds.size } });
        return true;
      },

      // P2 maintenance: backfill identifier fields from a "UPC <code> - " name prefix so legacy products
      // carry their barcode in a real field (not just the name). Reversible + audited; never auto-run.
      previewIdentifierBackfill: () => {
        const out: Array<{ productId: string; name: string; code: string }> = [];
        for (const p of get().products) {
          if (p.status === "archived" || p.primaryBarcode) continue; // only fill empty identifier rows
          const code = codeFromNamePrefix(p.name);
          if (code) out.push({ productId: p.id, name: p.name, code });
        }
        return out;
      },

      applyIdentifierBackfill: (productIds) => {
        const targets = new Set(productIds);
        const snapshot: Array<{ productId: string; primaryBarcode: string; upc: string }> = [];
        let changed = 0;
        const products = get().products.map((p) => {
          if (!targets.has(p.id) || p.status === "archived" || p.primaryBarcode) return p;
          const code = codeFromNamePrefix(p.name);
          if (!code) return p;
          const norm = normCodeToken(code);
          snapshot.push({ productId: p.id, primaryBarcode: p.primaryBarcode ?? "", upc: p.upc ?? "" });
          changed++;
          emitAudit({ entityType: "Product", entityId: p.id, action: "identifier_backfilled", metadata: { code: norm } });
          // Fill primaryBarcode; fill upc only when the code is a 12-digit UPC-A (don't mislabel other lengths).
          return { ...p, primaryBarcode: code, upc: !p.upc && /^\d{12}$/.test(norm) ? code : p.upc, updatedAt: now(), updatedBy: "human" };
        });
        if (changed > 0) set({ products, lastIdentifierBackfill: snapshot });
        return { changed };
      },

      undoIdentifierBackfill: () => {
        const snap = get().lastIdentifierBackfill;
        if (!snap || snap.length === 0) return false;
        const byId = new Map(snap.map((s) => [s.productId, s]));
        const products = get().products.map((p) => {
          const prev = byId.get(p.id);
          return prev ? { ...p, primaryBarcode: prev.primaryBarcode, upc: prev.upc, updatedAt: now(), updatedBy: "human" } : p;
        });
        set({ products, lastIdentifierBackfill: null });
        return true;
      },
    };
  };
}

/** All identity codes a product owns: its identifier fields + every alias clean/normalized code. */
function productIdentityCodes(p: Product, aliases: Alias[]): string[] {
  const own = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].filter(Boolean) as string[];
  const aliasCodes = aliases.filter((a) => a.productId === p.id).flatMap((a) => [a.cleanCode, a.normalizedCode].filter(Boolean) as string[]);
  return [...new Set([...own, ...aliasCodes])];
}

// Known non-matching / poison codes that must never re-trust. 745125495781 is "not a valid UPC" at go-upc
// (which returns a DIFFERENT EAN 7451254957818 = Manstel rivet kit); the codes do not match.
const POISON_CODES = new Set(["745125495781"]);

/**
 * Shared delete engine for deleteProduct + purgePoisonedProducts. Archives each product (status archived +
 * verified false), deactivates ALL its aliases, removes its count rows, detaches its scan-feed rows, and
 * drops catalog/shop-override entries keyed to its codes. Snapshots everything BEFORE mutating for an exact
 * Undo. Idempotent (unknown/already-archived ids are skipped) and audited.
 */
function deleteProductsInternal(
  get: () => ScanState,
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void,
  now: () => string,
  idFactory: () => string,
  productIds: string[],
  auditAction: string,
): { backup: ProductDeleteBackup | null } {
  const state = get();
  const targetIds = new Set(productIds.filter((id) => state.products.some((p) => p.id === id)));
  if (targetIds.size === 0) return { backup: null };

  const targetProducts = state.products.filter((p) => targetIds.has(p.id));
  const codes = new Set(targetProducts.flatMap((p) => productIdentityCodes(p, state.aliases)));
  const targetAliases = state.aliases.filter((a) => targetIds.has(a.productId));
  const targetCounts = state.finalCounts.filter((c) => targetIds.has(c.productId));
  const targetCatalog = state.catalog.filter((c) => codes.has(c.normalizedBarcode) || codes.has(c.barcode));
  const targetOverrides = state.shopOverrides.filter((o) => codes.has(o.normalizedBarcode));
  const touchedFeed = state.scanFeed.filter((e) => e.matchedProductId !== null && targetIds.has(e.matchedProductId));

  // TOP-LEVEL LAW (feed-124/counts-122 root cause, fixed 2026-07-22): deleting a product must never
  // make counted quantity vanish - the physical items were scanned and are still on the shelf; only
  // the identity is being discarded. For every deleted product that carries counted quantity, mint an
  // "Unidentified item" provisional (same shape as ensureProvisionalCount's) and REPOINT the count
  // rows onto it (ids/sessionIds/scanEventIds untouched, so undo's upsert-by-id restores them
  // exactly and the ledger replay stays reproducible). Feed rows repoint to the provisional too.
  const provisionalByProduct = new Map<string, Product>();
  for (const p of targetProducts) {
    const qty = targetCounts.filter((c) => c.productId === p.id).reduce((s, c) => s + c.quantity, 0);
    if (qty <= 0) continue; // nothing counted -> nothing to preserve, mint no ghost row
    const code =
      touchedFeed.find((e) => e.matchedProductId === p.id)?.cleanCode ||
      (p.primaryBarcode ?? "").trim() ||
      productIdentityCodes(p, state.aliases)[0] ||
      "";
    const ct = code ? detectCodeType(code) : null;
    const floor = code && ct ? prefixFloorName(code, ct) : null;
    provisionalByProduct.set(p.id, {
      id: `prod-${idFactory()}`, businessId: state.businessId,
      name: code ? provisionalPlaceholderName(code) : "Unidentified item (deleted product)",
      brand: floor?.brand ?? "", category: "", specsShort: "", specsFull: "", primarySku: "",
      primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "",
      productUrl: "", location: "", notes: "", status: "active", source: "ai_gemini", confidence: 0,
      verified: false, provisional: true, provenanceTier: "provisional",
      createdAt: now(), createdBy: "human", updatedAt: now(), updatedBy: "human",
    });
  }
  const mintedProvisionalIds = [...provisionalByProduct.values()].map((p) => p.id);

  // Snapshot the PRE-delete values for an exact Undo (+ for the downloadable JSON backup in the UI).
  const backup: ProductDeleteBackup = {
    products: targetProducts.map((p) => ({ ...p })),
    aliases: targetAliases.map((a) => ({ ...a })),
    counts: targetCounts.map((c) => ({ ...c })),
    catalog: targetCatalog.map((c) => ({ ...c })),
    shopOverrides: targetOverrides.map((o) => ({ ...o })),
    feed: touchedFeed.map((e) => ({ ...e })),
    deletedAt: now(),
    mintedProvisionalIds,
  };

  // SYNC THE REPOINT (reviewed defect 2026-07-22): the transfer above is local-only; without these
  // ops the backend still holds the count row keyed (sessionId, deletedProductId), and the next
  // refreshFromCloud would re-add it ALONGSIDE the repointed provisional row - doubling the
  // quantity (2 became 4). Ship the archived product, the minted provisional, and a zero-out /
  // re-add increment PAIR per transferred count row (net zero per session: quantity is
  // transferred, never created). The synthetic scanEventId only marks the transfer in the remote
  // row's trace; the appliedKeys dedupe makes a re-drained op a safe no-op.
  const bid = state.businessId;
  const syncOps: PendingSyncItem[] = [];
  for (const p of targetProducts) {
    const archived: Product = { ...p, status: "archived", verified: false, updatedBy: "human" };
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: state.sessionId, entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: archived, idempotencyKey: buildIdempotencyKey(bid, state.sessionId, `${p.id}:delete:archive`, "SAVE_PRODUCT"), scanEventId: null }),
    );
  }
  for (const prov of provisionalByProduct.values()) {
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: state.sessionId, entityType: "Product", entityId: prov.id, operation: "SAVE_PRODUCT", payload: prov, idempotencyKey: buildIdempotencyKey(bid, state.sessionId, `${prov.id}:provisional`, "SAVE_PRODUCT"), scanEventId: null }),
    );
  }
  for (const c of targetCounts) {
    if (c.quantity <= 0) continue; // zero rows are dropped locally and carry nothing to transfer
    const prov = provisionalByProduct.get(c.productId);
    const outKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-out`, "INCREMENT_COUNT");
    const outPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: c.productId, scanEventId: `${c.id}:delete-transfer`, quantityDelta: -c.quantity, idempotencyKey: outKey };
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
    );
    if (prov) {
      const inKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-in`, "INCREMENT_COUNT");
      const inPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: prov.id, scanEventId: `${c.id}:delete-transfer`, quantityDelta: c.quantity, idempotencyKey: inKey };
      syncOps.push(
        makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
      );
    }
  }

  set((s) => ({
    // Archive + un-verify so the deterministic resolver/matcher (verified === true only) stops matching it.
    products: [
      ...s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p)),
      ...provisionalByProduct.values(),
    ],
    // Deactivate ALL aliases so an approved alias can no longer resolve the freed code.
    aliases: s.aliases.map((a) => (targetIds.has(a.productId) ? { ...a, approved: false } : a)),
    // Repoint counted rows onto the minted provisional (quantity INVARIANT); drop only zero-qty rows.
    finalCounts: s.finalCounts.flatMap((c) => {
      if (!targetIds.has(c.productId)) return [c];
      const prov = provisionalByProduct.get(c.productId);
      return prov ? [{ ...c, productId: prov.id, updatedAt: now() }] : [];
    }),
    // Drop catalog / shop-override entries keyed to the freed codes so a future scan re-decodes them.
    catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
    shopOverrides: s.shopOverrides.filter((o) => !codes.has(o.normalizedBarcode)),
    // Repoint scan-feed rows at the provisional carrying their quantity (history kept, identity
    // reopened); rows of a zero-count product detach to null exactly as before.
    scanFeed: s.scanFeed.map((e) =>
      e.matchedProductId !== null && targetIds.has(e.matchedProductId)
        ? {
            ...e,
            matchedProductId: provisionalByProduct.get(e.matchedProductId)?.id ?? null,
            status: "needs_review" as const,
            resolverStatus: "needs_review" as const,
          }
        : e,
    ),
    pendingSyncQueue: [...s.pendingSyncQueue, ...syncOps],
    lastProductDeleteBackup: backup,
  }));
  get().syncPending(); // drain the transfer ops now (same pattern as enqueueAndSync)

  for (const p of targetProducts) {
    emitAudit({ entityType: "Product", entityId: p.id, action: auditAction, metadata: { name: p.name, codes: [...codes].join(" | "), aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length } });
  }
  return { backup };
}

// --- App store (persisted) ---------------------------------------------------------------------

// Backend selection: Firebase (cloud/emulator) when NEXT_PUBLIC_FIREBASE_BACKEND=1, else the local mock
// (default + legacy E2E -> existing behavior unchanged). The Firebase target is constructed ONLY in that
// branch, so the mock/test path never initializes Firebase.
const useFirebaseBackend = isCloudBackendEnabled();
const appDeps: ScanStoreDeps = {
  db: useFirebaseBackend
    ? new FirebaseSyncTarget(getDb(), { emulator: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1" })
    : getMockDb(),
  cloudBackend: useFirebaseBackend,
  trustedExactProbeEnabled: useFirebaseBackend,
  loadBusinessData: useFirebaseBackend ? (businessId) => loadBusinessData(getDb(), businessId) : undefined,
  // Cloud audit sink: append-only auditLog. Fire-and-forget; swallows its own errors so a failed audit
  // write can never break a scan/resolution. No-op on the mock/default path (undefined).
  audit: useFirebaseBackend
    ? (event) => {
        try {
          void auditRepository(getDb(), event.businessId)
            .append(toAuditEvent(event, crypto.randomUUID()))
            .catch(() => {});
        } catch {
          // never propagate
        }
      }
    : undefined,
  // Global catalog cloud lookup (Option 1 wiring). Tries each candidate code against the Firestore
  // global catalog; returns the first verified entry, or the first entry of any status, or null.
  // Errors are swallowed here and also in cloudCatalogResolve so a Firestore failure never breaks scanning.
  // READ-ONLY cloud "brain": the global catalog lookup is enabled by full Firebase backend OR by the
  // dedicated NEXT_PUBLIC_CLOUD_CATALOG flag. The latter lets the LOCAL (mock) backend read the cloud
  // 52k catalog for resolution WITHOUT writing any scans to the cloud (scans stay in the local store).
  lookupGlobalCatalog: (useFirebaseBackend || process.env.NEXT_PUBLIC_CLOUD_CATALOG === "1")
    ? async (codes: string[]): Promise<CatalogEntry | null> => {
        const repo = catalogRepository(getDb());
        const retailRepo = catalogRepository(getDb(), "retailCatalogEntries"); // SEPARATE retail catalog (Open Food Facts)
        const nowIso = new Date().toISOString();
        // toStoreEntry: map the minimal db/types.ts CatalogEntry shape -> the full catalogTypes CatalogEntry
        // shape that the store/resolver expects (toMasterAwareStoreEntry, services/catalog/sanitizeCatalog.ts).
        // Phase 5b Task 4 (GC4 boundary): the tire-master hit ALSO passes raw.id / raw.provenanceTier
        // through onto the store entry's optional masterId/masterProvenanceTier fields, so
        // cloudCatalogResolve can build master candidates for the cross-tier conflict check below.
        // Fix (review HIGH, retail provenance): masterId/masterProvenanceTier are tagged ONLY for hits
        // from the TIRE master catalog (the default `repo`, collection catalogEntries) - see
        // toMasterAwareStoreEntry's isMaster param. The retail catalog (`retailRepo`, Open Food Facts)
        // is a SEPARATE, non-master collection; tagging its hits would run them through the tire-master
        // conflict machinery with a defaulted "corpus_verified" tier they never earned.
        const toStoreEntry = (raw: { id: string; normalizedBarcode: string; name?: string; brand?: string; category?: string; verificationStatus?: string; provenanceTier?: ProvenanceTier }, isMaster = false) =>
          toMasterAwareStoreEntry(raw, isMaster, nowIso);
        let firstAny: CatalogEntry | null = null;
        for (const code of codes) {
          try {
            const raw = await repo.getByBarcode(code);
            if (raw) {
              const entry = toStoreEntry(raw, true);
              if (entry.verificationStatus === "verified") return entry;
              if (!firstAny) firstAny = entry;
            }
          } catch {
            // swallow per-code errors; try the next candidate
          }
          try {
            // RETAIL catalog (Open Food Facts) - a hit IS the product identity, so resolve it as Known
            // (mirrors the tire catalog behavior). Separate collection; never mixed with tires. NOT the
            // master catalog - never tagged with masterId/masterProvenanceTier (see toStoreEntry above).
            const rraw = await retailRepo.getByBarcode(code);
            if (rraw) return toStoreEntry({ ...rraw, verificationStatus: "verified" }, false);
          } catch {
            // swallow per-code errors; try the next candidate
          }
        }
        return firstAny;
      }
    : undefined,
  idFactory: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  persistName: "sis-scan-v1",
};

// v3 hotfix: earlier versions could persist AI-auto-accepted (poisoned) products/aliases.
// We cannot reliably tell poisoned from good learned data, so reset products/aliases to clean
// verified seed and clear session/queues. User settings are preserved (merged with new
// defaults). Use the in-app "Clear local cache" button for a full wipe including the mock DB.
// v4 (Sec-4): the customer-data wipe of any legacy sensitive localStorage keys (aliases/catalog/
// raw codes) is enforced by the role-aware `partialize` below on the first post-hydration write
// (which defaults to the customer-safe shape until the user is proven to be the platformOwner).
// v5: auto-purge the poisoned duplicates (e.g. the ~235 "Manstel rivet kit" rows saved on the
// non-matching code 745125495781) by resetting products/aliases to clean verified seed on next load.
// v6 (Task 4 backfill): THIS APP HAS NO SERVER-SIDE PRODUCT JSON/DB IN LOCAL/MOCK MODE - products
// live ONLY in this persisted browser state, so the "backfill" for real users runs here, at next
// load, instead of a script touching a file. Unlike v3/v5, a version-5 install is NOT reset (its
// products are real, not poisoned) - existing rows are kept and simply gain structured fields via
// the same skip-human-stamped rule as scripts/polish-backfill.mts (see backfillProducts.ts, shared
// by both). Only installs older than v5 still get the full poison-cleanup reset (unchanged), with
// structuring applied to the resulting seed as a no-op convenience.
//
// v7 (Task 3.5): adds `countSnapshots` (rolling variance/shrinkage-report history, capped at 12 by
// snapshotCount). No prior version persisted this field, so every install - reset (<5) or additive
// (>=5) - simply needs it defaulted to []. An install that already has a countSnapshots array (e.g.
// a fresh v7 write, or a future migrate step run twice) keeps it untouched: never clobber real data.
//
// v9 (Phase 4 Task 10): adds `UnknownCodeReview.importQuantity` (optional). No migrate transform is
// needed - the field is undefined-safe on every existing persisted review, and the v8 rule (never
// inject an absent needsReviewQueue/products/etc. key into a partial blob) already holds unchanged.
//
// TOP-LEVEL LAW guard, LAYER A (persist-corruption defect, 2026-08-13): a wrong-SHAPE (but still
// parseable) persisted value - e.g. `products: "not-an-array"` written by a corrupted IndexedDB/
// localStorage record - previously flowed straight through zustand's persist rehydrate into the live
// store whenever the persisted `version` matched the CURRENT persist version (14): zustand only calls
// `migrate` when the stored version DIFFERS from `version` (node_modules/zustand/esm/middleware.mjs),
// but its `merge` step runs UNCONDITIONALLY on every hydrate (migrated or not). A bare-string
// `products` then reached `collectAllIdentifierHits` (aliasMatcher.ts), whose `products.filter(...)`
// threw, and that throw propagated out of `processScan` - silently dropping the scan (feed "0 scans",
// count 0), a direct TOP-LEVEL LAW violation.
//
// This is the single shared sanitizer for every field whose LIVE-CODE dereferences would throw on a
// wrong shape: it is wired into the persist `merge` option below (which runs on EVERY hydrate,
// migrated or not - so it closes exactly the version-matches-current gap that `migrate` cannot see)
// and is also reused, defensively, at the top of `processScan` (LAYER B). A field of the wrong shape
// is coerced to a safe default with a loud `console.warn` (never silently dropped) rather than left
// to poison every downstream `.filter`/`.map`/`.find`/property-read call across the store and
// services layer.
//
// THIRD-REVIEW HARDENING (2026-08-16): an independent clean-room review found the guard above only
// closed ONE variant of the root cause - "shape validation that only checks the top level" - and
// missed two siblings:
//   (a) OBJECT-shaped fields (e.g. `settings: null`) were never checked at all, so
//       `get().settings.scanContext` at processScan's identity-conflict check threw BEFORE
//       ensureProvisionalCount ever ran, silently dropping the scan a second way.
//   (b) A field that IS a valid array can still carry MALFORMED MEMBERS (`[null]`, `["x"]`) that the
//       old top-level-only `Array.isArray` check waved through; a `null`/non-object member then threw
//       on the very first `.status`/`.provisional`/`.primaryBarcode` read (scanStore.ts ~3272-3283,
//       ~3474-3484, ~3546-3548, ~3620-3622) - none of which sit inside the old resolveScan try/catch.
// This table now validates BOTH the container shape and (for array fields) every member's shape, so
// the class - not just the reported instance - is closed. Fields are still opt-in-by-name on purpose:
// an unknown/future persisted field just passes through untouched, exactly like before.
// FINDING 2 HARDENING (Codex clean-room review, 2026-08-16, CRITICAL): the guard above validated the
// container shape and each MEMBER's shape (is it a plain object?), but never the shape of a member's
// own NESTED array fields. A `finalCounts` member that IS a well-formed plain object can still carry
// `scanEventIds: null` (or `aliasesSeen`/`appliedIdempotencyKeys`) - `applyScanEventOnce`
// (services/inventory.ts) then calls `count.scanEventIds.includes(...)` and throws. That throw landed
// INSIDE the Layer C try, so it was caught - but the catch's `ensureProvisionalCount` fallback then
// found this SAME corrupted-but-present count already registered for the code and treated that as
// proof the physical scan had already landed, silently no-op'ing (see the `verifyEventId` fix on
// `ensureProvisionalCount` below for the second half of the closure). `nestedArrayFields` lets a field
// declare which of its members' OWN array properties must also be array-shaped; a corrupted one is
// normalized to [] (never dropped - the surrounding count/event is real data, only the busted nested
// list is unsafe to keep) so the ledger self-heals before any live-code dereference can throw.
type PersistedFieldShape =
  | { kind: "array-of-objects"; default: unknown[]; nestedArrayFields?: string[] }
  | { kind: "array-of-strings"; default: string[] }
  | { kind: "object"; default: object }
  | { kind: "nullable-object"; default: null };

const PERSISTED_FIELD_SHAPES: Record<string, PersistedFieldShape> = {
  products: { kind: "array-of-objects", default: [], nestedArrayFields: ["vendorCodes", "aliases"] },
  aliases: { kind: "array-of-objects", default: [] },
  scanFeed: { kind: "array-of-objects", default: [], nestedArrayFields: ["normalizedCandidates"] },
  // The count ledger's own dedupe/audit trails - the exact fields Finding 2 found silently corrupted.
  finalCounts: {
    kind: "array-of-objects",
    default: [],
    nestedArrayFields: ["scanEventIds", "aliasesSeen", "appliedIdempotencyKeys"],
  },
  needsReviewQueue: {
    kind: "array-of-objects",
    default: [],
    nestedArrayFields: ["normalizedCandidates", "suggestedAliases", "sourceUrls", "verifiedFacts", "guesses"],
  },
  pendingSyncQueue: { kind: "array-of-objects", default: [] },
  catalog: { kind: "array-of-objects", default: [] },
  shopOverrides: { kind: "array-of-objects", default: [] },
  feedbackEvents: { kind: "array-of-objects", default: [] },
  countSnapshots: { kind: "array-of-objects", default: [] },
  sessionHistory: { kind: "array-of-objects", default: [] },
  syncedScanEventIds: { kind: "array-of-strings", default: [] },
  recentLocations: { kind: "array-of-strings", default: [] },
  // settings is dereferenced unguarded (`get().settings.scanContext`, `.aiLookupEnabled`, etc.) all
  // over processScan and elsewhere - a wrong-shape value must never reach the live store.
  settings: { kind: "object", default: DEFAULT_SETTINGS },
  // currentSession / lastCleanupBackup are legitimately nullable (`InventorySession | null`,
  // `CleanupBackup | null`); most reads already use `?.`, but a non-null WRONG-shape value (a string,
  // a number, an array) is still coerced back to the one value every read site treats as "absent".
  currentSession: { kind: "nullable-object", default: null },
  lastCleanupBackup: { kind: "nullable-object", default: null },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported for direct unit testing (scanStore.persistShapeGuard.test.ts) and reused by the persist
 *  `merge` option. Pure, never throws: a non-object input becomes `{}`. Only touches keys that are
 *  actually present on the input (never injects a key a partial blob didn't carry - required by the
 *  v5..v9 migrate contract documented above: an absent key must stay absent, not become an injected
 *  empty default that clobbers a real value merged in from elsewhere). */
export function sanitizePersistedScanShape(persisted: unknown): Record<string, unknown> {
  if (persisted === null || typeof persisted !== "object") return {};
  const out: Record<string, unknown> = { ...(persisted as Record<string, unknown>) };

  for (const [field, shape] of Object.entries(PERSISTED_FIELD_SHAPES)) {
    const value = out[field];
    if (value === undefined) continue; // never inject a key the input didn't carry

    if (shape.kind === "array-of-objects" || shape.kind === "array-of-strings") {
      if (!Array.isArray(value)) {
        console.warn(
          `[scanStore] Persisted '${field}' had the wrong shape (expected an array, got ${typeof value}); ` +
            `resetting it to [] so hydration cannot brick the store or drop a scan. (TOP-LEVEL LAW guard)`,
          value,
        );
        out[field] = [];
        continue;
      }
      const isUsableMember = shape.kind === "array-of-objects" ? isPlainObject : (m: unknown) => typeof m === "string";
      const droppedCount = value.reduce((n, m) => (isUsableMember(m) ? n : n + 1), 0);
      let nextArray: unknown[] = value;
      if (droppedCount > 0) {
        console.warn(
          `[scanStore] Persisted '${field}' contained ${droppedCount} malformed ` +
            `${droppedCount === 1 ? "entry" : "entries"} (expected ` +
            `${shape.kind === "array-of-objects" ? "objects" : "strings"}); dropping ` +
            `${droppedCount === 1 ? "it" : "them"} so a corrupt member cannot brick the store or drop a scan. ` +
            `(TOP-LEVEL LAW guard)`,
          value,
        );
        nextArray = value.filter(isUsableMember);
      }
      // FINDING 2: nested array-shaped fields inside an otherwise well-formed member (e.g.
      // finalCounts[i].scanEventIds: null) - normalize IN PLACE (never drop the whole member; the
      // surrounding count/event is real data) so a downstream `.includes(...)`/`.map(...)` on that
      // nested field can never throw and silently take the scan-drop path.
      if (shape.kind === "array-of-objects" && shape.nestedArrayFields && shape.nestedArrayFields.length > 0) {
        let nestedFixed = 0;
        const mappedArray = nextArray.map((member) => {
          if (!isPlainObject(member)) return member;
          let patched: Record<string, unknown> | null = null;
          for (const nestedField of shape.nestedArrayFields!) {
            const nestedValue = member[nestedField];
            if (nestedValue !== undefined && !Array.isArray(nestedValue)) {
              patched = patched ?? { ...member };
              patched[nestedField] = [];
              nestedFixed++;
            }
          }
          return patched ?? member;
        });
        if (nestedFixed > 0) {
          nextArray = mappedArray;
          console.warn(
            `[scanStore] Persisted '${field}' contained ${nestedFixed} malformed nested array ` +
              `field(s) (e.g. scanEventIds/aliasesSeen expected to be arrays); normalizing ` +
              `${nestedFixed === 1 ? "it" : "them"} to [] so a corrupted ledger entry cannot brick the ` +
              `store or drop a scan. (TOP-LEVEL LAW guard)`,
            value,
          );
        }
      }
      if (nextArray !== value) out[field] = nextArray;
      continue;
    }

    if (shape.kind === "object") {
      if (!isPlainObject(value)) {
        console.warn(
          `[scanStore] Persisted '${field}' had the wrong shape (expected an object, got ` +
            `${Array.isArray(value) ? "array" : typeof value}); resetting it to defaults so hydration cannot ` +
            `brick the store or drop a scan. (TOP-LEVEL LAW guard)`,
          value,
        );
        out[field] = { ...shape.default };
      }
      continue;
    }

    // nullable-object: null is the valid "absent" value; anything else must be an object.
    if (value !== null && !isPlainObject(value)) {
      console.warn(
        `[scanStore] Persisted '${field}' had the wrong shape (expected an object or null, got ` +
          `${Array.isArray(value) ? "array" : typeof value}); resetting it to null so hydration cannot brick ` +
          `the store or drop a scan. (TOP-LEVEL LAW guard)`,
        value,
      );
      out[field] = null;
    }
  }
  return out;
}

// Exported (Task 4 polish-review fix) so a unit test can call this directly with a v5 persisted-state
// fixture and assert every field survives the migration untouched, without spinning up the full
// zustand persist/localStorage machinery.
export function scanStoreMigrate(persisted: unknown, version: number) {
  const p = (persisted ?? {}) as Record<string, unknown>;
  const existingSnapshots = Array.isArray(p.countSnapshots) ? p.countSnapshots : [];
  // v14 (owner feature, 2026-07-22): adds `sessionHistory` (automatically saved past-session log,
  // capped ring buffer - see sessionHistory.ts). Same unconditional-inject contract as countSnapshots:
  // no prior version persisted this field, so every install defaults it to [] and an install that
  // already has one (e.g. a fresh v14 write) keeps its real data untouched.
  const existingSessionHistory = Array.isArray(p.sessionHistory) ? p.sessionHistory : [];
  if (version < 5) {
    const fresh = getSeed();
    return {
      ...p,
      products: backfillProducts(fresh.products).products,
      aliases: fresh.aliases,
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      countSnapshots: existingSnapshots,
      sessionHistory: existingSessionHistory,
      settings: { ...DEFAULT_SETTINGS, ...((p.settings as Partial<Settings>) ?? {}) },
    } as never;
  }
  // Non-destructive branch (v5..v9 -> v10): transform ONLY keys the persisted blob actually carries.
  // A PARTIAL blob (e.g. the e2e fixture's settings-only seed) must not gain products/scanFeed/
  // countSnapshots/settings/needsReviewQueue keys here - injected empties clobber the seeded initial
  // state when zustand merges the migrated blob over it. Live-caught P2 regression: the v7->v8 bump made
  // this branch run on the settings-only e2e blob for the first time, products became [] while aliases
  // survived, so known scans counted but the count table lost every product row ("No counts yet"). The
  // v8->v9 bump (Phase 4 Task 10, UnknownCodeReview.importQuantity) does not need its own key transform -
  // an absent field on old persisted reviews just stays absent (optional, undefined-safe) - so this
  // branch's existing non-injective shape already satisfies the v9 rule unchanged. The v9->v10 bump
  // (Task 2, owner-reported live bug, 2026-07-20) reuses this SAME `backfillProducts` call below - it
  // now also runs the enrichProductIdentity fill-if-empty pass (see backfillProducts.ts), so a legacy
  // row's blank brand/category/specsShort/specsFull gets filled from its parseable name, exactly once.
  const out: Record<string, unknown> = { ...p };
  if (Array.isArray(p.products)) {
    out.products = backfillProducts(p.products as Product[]).products;
  }
  if (Array.isArray(p.scanFeed)) {
    // P1-handoff fold-in: legacy v7 feed rows may carry a literal quantityDelta:0 (pre-D1).
    // applyScanEventOnce's `?? 1` does not correct a non-nullish 0, so normalize here where the
    // persisted blob is rebuilt.
    out.scanFeed = (p.scanFeed as Array<{ quantityDelta?: number }>).map((row) =>
      row && row.quantityDelta === 0 ? { ...row, quantityDelta: 1 } : row,
    );
  }
  // countSnapshots stays UNCONDITIONAL by documented contract (varianceSnapshot.store.test.ts: pre-
  // snapshot blobs migrate to []). Safe to inject: the initial state is empty too, unlike products.
  out.countSnapshots = existingSnapshots;
  // sessionHistory: same unconditional-inject contract as countSnapshots (see v14 note above).
  out.sessionHistory = existingSessionHistory;
  if (p.settings !== undefined) {
    out.settings = { ...DEFAULT_SETTINGS, ...(p.settings as Partial<Settings>) };
  }
  // v13 self-heal ("if it is resolved, it does not go to review"): an install that hit the old bug
  // (resolveUnknown silently no-op'd on a genuinely settled decode - the fuzzy identity-merge
  // suggest_link path or a dedup conflict - leaving the review "open"/"suggested" forever) gets a
  // one-time stamp here. "Identity already settled" reuses the EXACT two feed-status signals the app
  // itself already treats as settled elsewhere in this file: a scanFeed row for the same cleanCode with
  // status "resolved" (the resolveUnknown relink write, ~scanStore.ts:4738-4743 - implies a real
  // matchedProductId was assigned) or decodeStatus "verified" (markFeedRowVerified, only ever written
  // after resolveUnknown actually resolved the review - see the "never leave a 'Verified AI Decode +
  // Unknown' feed row" guard at ~scanStore.ts:3401-3408). Only needsReviewQueue rows are mutated here;
  // scanFeed and finalCounts are read-only inputs and are never touched by this step. Never injects an
  // absent needsReviewQueue key into a partial blob (same v8 rule as the rest of this branch).
  if (Array.isArray(p.needsReviewQueue)) {
    const feed = Array.isArray(p.scanFeed) ? (p.scanFeed as Array<{ cleanCode?: string; status?: string; decodeStatus?: string }>) : [];
    const settledCleanCodes = new Set(
      feed
        .filter((e) => e && (e.status === "resolved" || e.decodeStatus === "verified"))
        .map((e) => e.cleanCode)
        .filter((c): c is string => Boolean(c)),
    );
    out.needsReviewQueue = (p.needsReviewQueue as Array<{ cleanCode?: string; status?: string }>).map((r) =>
      r && (r.status === "open" || r.status === "suggested") && r.cleanCode && settledCleanCodes.has(r.cleanCode)
        ? { ...r, status: "resolved" as const, resolvedAt: new Date().toISOString(), resolvedBy: "auto", resolutionAction: "create_new" as const }
        : r,
    );
  }
  return out as never;
}

// F-4 fix (resurrection leak, 2026-08-09): named module-level instance (was an inline IIFE passed
// straight to `storage:` below, unreachable from anywhere else) so the direct legacy/per-uid key
// deleters in resetForSignOut and clearLocalCache can route through THIS wrapper's own removeItem -
// the only thing that cancels a pending coalesced write for that key (see scanPersistStorage.ts
// removeItem: it clears pendingName/pendingValue AND cancels any in-flight IDB migration copy before
// deleting from backing). Deleting the legacy/localStorage key directly (removePersistedKeyEverywhere
// alone) does not touch this wrapper's pending-write queue, so a write already coalesced for that key
// before the deletion could still land AFTER it, resurrecting a supposedly-deleted blob - on a shared
// device that resurrected sis-scan-v1 is the PREVIOUS user's inventory, offered to the NEXT user via
// the adopt banner (cross-account disclosure).
const scanPersistBackingStorage = (() => {
  const idb = typeof indexedDB !== "undefined" ? createIdbBacking() : null;
  return idb
    ? createAsyncCoalescedFailSoftPersistStorage(() => idb, {
        migrateFrom: typeof localStorage !== "undefined" ? localStorage : undefined,
        // Task 2 (persist-failure surface, 2026-08-09): this hook previously had no listener anywhere
        // (a fail-soft write/migrate/demotion failure was logged via console.warn inside
        // scanPersistStorage.ts and otherwise invisible). `useScanStore` is referenced here inside a
        // closure, not at module-eval time - by the time IndexedDB can actually fail and call this back,
        // module evaluation has long finished and `useScanStore` below is defined, so this is safe.
        // Guarded because a persist failure must never itself throw (it already fails soft upstream).
        onPersistFailure: (kind) => {
          try {
            useScanStore.getState().setPersistDegraded(kind);
          } catch {
            // never let a persist-failure listener throw
          }
        },
      })
    : createCoalescedFailSoftPersistStorage(() => localStorage);
})();

/**
 * Sweep the EMPTY legacy-key residue a per-uid session leaves behind (root-caused 2026-08-09 from the
 * adopt emulator spot-check: after adoption + reload an empty "sis-scan-v1" (+ its "::stamp" sibling)
 * reappeared in IndexedDB).
 *
 * WHY IT APPEARS - entirely product code, no test artifact: `StoreHydrator` calls
 * `useScanStore.persist.rehydrate()` on every page load, while the persist name is still the DEFAULT
 * legacy key (the uid is only known after the async auth bootstrap in BusinessContextGate). Zustand's
 * hydrate ends by invoking `onRehydrateStorage`'s callback -> `setHasHydrated(true)` -> a store `set()`
 * -> the persist middleware's `setItem()` on the CURRENT name. So the initial (empty) state is written
 * straight back to "sis-scan-v1", into whichever backing is primary (IndexedDB since #27, which is why
 * localStorage stayed clean in the proof). Harmless on its own - `legacyBlobIsMeaningful` correctly
 * ignores it, so no adopt banner - but it is a stray per-device trace of a signed-in session sitting in
 * the SHARED (non-namespaced) key, and it makes "is the legacy key gone?" un-assertable after adoption.
 *
 * The fix is a sweep, not a delete-on-sight: only a blob with NO scans, counts, or reviews is removed -
 * exactly the `hasMeaningfulLegacyBlobAsync` predicate the adopt banner itself uses. A real pre-account
 * blob (adoptable, or deliberately kept by "Start fresh (leave it)") is never touched. Routed through
 * the wrapper's own removeItem FIRST so a coalesced write still pending for that key is cancelled
 * rather than left to land afterwards (the F-4 resurrection rule). Never throws.
 */
async function sweepEmptyLegacyResidue(): Promise<void> {
  try {
    if (await hasMeaningfulLegacyBlobAsync()) return; // real adoptable data: leave it exactly as-is
    scanPersistBackingStorage.removeItem(LEGACY_PERSIST_KEY);
    removePersistedKeyEverywhere(LEGACY_PERSIST_KEY); // blob + its "::stamp" sibling, both backings
  } catch {
    // Storage cleanup is best-effort: it must never break sign-in hydration.
  }
}

export const useScanStore = create<ScanState>()(
  persist(buildScanInitializer(appDeps), {
    name: "sis-scan-v1",
    // Task 2 (owner-reported live bug, 2026-07-20): v9 -> v10 bump so every existing install runs
    // the identity-field backfill (enrichProductIdentity fill-if-empty, see backfillProducts.ts)
    // exactly once on next load - a legacy row's blank brand/category/specsShort/specsFull gets
    // filled from its parseable name via the same non-destructive >= 5 migrate branch below.
    // Group C item 11 (owner mandate 2026-07-21): v10 -> v11 bump so every existing install also
    // re-cleans a legacy JUNKY product name into the app's own canonical display form exactly once
    // (see scanStoreMigrate's v11 name re-clean step below).
    // Bug 4 fix (owner mandate 2026-07-21, 310-row review): v11 -> v12 bump so every existing install
    // ALSO re-runs backfillProducts once more to dedupe a brand-duplicated name that an earlier
    // enrichment/backfill pass baked in before canonicalTireDisplayName/enrichProductIdentity learned
    // to collapse duplicate brand-token runs (e.g. "Greenball Greenball Greenball Tow-Master"). The
    // >= 5 migrate branch below already calls backfillProducts unconditionally on every hydrate whose
    // persisted version is below `version`, so this bump alone is sufficient - no separate v12 step
    // needed (backfillProducts itself now dedupes via the fixed canonicalTireDisplayName).
    // "Resolved never lingers in review" fix: v12 -> v13 bump so an install stuck with the old bug
    // (resolveUnknown silently no-op'd on a genuinely settled decode, leaving the review "open"/
    // "suggested" forever) gets a one-time self-heal on next load - see scanStoreMigrate's v13 step.
    // Owner feature (2026-07-22): v13 -> v14 bump so every existing install gains `sessionHistory`
    // defaulted to [] (see scanStoreMigrate's v14 note above).
    version: 14,
    // Finding #16 (critical) CONTAINED MITIGATION: the persist store previously used a plain
    // createJSONStorage(() => localStorage) with NO quota guard, so near the ~5MB quota setItem threw
    // synchronously out of set() inside processScan and bricked the /scan page (fresh tab still broken
    // until localStorage was cleared). This wrapper fails SOFT (never throws out of a scan) and COALESCES
    // the ~6 writes/scan into one per tick (flushed on pagehide/visibilitychange so nothing is lost).
    // Defect #37 layer 3 (fresh-device restore freeze, 2026-08-06): a plain `createJSONStorage(...)`
    // wrapper still runs JSON.stringify of the FULL state synchronously on every single set() call,
    // before this coalescing even sees it (zustand's persist middleware calls storage.setItem from every
    // state change - see scanPersistStorage.ts header). createCoalescedFailSoftPersistStorage implements
    // PersistStorage<S> directly so the stringify itself, not just the disk write, is coalesced to at
    // most one per tick. See scanPersistStorage.ts. IndexedDB migration remains the recommended
    // architectural follow-up.
    // #27: IndexedDB is the primary persist backing (localStorage's ~5MB quota bricked large real-
    // backend sessions ~500 scans in). Feature-detected once at store creation: no indexedDB (SSR,
    // jsdom, lockdown) -> the previous localStorage path, byte-for-byte identical behavior. When IDB
    // is active, migrateFrom copies a legacy localStorage blob forward on first read (copy-then-clear).
    storage: scanPersistBackingStorage,
    skipHydration: true,
    migrate: scanStoreMigrate,
    // LAYER A (persist-corruption defect, 2026-08-13): zustand's `merge` runs on EVERY hydrate,
    // whether or not `migrate` ran (migrate is skipped entirely when the stored version already
    // equals `version` above - exactly the case a wrong-SHAPE-but-current-version blob hits). Route
    // the migrated/raw persisted state through sanitizePersistedScanShape here so a non-array
    // collection field can never reach the live store, regardless of which hydrate path it took.
    merge: (persistedState, currentState) => ({
      ...currentState,
      ...sanitizePersistedScanShape(persistedState),
    }),
    // Sec-4: split persisted state by access level. A customer browser must NEVER persist the reusable
    // code database (aliases / global catalog / shop overrides / barcodes / raw+clean+normalized codes /
    // decode traces). The level is computed from the signed-in uid (same source of truth as the UI), and
    // defaults to "business" when the user is unknown - so a customer's post-hydration write also WIPES
    // any sensitive keys an older build left in this browser's localStorage. This governs ONLY what is
    // written to disk; the in-memory store keeps the full data it needs to render/resolve in-session
    // (seed in mock, the loader in cloud), so resolution is unaffected.
    partialize: (s) => buildPersistedScanState(s as unknown as PersistableScanState),
    onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
  }),
);

// TEST/DEV ONLY (never production): expose the in-memory store so the local Playwright scan-matrix proof
// harness can read the FULL unsanitized state (products with verified/provisional, aliases, catalog) that
// the role-aware localStorage persist deliberately strips for customer browsers. Inert in prod builds.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __scanStore?: typeof useScanStore }).__scanStore = useScanStore;
}

/** Factory for tests: a fresh, non-persisted store with injectable deps. */
export function createTestScanStore(overrides?: Partial<ScanStoreDeps>) {
  let n = 0;
  const deps: ScanStoreDeps = {
    db: overrides?.db ?? new MockDb(),
    idFactory: overrides?.idFactory ?? (() => `id-${++n}`),
    now: overrides?.now ?? (() => "2026-06-12T10:00:00.000Z"),
    persistName: null,
    cloudBackend: overrides?.cloudBackend ?? false,
    trustedExactProbeEnabled: overrides?.trustedExactProbeEnabled,
    loadBusinessData: overrides?.loadBusinessData,
    audit: overrides?.audit,
    lookupGlobalCatalog: overrides?.lookupGlobalCatalog,
  };
  const store = create<ScanState>()(buildScanInitializer(deps));
  // Test convenience: generic store tests use non-tire seed fixtures (e.g. Coca-Cola) as stand-ins for
  // ANY product, so the test store defaults to "any" context. The PRODUCTION default is "tire"
  // (DEFAULT_SETTINGS); firewall tests opt in via updateSettings({ scanContext: "tire" }).
  store.getState().updateSettings({ scanContext: "any" });
  return store;
}

/** TEST ONLY: the general decode queue's bulk pacer (`GENERAL_DECODE_RATE_PER_SEC` token bucket) is a
 *  module-level singleton shared by every store instance (mirrors `decodeTaskPromises`/the queues
 *  themselves), so a fake-timer pacing test needs a deterministic starting point instead of inheriting
 *  leftover tokens/timers from whatever ran earlier in the same test file. Never used outside tests. */
export function __resetGeneralDecodePacerForTest(nowMs: number = Date.now()): void {
  if (generalDecodeQueue.pacer) resetTokenBucket(generalDecodeQueue.pacer, nowMs);
}

/** TEST ONLY: the mirror of `__resetGeneralDecodePacerForTest` - empties the bulk pacer's token bucket
 *  so the very next `liveDecode` is genuinely QUEUED (waiting on refill) instead of dispatching
 *  synchronously out of the burst allowance. Lets a test exercise the bulk-session path (in-flight
 *  dedupe of two calls for the same review while the first is still queued) without pasting 1000 codes
 *  first. Never used outside tests. */
export function __drainGeneralDecodePacerForTest(nowMs: number = Date.now()): void {
  const pacer = generalDecodeQueue.pacer;
  if (!pacer) return;
  pacer.tokens = 0;
  pacer.lastRefillAt = nowMs;
}
