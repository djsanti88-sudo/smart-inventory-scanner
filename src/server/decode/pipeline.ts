import "server-only";
import type { AiLookupResult, EvidenceResult, DecodeDecision } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { type ProviderStatus } from "@/services/ai/decodeOrchestrator";
import { decideDecode, isUsableProductName, isExampleOrTestRow } from "@/services/ai/decode";
import { firecrawlScrapeCheap, searchIdentifyByBarcode, firecrawlKeysFromEnv } from "@/services/ai/firecrawlProvider";
import { lookupBarcodeDb } from "@/server/retail-knowledge/barcodeDbProvider";
import { groundIdentify, getLastGroundingStatus } from "@/services/ai/flashLiteGrounding";
import { verifyCodeOnPage } from "@/services/ai/verifyCodeOnPage";
import { resolveUnknownFast } from "@/services/ai/parallelResolve";
import { prefixFloorName } from "@/services/catalog/prefixFloor";
import { decodeReasonCode, REASON_TEXT, sanitizeCustomerReason } from "@/services/ai/decodeFallback";
import { withDecodeCache, getDecodeCache } from "@/services/ai/decodeCache";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { isLikelyMisreadGtin } from "@/services/upc/misread";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { lookupPrefix, candidateKnownPrefixes } from "@/services/catalog/prefixIndex";
import { evaluatePrefixFirewall } from "@/services/catalog/prefixFirewall";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { readDailyUsed, chargeDailySlot, intEnv, checkGptLadderBudget, recordGptLadderSpend, recordGptLadderCall } from "@/services/security/aiSpendGuard";
import { gptFromScratch, type GptFromScratchResult, GPT_LADDER_WORST_CASE_USD } from "@/services/ai/gptFromScratch";
import { shouldRunGptRung, gptResultToDecodePayload } from "@/services/ai/gptLadderRung";
import { getPersistedDecode, persistDecode, type PersistedDecode } from "@/server/decodeCacheStore";
import { goUpcUsage } from "@/server/upc/goUpcUsage";
import { ladderStorage } from "@/server/upc/storage";
import { goUpcRung, makeDefaultPrefixLookup } from "@/server/upc/GoUpcProvider";
import { goUpcLookup } from "@/services/upc/goUpcClient";
import { GoUpcGate } from "@/services/upc/goUpcThrottle";
import { upcItemDbUsage } from "@/server/upc/upcItemDbUsage";
import { upcItemDbRung } from "@/server/upc/UpcItemDbProvider";
import { upcItemDbLookup } from "@/services/upc/upcItemDbClient";
import { openFoodFactsUsage } from "@/server/upc/openFoodFactsUsage";
import { openFoodFactsRung } from "@/server/upc/OpenFoodFactsProvider";
import { openFoodFactsLookup } from "@/services/upc/openFoodFactsClient";
import tirePrefixMap from "@/services/catalog/tirePrefixMap.generated.json";
import { fetchV2, type FetchV2Deps, type FetchedPage } from "@/services/fetchV2/index";
import { FetchV2Cache } from "@/services/fetchV2/cache";
import { braveProvider, firecrawlSearchProvider, type DiscoveryProvider, type MinimalFetch } from "@/services/fetchV2/sources/discovery";
import { brocadeLookup } from "@/services/fetchV2/sources/brocade";
import { selectBarcodeUrls } from "@/services/ai/barcodeSources";
import { isSafePublicUrl } from "@/services/ai/urlSafety";
import { runLadder, buildFreeLadderRungs, buildPaidLadderRungs, type RungOutcome, type LadderResult } from "@/server/upc/ladder";
import { canonicalGtin, isGtinShaped } from "@/services/upc/gtin";
import { paidWorkPossible } from "@/server/upc/paidWorkPossible";
import { steerFreeRungs } from "@/server/upc/freeRungSteering";
import { getLearnedProduct, upsertLearnedProduct, shouldLearnDecode, prefixCheckNote, type LearnedProductRow } from "@/server/learnedProducts";
import { crossCheck } from "@/services/ai/crossCheckEngine";

// PURE EXTRACTION (Task 2.4): this module is the decode pipeline lifted verbatim out of
// app/api/ai-lookup/route.ts. Zero behavior change - every domain rule (the daily cap charged only
// inside the paid rungs after the free corpus/cache peek; the corpus -> Go-UPC -> Fetch V2 -> GPT
// ladder order and short-circuit; IS_E2E mock-only; GEMINI_DECODE_DISABLED; honest reasons for
// every non-decode) is preserved exactly as it was in the route. route.ts now parses the request,
// applies the abuse/mock-mode gates, and shapes the response; it delegates the decode work here.

/**
 * Thrown from inside computeDecode() the instant the daily spend cap blocks the PAID ladder (Go-UPC /
 * Fetch V2 / GPT-5.5). Every free stage (L1/L2 cache, tire-corpus, retail-corpus, Plan D's verified win)
 * runs and returns BEFORE this can ever be thrown, so a $0 resolution is never blocked and never sees
 * this. Caught once, right outside the withDecodeCache() call, and turned into the same 429 daily_cap
 * response the route has always returned for a cap-blocked request. Thrown (not returned) because
 * computeDecode's return type is a settled DecodePayload - a distinct "blocked" arm would leak the cap's
 * HTTP-shaped concern into every downstream consumer of that type for no benefit.
 */
export class DailyCapExceededError extends Error {
  constructor(public readonly used: number, public readonly limit: number) {
    super(`Daily AI lookup cap reached (${used}/${limit}). No AI call made.`);
    this.name = "DailyCapExceededError";
  }
}

// OWNER ORDER 2026-07-06 ("remove Gemini for now"): Gemini is OUT of the decode path. Forensics
// proved Gemini 3 grounding bills every executed search query with NO cap control and the queries
// are invisible client-side ($6 real vs $0.53 computed, see LESSONS_LEARNED L11) - the gpt-5.5
// ladder rung (capped, fully meterable) is the only paid decode engine. This gates the Gemini
// fast/escalation providers AND the Plan D flash-lite grounding arm. Flip to false to restore.
const GEMINI_DECODE_DISABLED = true;

// MODULE-LEVEL Go-UPC gate: ONE instance per server process so the 2 req/s throttle + in-flight
// dedup span every request (a per-request gate would let concurrent scans of the same code each
// spend a lookup). Pure + framework-free; safe as a singleton (no env, no fs).
const goUpcGate = new GoUpcGate();
// Prefix owner lookup for the Go-UPC brand firewall: tire prefix map first, then the general derived
// single-brand map (inside makeDefaultPrefixLookup). Absence never blocks a hit.
const goUpcPrefixLookup = makeDefaultPrefixLookup(tirePrefixMap as Record<string, string>);

// Fetch V2 verified-result cache, one per server process (in-memory; a durable layer is a later
// decision). Reused across scans so a repeated code never re-crawls the web within an instance.
const fetchV2Cache = new FetchV2Cache();

const FETCHV2_MAX_SOURCES = Number(process.env.FETCHV2_MAX_SOURCES || 3);
const FETCHV2_MAX_TOTAL_MS = Number(process.env.FETCHV2_MAX_TOTAL_MS || 25_000);
const FETCHV2_PAGE_TIMEOUT_MS = Number(process.env.FETCHV2_PAGE_TIMEOUT_MS || 8_000);

export function e2eMode(): boolean {
  return process.env.IS_E2E === "1";
}

// Task 6: PURE payload assembly for a trusted-corpus exact hit (barcode or SKU-shaped part number),
// lifted VERBATIM out of the former corpus block inside computeDecode so the early corpus peek at the
// top of runDecodePipeline can reuse it. No closure over request-scoped mutable state - the sanitized
// input strings are passed in explicitly. Debug fields are copied unchanged from the original block.
function corpusPayload(
  corpus: import("@/server/tire-knowledge/TireKnowledgeProvider").CorpusDecodeResult,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  return {
    mode: "decode" as const,
    providerNames: corpus.providerNames,
    results: corpus.results,
    evidences: corpus.evidences,
    providerStatuses: [{ provider: "tire-corpus", status: "ok" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: true, identityFound: true }],
    decision: corpus.decision,
    reasonCode: "ok",
    reasonText: "",
    timedOut: false,
    debug: { providersAttempted: corpus.providerNames, evidenceStrengths: corpus.evidences.map((e) => e.strength), sourceCounts: [0], corroborationPath: corpus.path, aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

// Task 21 (owner-ratified 2026-07-15): PURE payload assembly for a learned-products tier hit. Mirrors
// corpusPayload's shape exactly, EXCEPT the decision is HONESTLY built as a SUGGESTION at the row's
// stored confidence - a learned row is server-side decode assistance, never ground truth, and must
// NEVER be reported as "verified" (that stays reserved for the trusted tire/retail corpus and a live
// decode that clears decideDecode's own verify gates). The reason names the learned tier, the original
// source host, and the date it was learned, so the row is always honest about its provenance. A
// >=0.8 confidence learned suggestion flows through the existing client-side auto-apply gate
// (shouldAutoApplySuggestion in scanGates.ts) exactly like any other high-trust suggestion.
function learnedPayload(
  row: LearnedProductRow,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  let host = row.sourceUrl;
  try {
    host = new URL(row.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    /* keep the raw sourceUrl if it somehow fails to parse */
  }
  const learnedDate = (row.createdAt || "").slice(0, 10) || "unknown date";
  const reason = `Suggested from the learned-products tier: learned from ${host} on ${learnedDate}, prefix-corroborated (${row.prefixCheck}). Not re-verified live - approve once to make it permanent.`;
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: row.name,
    brand: row.brand,
    category: row.category,
    specsShort: row.specsShort,
    specsFull: row.specsFull,
    confidence: row.confidence,
    sourceUrls: row.sourceUrl ? [row.sourceUrl] : [],
    needsHumanReview: true,
  };
  const evidence: EvidenceResult = {
    verified: false,
    strength: row.evidenceStrength,
    matchedCode: "",
    matchedSources: row.sourceUrl ? [row.sourceUrl] : [],
    reason: "Learned-tier replay: not independently re-verified this scan.",
  };
  return {
    mode: "decode" as const,
    providerNames: ["learned-products"],
    results: [result],
    evidences: [evidence],
    providerStatuses: [{ provider: "learned-products", status: "ok" as const, latencyMs: 0, sourceUrlsReturned: row.sourceUrl ? 1 : 0, exactCodeFound: false, identityFound: true }],
    decision: {
      status: "suggested",
      confidence: row.confidence,
      reason,
      evidenceStrength: row.evidenceStrength,
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: row.confidence, reason: "Learned-tier replay (single stored source).", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    },
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["learned-products"], evidenceStrengths: [row.evidenceStrength], sourceCounts: [row.sourceUrl ? 1 : 0], corroborationPath: "learned_products", aiCalled: false, pageFetched: false, cached: false, learnedTier: true },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

// RETAIL RUNG-0 FIX (live-proven bug): the 4M-row retail Turso corpus is a FREE local-DB source that
// belongs in rung 0 alongside the tire corpus, not buried as a Plan D consensus VOTE that a lone hit
// could never settle by itself. Root cause of the live regression: (1) a retail-corpus hit alone never
// settled (it needed a SECOND agreeing source inside resolveUnknownFast's cross-check), and (2) the
// Plan D peek only ran for isPublicBarcode (upc_a/ean_13/gtin_14) - an EAN-8 code never even reached
// it. Both gaps let 19/20 retail barcodes that exist in the corpus fall through to a paid Go-UPC call,
// and one (EAN-8 "10000007", corpus name "Saumon fume Ecossais tranche main") settled as a WRONG
// "Verified from Go-UPC" identity (a beer) because nothing cross-checked the paid claim against the
// corpus. This mirrors corpusPayload's shape but reports "suggested" (never "verified" - a single
// retail-DB row is honest grounding, not the app's own independently-verified exact-code evidence the
// tire corpus provides), matching learnedPayload's review-first pattern. A >=0.8 suggestion still
// auto-applies via the existing client-side shouldAutoApplySuggestion gate; this function only ever
// hands back an honest suggestion, never a count decision.
const RETAIL_RUNG_CONFIDENCE = 0.85;
function retailPayload(
  row: { productName: string; brand: string; category: string },
  code: string,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  const reason = "Matched in the retail product database (exact barcode). No AI lookup needed.";
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: row.productName,
    brand: row.brand,
    category: row.category,
    confidence: RETAIL_RUNG_CONFIDENCE,
    needsHumanReview: true,
    sourceUrls: [],
    verifiedFacts: [`Retail product database: exact barcode ${code}`],
  };
  const evidence: EvidenceResult = {
    verified: false,
    strength: "none",
    matchedCode: "",
    matchedSources: [],
    reason: "Retail-corpus replay: a single structured-DB row, not independently re-verified this scan.",
  };
  const decision: DecodeDecision = {
    status: "suggested",
    confidence: RETAIL_RUNG_CONFIDENCE,
    reason,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: RETAIL_RUNG_CONFIDENCE, reason: "Retail-corpus exact barcode (single source).", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
  };
  return {
    mode: "decode" as const,
    providerNames: ["retail-corpus"],
    results: [result],
    evidences: [evidence],
    providerStatuses: [{ provider: "retail-corpus", status: "ok" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: true, identityFound: true }],
    decision,
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["retail-corpus"], evidenceStrengths: ["none"], sourceCounts: [0], corroborationPath: "retail_corpus_exact_barcode", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

// Combined prefix conflict fed to decideDecode: the existing catalog-derived brand sanity OR the new
// evidence-weighted firewall (barcode prefix-owner vs the candidate's manufacturer/category). The
// firewall is OVERRIDE-AWARE - strong app-verified exact-code evidence makes fw.conflict false - so this
// never blocks a legitimately exact-verified decode, only conflicting non-exact verify paths (e.g. the
// internet-two-source-size tire path) and Gemini-style "plausible product, wrong code" hallucinations.
function evalCombinedFirewall(code: string, result: AiLookupResult | undefined, evidences: EvidenceResult[]): { conflict: boolean; hint: string; reason: string; brandPrefixAdvisory: boolean } {
  const strongExact = isStrongEvidence(strongestEvidence(evidences));
  const prefix = lookupPrefix(code);
  const fw = evaluatePrefixFirewall({
    code,
    prefix,
    candidate: { brand: result?.brand, manufacturer: result?.brand, category: result?.category },
    candidateKnownUpcs: [], // shop-catalog UPC sets live client-side; reverse footprint below is the server signal
    candidateKnownPrefixes: candidateKnownPrefixes(result?.brand), // reverse guard: brand's known prefix footprint
    exactCodeVerifiedByApp: strongExact,
  });
  // PLAN C (owner rule): the catalog-derived brand-prefix sanity is ADVISORY now, not a hard block. GS1
  // prefixes are many-to-one, so a brand-prefix mismatch alone must NEVER block a verify/count - grounding
  // /corpus evidence wins over the prefix. It is still REPORTED (brandPrefixAdvisory) for transparency. The
  // evidence-weighted firewall (fw) still vetoes non-exact conflicting verify paths and is already
  // OVERRIDE-AWARE (strong app-verified exact-code evidence clears it), so it never false-rejects a
  // legitimately exact-verified decode. The category/poison guard stays in the store's contextConflict gate.
  const brandPrefixAdvisory = prefixBrandConflict(code, result?.brand);
  const conflict = fw.conflict;
  // platformOwner-only display: what the barcode prefix maps to, and why a conflict (if any) fired.
  const hint = prefix?.dominant ? `${prefix.dominant.name} (${prefix.dominant.kind}, from barcode prefix - ${prefix.source})` : "";
  const reason = fw.conflict ? fw.reason : "";
  return { conflict, hint, reason, brandPrefixAdvisory };
}

// Task 4 review fix (IMPORTANT 3): the L2 persistent decode cache must persist a "result" ONLY when the
// outcome came from a PAID stage. Free/instant rungs - the tire corpus, the Turso retail index, and the
// Plan D grounding-first fast resolver - must NEVER be persisted: a wrong free-rung guess would become a
// PERMANENT wrong answer that masks future corpus corrections forever ("wrong product identity is
// FAILURE" doctrine), for zero cost benefit (nothing paid was spent to justify a durable cache entry).
//
// Discriminator: reasonCode "gpt_ladder" is unambiguous - BOTH computeDecode exits (the Plan D early
// return and the final return) set it only when the paid GPT-5.5 ladder rung itself resolved the code.
// Otherwise, "paid_ai" is detected from the literal provider-name strings that ONLY the legacy
// fast/escalation/deep-fallback path ever pushes into providerNames: "gemini"/"openai" (decodeProviders /
// escalationProviders - the default AiProvider names from createGeminiProvider/createOpenAiProvider),
// "gemini:read"/"openai:read" (the pageReader's label override, used by enrichWithPageFetch to read a
// fetched page), and "ai-deep"/"ai-cited-deep"/"firecrawl" (the Stage-2 deep fallback finders). Neither
// the tire-corpus exit (providerNames come from TireKnowledgeProvider, e.g. "tire-corpus") nor the Plan D
// exit (providerNames are always "parallel:<source>", e.g. "parallel:groundIdentify") ever emits any of
// these literal strings - even though Plan D's own internals may call a paid grounding/Firecrawl API, it
// is explicitly classified as a free/local rung for L2-persistence purposes per the review brief, so it
// correctly falls through to "not paid" (null) here regardless of what it calls internally.
const PAID_AI_PROVIDER_MARKERS = new Set(["gemini", "openai", "gemini:read", "openai:read", "ai-deep", "ai-cited-deep", "firecrawl"]);

// PAY-ONCE RULE (owner ratified 2026-07-14): a Go-UPC or Fetch V2 win (verified OR suggestion) is paid
// work - the app must never pay for the same code twice, so its result MUST persist to the durable L2
// store. "fetchv2" also has to be recognized when Plan D's parallel-resolve stash prepends its own
// "parallel:<source>" provider name ahead of it in providerNames (see the Fetch V2 rung wiring above) -
// hence `.some()` membership, not an exact-array match.
const PAID_RUNG_PROVIDERS = new Set(["go-upc", "fetchv2"]);

export function classifySourceTier(reasonCode: string, providerNames: string[]): "paid_ai" | "gpt_ladder" | "paid_rung" | null {
  if (reasonCode === "gpt_ladder") return "gpt_ladder";
  if (providerNames.some((n) => PAID_AI_PROVIDER_MARKERS.has(n))) return "paid_ai";
  if (providerNames.some((n) => PAID_RUNG_PROVIDERS.has(n))) return "paid_rung";
  return null;
}

/** Fill in the full GptFromScratchResult shape from a Playwright test-fixture body (E2E only). */
function normalizeMockGptLadder(raw: Partial<GptFromScratchResult> | undefined): GptFromScratchResult | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    tier: raw.tier ?? "none",
    brand: raw.brand ?? "",
    category: raw.category ?? "",
    productName: raw.productName ?? "",
    specs: raw.specs ?? "",
    gtin: raw.gtin ?? "",
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    exactCodeFound: raw.exactCodeFound === true,
    basis: raw.basis ?? "",
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [],
    searches: typeof raw.searches === "number" ? raw.searches : 0,
    usdActual: 0,
    usdWorstCase: GPT_LADDER_WORST_CASE_USD,
    aborted: false,
  };
}

// ---- Fetch V2 rung wiring (server-side) ----------------------------------------------------------

// A lean safe page fetcher for the Fetch V2 rung: SSRF-guarded (isSafePublicUrl), timed out, and
// size-bounded. Any failure resolves to a not-ok page (never throws into the scan). Mirrors the
// benchmark's directFetch, minus the host-cooldown bookkeeping (the FetchV2Cache marks bad URLs).
const FETCHV2_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function fetchV2Page(url: string): Promise<FetchedPage> {
  if (!isSafePublicUrl(url)) return { ok: false, status: 0, html: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCHV2_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCHV2_UA, Accept: "text/html" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, status: res.status, html: "" };
    const html = (await res.text()).slice(0, 400_000);
    return { ok: true, status: res.status, html };
  } catch {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the Fetch V2 discovery providers from configured keys. Brave + Firecrawl only WHEN keyed;
 *  a code with no discovery keys still runs the free structured + pattern-URL doors. */
function fetchV2Discovery(): DiscoveryProvider[] {
  const providers: DiscoveryProvider[] = [];
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) providers.push(braveProvider({ apiKey: braveKey, fetchImpl: fetch as unknown as MinimalFetch }));
  const fcKeys = firecrawlKeysFromEnv();
  if (fcKeys.length > 0) providers.push(firecrawlSearchProvider({ apiKeys: fcKeys, fetchImpl: fetch as unknown as MinimalFetch }));
  return providers;
}

/**
 * The decode request as parsed by route.ts (request parsing + server-side sanitization stay in the
 * route; only the already-sanitized/derived fields the pipeline reads are passed in). This is a plain
 * data bag - no HTTP concerns leak in.
 */
export interface DecodePipelineRequest {
  code: string;
  codeType: ReturnType<typeof import("@/services/codeTypeDetector").detectCodeType>;
  rawCodeSanitized: string;
  cleanCodeSanitized: string;
  threshold: number;
  allowNonPublicAutoCount: boolean;
  forceRetry: boolean;
  scanContext?: "any" | "tire";
  mockGptLadder?: Partial<GptFromScratchResult>;
  /** AM-1(b): the client's own decode budget (ms), parsed by route.ts but previously never threaded
   *  through - dead since Task 2.4's extraction. Combined with DECODE_LADDER_TOTAL_MS to derive the
   *  single request-scoped ladder deadline (see decodeStartedAt / ladderDeadlineAt below). */
  budgetMs?: number;
}

/** The settled decode payload (the response body the route serializes; debug is loose because each
 *  exit adds a different set of optional diagnostic fields). */
export interface DecodePayload {
  mode: "decode";
  providerNames: string[];
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  providerStatuses: ProviderStatus[];
  decision: DecodeDecision;
  reasonCode: string;
  reasonText: string;
  timedOut: boolean;
  debug: Record<string, unknown>;
  sanitizedInput: { rawCodeSanitized: string; cleanCodeSanitized: string };
}

/** What the route needs to serialize: a persisted short-circuit body (with its own debug flags),
 *  a cap block, or a freshly computed payload plus the `cached` flag for the debug echo. */
export type DecodePipelineResult =
  | { kind: "persisted"; body: Record<string, unknown> }
  | { kind: "cap_blocked"; message: string; floor?: import("@/services/catalog/prefixFloor").PrefixFloorResult }
  | { kind: "computed"; payload: DecodePayload; cached: boolean };

/**
 * Run the full decode pipeline for one request. Encapsulates the L1/L2 cache peek, the free
 * corpus/retail/Plan-D stages, the lazy daily-cap gate, the spec-v6 ladder (Go-UPC -> Fetch V2 ->
 * GPT-5.5), and the L2 write-through. Returns a settled result the route turns into an HTTP response.
 * Behavior is identical to the former inline `isDecodeMode` block in route.ts.
 */
export async function runDecodePipeline(req: DecodePipelineRequest): Promise<DecodePipelineResult> {
  const { code, codeType, rawCodeSanitized, cleanCodeSanitized, threshold, allowNonPublicAutoCount, forceRetry, budgetMs } = req;

  // A4 (owner-ratified 2026-07-15, "trace every non-decode"): started at the very TOP of the OUTER
  // function (not computeDecode) so durationMs covers the corpus peek, the L2 persisted-decode peek,
  // and the full ladder -- every exit this request can take. Consumed by Task 12b's ladder deadline
  // wiring too (see AM-10 serialization note: this task lands first).
  const decodeStartedAt = Date.now();

  // L2 total ladder deadline (AM-1(b), owner-reported 36-70s blocking decodes): ONE request-scoped
  // deadline, derived once, passed to EVERY runLadder call below (free run, escalation Go-UPC-only
  // run, full paid run). DECODE_LADDER_TOTAL_MS defaults to 15000ms (AM-1(c): a budget the client's
  // own AbortController - decodeBudgetMs + 7000ms margin, see scanStore.ts - actually outlives), and
  // is widened by the client's own budgetMs when the client asked for a longer window (never
  // narrowed - a client requesting a bigger budget must not get a SMALLER server deadline than its
  // own env default). Never trips on the golden gate: that gate runs fully offline with instant
  // rungs, so wall-clock time never reaches the deadline (do not make it time-sensitive there).
  const ladderDeadlineAt = decodeStartedAt + Math.max(intEnv(process.env.DECODE_LADDER_TOTAL_MS, 15_000), budgetMs ?? 0);

  // A4 outcome ledger append (AM-5): fire-and-forget, best-effort -- a ledger failure must never
  // affect the scan response. Skipped entirely under e2eMode() (tests/Playwright must never touch the
  // real store). `status` is prefixed "cached:" by the caller for a replayed L1/L2 hit so the rollup
  // can tell a fresh compute from a replay. Placed at the OUTER runDecodePipeline level (not inside
  // computeDecode) so it can be called from every exit this function has: the corpus/Plan-D-verified
  // early returns, the L2 persisted-hit replay, a cap block, and the final computed payload.
  const appendDecodeOutcome = (entry: {
    settledBy: string | null;
    status: string;
    reasons: Array<{ rung: string; reason: string }>;
    sourceTier: string | null;
  }): void => {
    if (e2eMode()) return;
    void (async () => {
      try {
        const store = await ladderStorage();
        await store.appendOutcome({
          code,
          canonicalGtin: cacheKeyForOutcomeLedger(),
          settledBy: entry.settledBy,
          status: entry.status,
          reasons: entry.reasons,
          durationMs: Date.now() - decodeStartedAt,
          sourceTier: entry.sourceTier,
          createdAt: new Date().toISOString(),
        });
      } catch {
        /* ledger is best-effort */
      }
    })();
  };
  // canonicalGtin(code) is computed again below as `cacheKey`; this tiny wrapper lets the ledger
  // helper above be declared before `cacheKey` exists without restructuring the function.
  function cacheKeyForOutcomeLedger(): string {
    return canonicalGtin(code) ?? code;
  }

  // Z3 (owner pay-once rule 2026-07-14): ALL cache identities are canonical so two zero-padding
  // encodings of one product never produce two cache entries, two paid runs, or two cap slots.
  // The raw code still flows to every provider/evidence check AND the daily-cap/ladder logic
  // unchanged. MIGRATION NOTE (accepted one-time cost): L2 rows persisted before this change are
  // keyed by the RAW code; canonical reads miss them, so each previously cached GTIN-shaped code
  // recomputes ONCE after deploy (old rows are orphaned, never wrong - upsert re-fills canonically).
  const cacheKey = canonicalGtin(code) ?? code;

  // QA HARDENING FIX #6 (live-proven, 2026-07-16): hoisted to the OUTER function scope (not a nested
  // block) so every free-rung peek that keys off zero-pad barcode VARIANTS with no check-digit
  // awareness - the tire-corpus peek AND both retail-corpus call sites (rung-0 above, and its twin
  // inside computeDecode used for the Plan D consensus vote / contradiction guard) - shares the exact
  // same gate. A GTIN-shaped code whose GS1 check digit FAILS is a likely scanner misread
  // (src/services/upc/misread.ts, the same helper the client-side auto-decode gate uses); it can
  // coincidentally string-match a seeded corpus/retail row and settle a CONFIDENT wrong identity - the
  // live-proven root cause of a fabricated "Healthyholics"-style match on an invalid UPC. Never a
  // misread for a non-GTIN shape (isLikelyMisreadGtin short-circuits false), so this never touches an
  // alpha SKU / vendor label / PN lookup. A bad code falls through honestly to the rest of the pipeline
  // (still appears + counts as Unidentified); a VALID GTIN is completely unaffected.
  const misread = isLikelyMisreadGtin(code);

  // QA ROUND-3 FIX #5 (live-proven bypass on 1bfa6fe): a documentation/example GTIN with a VALID GS1
  // check digit (4006381333931 "Test Shopidoo", 5901234123457, 012345678905 - all on
  // EXAMPLE_BARCODE_BLOCKLIST, plus every degenerate all-zero/all-same/sequential shape) passes the
  // round-2 misread guard (its check digit is valid, so isLikelyMisreadGtin is false) and, when the free
  // rung-0 corpus/retail/learned peeks all correctly reject it, previously ESCALATED to the LIVE PAID
  // Go-UPC rung - which returns verified-strength junk for these textbook codes and auto-counted a
  // fabricated identity. Computed once here (mirroring `misread`) with the CODE-ONLY signature
  // (isExampleOrTestRow(code, "", "") checks the degenerate-shape + blocklist paths, never a name/brand),
  // and read at the paid-ladder entry inside computeDecode to STOP the ladder before any paid rung runs.
  // A non-example code is completely unaffected (this is a KNOWN-blocklist / degenerate-shape gate only).
  const isExample = isExampleOrTestRow(code, "", "");

  // SERVER-ONLY DETERMINISTIC TIRE KNOWLEDGE FIRST (Task 6: moved to the TOP of the pipeline, ahead of
  // the L2 persisted-decode peek below). An EXACT trusted-corpus barcode (or, for SKU-shaped codes, an
  // exact part number) resolves with NO AI call and NO page fetch - a FREE win. It must run BEFORE the
  // persistedHit peek so that when the weekly corpus harvest adds a barcode that previously exhausted
  // the ladder, the fresh corpus hit heals the stale permanent "no_result_receipt" instead of replaying
  // "unresolved" forever. A corpus hit is never persisted to L2 (classifySourceTier returns null for
  // tire-corpus) and never charges the daily cap. e2eMode() skips the peek exactly as before. forceRetry
  // is intentionally NOT special-cased: corpus runs first regardless (equivalent to today, where the
  // corpus stage inside computeDecode always ran even under forceRetry). The corpus is GROUNDING - the
  // downstream store auto-count gate (firewall + tire specs + brand-prefix + >=0.8) still applies.
  // CONSEQUENCE (accepted, Task 6): corpus hits no longer enter the L1 memory cache via withDecodeCache;
  // corpus lookup is ~0-150ms, which is acceptable.
  if (!e2eMode()) {
    // RC3 (pilot PN recall fix): try the corpus PN lookup for every shape EXCEPT a GTIN barcode shape
    // (upc_a/ean_13/gtin_14 - those are barcodes and belong to resolveExactBarcode above, never a part
    // number). Shop part numbers are frequently ALL-NUMERIC (numeric_sku, e.g. "3415030603") or a messy
    // vendor string ("275-30-20 ARROYO"), and previously never got a PN lookup attempt at all because
    // the gate only fired for alpha_sku/vendor_label. This stays the same cheap local rung - no AI, no
    // page fetch either way.
    //
    // REVIEW FIX (Important, EAN-8 hole): the gate USED TO check codeType string labels directly
    // ("upc_a" | "ean_13" | "gtin_14"), but detectCodeType has no ean_8 bucket - an 8-digit EAN-8
    // barcode falls through to "numeric_sku", the SAME label a genuine numeric shop part number gets.
    // That let a real EAN-8 that missed the barcode corpus reach resolveExactPartNumber and
    // coincidentally match an unrelated 7-8 digit tire part number: a wrong-product suggestion on a
    // real barcode. Gate on isGtinShaped(code) instead (already treats ^\d{8}$ and ^\d{12,14}$ as
    // barcode-shaped, see src/services/upc/gtin.ts) so EVERY GTIN-shaped code - 8, 12, 13, or 14
    // digits - is excluded from the PN lookup regardless of what codeType happens to label it.
    // alpha_sku/vendor_label/numeric_sku/messy all still reach the PN lookup when NOT GTIN-shaped.
    const gtinShaped = isGtinShaped(code);
    // `misread` (QA HARDENING FIX #6) is computed once at the top of runDecodePipeline - see there.
    const skuShaped = !gtinShaped && codeType !== "empty";
    const corpus = (!misread ? await resolveExactBarcode(code) : null) ?? (skuShaped ? await resolveExactPartNumber(code) : null);
    if (corpus) {
      appendDecodeOutcome({ settledBy: "tire-corpus", status: corpus.decision.status, reasons: [], sourceTier: null });
      return { kind: "computed", payload: corpusPayload(corpus, rawCodeSanitized, cleanCodeSanitized), cached: false };
    }

    // RETAIL RUNG-0 (live-proven bug fix): immediately after the tire corpus MISSES, for a GTIN-shaped
    // code ONLY (retail is barcode-keyed - never fires for a PN/vendor-label/messy shape). A retail-
    // corpus hit with a USABLE name settles here, BEFORE the L2 cache and BEFORE the daily cap, so it
    // never charges a paid slot - exactly like the tire-corpus/learned-tier peeks above/below. A hit
    // with a GARBAGE name (isUsableProductName rejects it - the same junk firewall every other rung
    // reuses) does NOT settle: it falls through honestly to the rest of the pipeline instead of ever
    // reporting garbage as a product.
    //
    // QA HARDENING FIX #5 (live-proven, 2026-07-16): the crowdsourced retail corpus also ingested
    // literal GS1 TEXTBOOK EXAMPLE barcodes and demo/test rows verbatim (4006381333931 -> "Test
    // Shopidoo", 0012345670121 -> brand "Healthyholics", etc.) - isUsableProductName never checked for
    // these (its regexes target scrape-failure artifacts, not example barcodes or test brand names), so
    // they surfaced as a CONFIDENT "Matched in the retail product database" wrong identity. Reject them
    // here too, falling through to the rest of the pipeline exactly like a garbage name does - the code
    // still appears + counts as Unidentified if nothing else resolves it; it just never reports a fake
    // product with confidence.
    //
    // QA HARDENING FIX #6 (live-proven, 2026-07-16): compose with the misread gate above - a
    // bad-check-digit GTIN must never settle a retail-corpus identity either, for the identical
    // zero-pad-variant-collision reason. Both firewalls are independent and additive (fix #5 rejects a
    // KNOWN example/test row by exact value or name; fix #6 rejects ANY row when the scanned code's own
    // check digit is invalid, regardless of what the row's name/brand is).
    if (gtinShaped && !misread) {
      const { lookupRetailBarcodeAsync } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
      const retailRow = await lookupRetailBarcodeAsync(code);
      if (retailRow && isUsableProductName(retailRow.productName) && !isExampleOrTestRow(retailRow.barcode, retailRow.productName, retailRow.brand)) {
        appendDecodeOutcome({ settledBy: "retail-corpus", status: "suggested", reasons: [], sourceTier: null });
        return { kind: "computed", payload: retailPayload(retailRow, code, rawCodeSanitized, cleanCodeSanitized), cached: false };
      }
    }

    // TASK 21 (owner-ratified 2026-07-15): LEARNED-PRODUCTS TIER PEEK, immediately after the trusted
    // tire/retail corpus MISSES (never before it - the trusted corpus is authoritative ground truth
    // and always wins). A learned hit NEVER reports "verified" - it is honestly a SUGGESTION at its
    // stored confidence (see learnedPayload above), so it can never be confused with the trusted
    // corpus's own verified exit above. A >=0.8 learned suggestion still auto-applies client-side via
    // the existing shouldAutoApplySuggestion gate (scanGates.ts) - that gate, not this peek, is what
    // decides the count; this peek only ever hands back an honest, review-first suggestion.
    const learned = await getLearnedProduct(cacheKey);
    if (learned) {
      appendDecodeOutcome({ settledBy: "learned-products", status: "suggested", reasons: [], sourceTier: null });
      return { kind: "computed", payload: learnedPayload(learned, rawCodeSanitized, cleanCodeSanitized), cached: false };
    }
  }

  // L2 PERSISTENT DECODE CACHE (Task 4): consulted on an L1 miss, BEFORE the daily cap check below -
  // same guard window as the existing L1 peek, so a persisted "result" OR a permanent
  // "no_result_receipt" never burns a daily slot. Never touched under E2E (tests/Playwright must
  // never read/write the real store) and skipped entirely when the caller asks for forceRetry
  // (owner manual override: bypasses the receipt here, and overwrites it once the fresh compute
  // below finishes - see the write-through at the withDecodeCache call site).
  let persistedHit: PersistedDecode | null = null;
  if (!e2eMode() && !forceRetry && getDecodeCache(cacheKey) === undefined) {
    persistedHit = await getPersistedDecode(cacheKey);
  }

  // Hard server-side daily spend cap (auth DEFERRED): the cap must bound ONLY genuine PAID work (the
  // Go-UPC / Fetch V2 / GPT-5.5 ladder rungs), NEVER a $0 resolution. It used to be checked HERE, before
  // computeDecode() ran - but computeDecode's FREE stages (tire-corpus exact hit, retail-corpus exact
  // hit, Plan D's verified win) run INSIDE computeDecode, after this point. Checking the cap here meant a
  // free corpus/retail hit had ALREADY consumed (and could be BLOCKED by) a cap slot before it ever got a
  // chance to resolve for $0 - a burst of free tire-corpus scans could exhaust the cap and 429 every
  // subsequent $0 corpus hit for the rest of the day. Fixed: the cap is now checked LAZILY, immediately
  // before the paid ladder itself runs (the "LAZY DAILY CAP GATE" just above `buildLadderRungs` further
  // down in computeDecode) - free resolution always completes first and is NEVER blocked or counted, no
  // matter the cap state.
  //
  // A persisted hit short-circuits with ZERO provider work: a "result" replays the prior
  // verified/suggested decode; a "no_result_receipt" replays the prior unresolved shape so the
  // ladder is never re-run for a code it has already exhausted (owner rule: no auto-retry - only
  // forceRetry above bypasses this). A corrupted stored payload degrades to a miss (recompute).
  // Parse the persisted payload ONCE - reused both by the SEAM 1 re-validation just below and by the
  // replay return further down (never double-parsed).
  let parsedPayload: Record<string, unknown> | null = null;
  if (persistedHit) {
    try {
      parsedPayload = JSON.parse(persistedHit.payload);
    } catch {
      parsedPayload = null;
    }
  }

  // QA ROUND-2 SEAM 1 (live-proven bypass, 2026-07-16): a persisted "result" hit was replayed VERBATIM
  // with NO misread/example re-check, so a poisoned cache entry (a textbook GS1 EXAMPLE barcode, or a
  // scanner-MISREAD GTIN with a bad check digit) that had earlier been stored as a confident "verified"
  // identity kept being served as an identity - bypassing the round-1 rung-0 seam guards entirely.
  // Re-validate here: for a "result" hit, read the cached identity (results[0].productName/brand) and,
  // if the code is a misread OR that identity is an example/test row, treat the hit as a cache MISS
  // (null it) so control falls through to the honest recompute / rung-0 guards. A misread code also
  // nulls a "no_result_receipt" hit (it must recompute rather than replay a stale unresolved shape).
  // A LEGIT cached decode is untouched and still replays at zero cost - the cache stays fast for the
  // codes it should serve; only poisoned example/misread entries are rejected.
  if (persistedHit) {
    if (misread) {
      persistedHit = null;
    } else if (persistedHit.kind === "result" && parsedPayload) {
      const cachedResults = parsedPayload.results as Array<{ productName?: string; brand?: string }> | undefined;
      const cachedProductName = cachedResults?.[0]?.productName;
      const cachedBrand = cachedResults?.[0]?.brand;
      if (isExampleOrTestRow(code, cachedProductName ?? "", cachedBrand)) {
        persistedHit = null;
      }
    }
  }

  if (persistedHit) {
    if (parsedPayload) {
      const priorDebug = (parsedPayload.debug as Record<string, unknown> | undefined) ?? {};
      appendDecodeOutcome({
        settledBy: (priorDebug.ladderPath as string | undefined) ?? null,
        status: `cached:${persistedHit.kind === "no_result_receipt" ? "no_result_receipt" : (parsedPayload.decision as { status?: string } | undefined)?.status ?? "unknown"}`,
        reasons: (priorDebug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [],
        sourceTier: persistedHit.sourceTier ?? null,
      });
      return {
        kind: "persisted",
        body: {
          ...parsedPayload,
          debug: { ...priorDebug, cached: true, persistedCacheHit: true, persistedKind: persistedHit.kind, persistedTier: persistedHit.tier },
        },
      };
    }
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;

  // GPT-5.5 LADDER RUNG, SHARED HELPER (Task 3b): the paid END of the decode ladder must be
  // reachable from EVERY computeDecode exit that ends unresolved (decision neither "verified" nor
  // "suggested") - not just the final return. The Plan D fast resolver is TERMINAL for public
  // barcodes (it ALWAYS returns at least a generic "Unidentified item" floor, never null), which
  // previously made the rung unreachable for exactly the upc_a/ean_13/gtin_14 codes it was built
  // for. Gates are unchanged from the single-site version: prior verified/suggested skips (happy
  // path, not surfaced), e2e uses only the zero-network mockGptLadder fixture, and shouldRunGptRung
  // still checks codeType -> api key -> (lazily) the daily dollar budget. A blown synchronous
  // decode budget (run.timedOut) also skips - never stack a paid ~10s call on an already-exhausted
  // request. Every live call records spend (success, error, or abort).
  // Owner order 2026-07-06 ("no questioning their answers"): GPT's payload passes through with
  // NO firewall tier cap - capTierForFirewall is deleted along with the info_only tier.
  const maybeGptLadder = async (opts: {
    priorStatus: string;
    timedOut?: boolean;
  }): Promise<{ payload: ReturnType<typeof gptResultToDecodePayload>; skipReason?: string; surfaceSkip: boolean }> => {
    if (opts.priorStatus === "verified" || opts.priorStatus === "suggested") {
      return { payload: null, skipReason: "prior_status_already_decided", surfaceSkip: false };
    }
    if (e2eMode()) {
      // Deterministic Playwright hook ONLY (zero network): lets E2E prove the rung's decision/UI
      // wiring without a live OpenAI call. Ignored when the request carries no mockGptLadder fixture.
      const mock = normalizeMockGptLadder(req.mockGptLadder);
      return { payload: mock ? gptResultToDecodePayload(mock, code) : null, surfaceSkip: false };
    }
    if (opts.timedOut) {
      // The synchronous decode budget is already blown - never stack a paid ~10s call on top.
      return { payload: null, skipReason: "request_budget_exhausted", surfaceSkip: true };
    }
    const rung = shouldRunGptRung({
      code,
      codeType,
      priorStatus: opts.priorStatus,
      e2e: false,
      apiKeyPresent: !!process.env.OPENAI_API_KEY,
      // LAZY (MINOR 3): checkGptLadderBudget() does a synchronous file read. shouldRunGptRung checks
      // priorStatus/codeType/e2e/apiKeyPresent FIRST and only calls this thunk once all of those pass,
      // so a code that never had a chance to reach the ladder never pays for that file I/O.
      budget: () => checkGptLadderBudget({ worstCaseUsd: GPT_LADDER_WORST_CASE_USD }),
    });
    if (!rung.run) return { payload: null, skipReason: rung.skipReason, surfaceSkip: true };
    const r = await gptFromScratch(code, { apiKey: process.env.OPENAI_API_KEY! });
    recordGptLadderSpend(r.usdActual); // ALWAYS - success, error, or abort; never skip this.
    recordGptLadderCall(); // Task 6: Settings spend panel + GET status "calls today" counter.
    // TRANSIENT-FAILURE GUARD (found live 2026-07-06): an aborted/HTTP-failed/garbled rung call is
    // NOT genuine exhaustion - the model never actually answered. Without this, one OpenAI hiccup
    // wrote a PERMANENT no_result_receipt and froze the code forever. Only a real answer with an
    // empty productName ("empty productName") counts as genuinely probed-and-empty; every other
    // "none" is surfaced as a skip (visible in providerStatuses) and stays retryable.
    if (r.tier === "none" && (r.aborted || (r.error && r.error !== "empty productName"))) {
      return { payload: null, skipReason: r.aborted ? "gpt_aborted_at_cap" : "gpt_call_failed", surfaceSkip: true };
    }
    return { payload: gptResultToDecodePayload(r, code), surfaceSkip: false };
  };
  // providerStatuses entry for a surfaced ladder skip - matches the firecrawl skip pattern; the skip
  // reason travels in errorCode (ProviderStatus's "safe code only" field; there is no detail field).
  const gptLadderSkipEntry = (reason: string) => ({
    provider: "gpt-5.5-ladder", status: "skipped" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: reason,
  });
  const gptLadderEvidenceStub = (): EvidenceResult => ({
    verified: false, strength: "none", matchedCode: "", matchedSources: [], reason: "gpt-5.5 self-report (not independently evidence-verified)",
  });

  // Task 4: classify whether a ladder outcome represents GENUINE exhaustion (worth a permanent
  // no_result_receipt) vs a TRANSIENT skip that must stay retryable on the next scan. Genuine
  // exhaustion is exactly: the GPT rung actually ran and returned tier "none" (payload null, no skip
  // reason - the rung was never short-circuited). (The old info_only tier is deleted per owner order
  // 2026-07-06; every GPT answer with a productName now resolves as verified or suggested.)
  // Every other skip is transient and must NOT create a receipt.
  // DOCTRINE CORRECTION (review, supersedes Task 4's original "budget_exceeded is eligible" rule): a
  // receipt certifies "the ladder was fully probed and every door came back empty." A code blocked by
  // the ladder's OWN dollar budget was NEVER probed at all - it is exactly as unresolved as a missing
  // API key or an e2e run, and the daily budget resets tomorrow. Treating "budget_exceeded" as eligible
  // would permanently freeze every code unlucky enough to arrive right when the daily cap was tight,
  // with no automatic recovery once the cap resets (only a manual forceRetry would ever revisit it).
  // "budget_exceeded" therefore now falls into the same transient/not-eligible bucket as no_api_key,
  // non_public_code_type, e2e_mode, and request_budget_exhausted (all `ladder.surfaceSkip === true`).
  const classifyReceipt = (ladder: { payload: ReturnType<typeof gptResultToDecodePayload>; skipReason?: string; surfaceSkip: boolean }): { eligible: boolean; reason?: string } => {
    if (ladder.payload) {
      return { eligible: false }; // resolved by the ladder itself (verified or suggested)
    }
    if (ladder.surfaceSkip) return { eligible: false }; // transient: no key / non-public / e2e / request budget exhausted / OWN dollar budget exhausted
    if (!ladder.skipReason) return { eligible: true, reason: "gpt_none" }; // ran, tier none
    return { eligible: false }; // prior_status_already_decided (resolved before the ladder ran)
  };
  // Set by whichever computeDecode exit actually ran the ladder (Plan D early return or the final
  // return below); read at the withDecodeCache call site to decide the L2 write-through. Declared
  // outside computeDecode (per-request, not per-process) so it reflects THIS request's outcome only.
  let receiptState: { eligible: boolean; reason?: string } = { eligible: false };

  // The expensive decode (fast path + deep fallback) is cached by code: once a barcode resolves to a
  // real product, a repeat scan in this server returns instantly with NO AI/Firecrawl spend. Only a
  // SUCCESS (a usable product) is cached - a failure stays retryable. Skipped under E2E (mock-only).
  const computeDecode = async (): Promise<DecodePayload> => {
    // QA ROUND-3 FIX #5 (live-proven bypass, PRE-PAID-RUNG GATE): computeDecode is only ever reached
    // after the outer free rung-0 corpus/retail/learned peeks have MISSED (they now reject example/test
    // rows via round-1). If the scanned CODE itself is a known documentation/example barcode or a
    // degenerate placeholder shape (isExample, computed once at the top of runDecodePipeline), STOP here
    // - BEFORE Plan D's internal paid legs and BEFORE the first paid ladder rung (goupc). It settles an
    // honest, no-identity needs_review: the code still appears + counts as an Unidentified row (TOP-LEVEL
    // LAW), never a fabricated verified/suggested identity, and no paid provider is ever consulted (owner
    // is cost-sensitive). This is the PRIMARY fix; a defense-in-depth guard at the paid-rung SETTLE point
    // (see the isExampleOrTestRow check on the ladder win below) catches any path this pre-gate misses.
    if (isExample) {
      const reason = sanitizeCustomerReason(
        "This looks like an example or test barcode, not a real product. Enter the item manually if needed.",
        { status: "needs_review" },
      );
      const decision: DecodeDecision = {
        status: "needs_review",
        confidence: 0,
        reason,
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "single_provider", confidence: 0, reason: "Example/test barcode - not looked up.", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
      };
      return {
        mode: "decode" as const,
        providerNames: ["example-gate"],
        results: [],
        evidences: [],
        providerStatuses: [{ provider: "example-gate", status: "skipped" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: "example_or_test_barcode" }],
        decision,
        reasonCode: "no_result",
        reasonText: reason,
        timedOut: false,
        debug: { providersAttempted: ["example-gate"], evidenceStrengths: [], sourceCounts: [], corroborationPath: "example_or_test_barcode", ladderPath: "none", ladderReasons: [{ rung: "example-gate", reason: "example/test barcode - paid rungs skipped" }], aiCalled: false, pageFetched: false, cached: false },
        sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
      };
    }

    // Task 6: the SERVER-ONLY DETERMINISTIC TIRE KNOWLEDGE peek that used to sit here has moved to the
    // TOP of runDecodePipeline (ahead of the L2 persisted-decode peek) so a corpus hit can heal a stale
    // no_result_receipt. computeDecode is only ever reached on a corpus MISS now, so no corpus check
    // remains here - see corpusPayload + the early peek above.

    // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
    // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
    // is surfaced in the decode debug payload below (both the hit-return here and the AI-path
    // fallback) so a broken Turso connection ("turso_error") is distinguishable from a genuine
    // corpus miss ("turso_miss") instead of both silently falling through to paid AI decode.
    let retailLookupStatus: string | undefined;
    let retailHit: { productName: string; brand: string } | null = null;
    // RETAIL RUNG-0 FIX: gated to isGtinShaped(code) - retail is a barcode-keyed index (never a
    // PN/vendor-label/messy shape). This is the SAME gate the new rung-0 settle above uses; a miss here
    // means rung-0 already tried the exact same lookup and came back empty (or found a garbage name),
    // so this is never a second network round-trip for a code that already settled at rung 0 - it only
    // runs when computeDecode is reached at all, i.e. rung 0 already missed.
    // QA HARDENING FIX #6: also gated on `!misread` (hoisted outer-scope const, see top of
    // runDecodePipeline) - this is the retail rung-0 peek's OWN twin (this file's comment above already
    // called it out as "the SAME gate"), so it must never feed a misread code's coincidental row into
    // the Plan D consensus vote or the paid-verified contradiction guard either.
    if (!e2eMode() && isGtinShaped(code) && !misread) {
      const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
      const rawRetailHit = await lookupRetailBarcodeAsync(code);
      retailLookupStatus = getLastRetailLookupStatus();
      // QA HARDENING FIX #5: reject an example/test row (textbook GS1 example barcode, or a
      // demo/placeholder name/brand) at THIS single source, so neither the Plan D `retailDb` consensus
      // vote below nor the paid-verified contradiction guard further down ever sees a fake identity
      // ("Test Shopidoo", brand "Healthyholics", etc.) - it is honestly treated as a retail-corpus miss.
      retailHit = rawRetailHit && !isExampleOrTestRow(rawRetailHit.barcode, rawRetailHit.productName, rawRetailHit.brand) ? rawRetailHit : null;
      // The 4M-row Open Food Facts retail DB (Turso) is a FREE structured source. Its data is mostly right
      // but has some WRONG rows (glycine UPC 0737870166917 -> "Coconut oil"), so it is NO LONGER trusted
      // ALONE (that produced wrong Verified identities - the old Fix 5). Instead it is passed into the
      // resolver below as ONE consensus VOTE (the retailDb dep): a wrong OFF row is OUTVOTED by UPCitemdb +
      // grounding, while its millions of correct rows give FREE, instant (~50-160ms) coverage - so most
      // food/retail codes auto-count with no AI and no Firecrawl.
    }

    // PLAN D (grounding-first fast resolver) MOVED (Task 7, ORDER v3): it used to run HERE, before the
    // decode ladder. Under the owner-ratified cost order (retail peek -> FREE rungs -> Plan D -> cap gate
    // -> paid ladder) Plan D's internal Firecrawl legs must not run before the $0 UPCitemdb/OFF rungs, so
    // its execution now happens further down, AFTER the free ladder run completes. Only these forward
    // declarations stay up here (they are read by the response assembly below). See "PLAN D EXECUTION".
    const isPublicBarcode = codeType === "upc_a" || codeType === "ean_13" || codeType === "gtin_14";
    let planDStash: DecodePayload | null = null;
    let planDProviderStatusForStash: ProviderStatus | null = null;
    let planDAiCalled = false;

    // ===== DECODE LADDER (spec v6): Go-UPC -> Fetch V2 -> GPT-5.5 =====================================
    // Replaces the legacy Gemini/OpenAI fast-path + deep-fallback stage entirely. Gemini is REMOVED
    // from decode (owner order 2026-07-06). Order + short-circuit are owned by runLadder (pure): the
    // first rung that SETTLES (verified OR a suggestion) stops the ladder; a miss/unavailable records
    // its reason and falls through. Non-GTIN codes skip the Go-UPC rung (gate in buildLadderRungs).
    //
    // Every settled rung produces a self-contained decode payload (results/evidences/providerNames/
    // providerStatuses/decision/reasonCode/reasonText) so the response assembly below is uniform.
    type LadderPayload = {
      results: AiLookupResult[];
      evidences: EvidenceResult[];
      providerNames: string[];
      providerStatuses: ProviderStatus[];
      decision: DecodeDecision;
      reasonCode: string;
      reasonText: string;
    };

    // Accumulated across rungs so the final debug/receipt logic can read them.
    type GptLadderOutcome = { payload: ReturnType<typeof gptResultToDecodePayload>; skipReason?: string; surfaceSkip: boolean };
    let gptLadderResult: GptLadderOutcome | null = null;
    // Read helper (function boundary defeats TS control-flow over-narrowing: gptLadderResult is
    // assigned inside the runGpt closure, which CFA cannot see from the synchronous read site).
    const gptSkipReason = (): string | undefined => {
      const g = gptLadderResult;
      return g && !g.payload ? g.skipReason : undefined;
    };
    const ladderProviderStatuses: ProviderStatus[] = [];

    // ---- Rung 0: UPCitemdb (FREE, keyless trial tier; GTIN codes only; gated in buildLadderRungs) ---
    // Runs BEFORE Go-UPC (free before paid, owner order 2026-07-12 free-rungs plan). Never touches the
    // paid daily AI-lookup cap - it owns its own local daily counter (90/day, buffer under the
    // provider's 100/day trial limit). A hit is ALWAYS a suggestion (Resolver Trust Rules); it can
    // never settle the ladder as "verified" on its own.
    const runUpcItemDb = async (): Promise<RungOutcome> => {
      if (e2eMode()) return { settled: false, reason: "UPCitemdb skipped (E2E mock mode)" };
      const ladderStore = await ladderStorage();
      const r = await upcItemDbRung(code, {
        client: (c) => upcItemDbLookup(c, {}),
        usage: upcItemDbUsage(ladderStore),
      });
      ladderProviderStatuses.push({
        provider: "upcitemdb",
        status: r.path === "upcitemdb_hit" ? "ok" : "skipped",
        latencyMs: 0,
        sourceUrlsReturned: 0,
        exactCodeFound: false,
        identityFound: !!r.results?.length,
        errorCode: r.path === "upcitemdb_unavailable" || r.path === "upcitemdb_miss" ? r.reason : undefined,
      });
      if (r.path === "upcitemdb_hit" && r.decision) {
        return {
          settled: true,
          reason: r.reason,
          payload: {
            results: r.results ?? [],
            evidences: [{ verified: false, strength: "snippet", matchedCode: code, matchedSources: ["upcitemdb"], reason: r.reason }],
            providerNames: ["upcitemdb"],
            providerStatuses: [...ladderProviderStatuses],
            decision: r.decision,
            reasonCode: "needs_review",
            reasonText: r.reason,
          } satisfies LadderPayload,
        };
      }
      // upcitemdb_miss / upcitemdb_unavailable: fall through, reason recorded.
      return { settled: false, reason: r.reason };
    };

    // ---- Rung 0.5: Open Food Facts (FREE; built in Task 3.4) -----------------------------------------
    const runOpenFoodFacts = async (): Promise<RungOutcome> => {
      if (e2eMode()) return { settled: false, reason: "Open Food Facts skipped (E2E mock mode)" };
      const ladderStore = await ladderStorage();
      const r = await openFoodFactsRung(code, {
        client: (c) => openFoodFactsLookup(c, {}),
        usage: openFoodFactsUsage(ladderStore),
      });
      ladderProviderStatuses.push({
        provider: "openfoodfacts",
        status: r.path === "openfoodfacts_hit" ? "ok" : "skipped",
        latencyMs: 0,
        sourceUrlsReturned: 0,
        exactCodeFound: false,
        identityFound: !!r.results?.length,
        errorCode: r.path === "openfoodfacts_unavailable" || r.path === "openfoodfacts_miss" ? r.reason : undefined,
      });
      if (r.path === "openfoodfacts_hit" && r.decision) {
        return {
          settled: true,
          reason: r.reason,
          payload: {
            results: r.results ?? [],
            evidences: [{ verified: false, strength: "snippet", matchedCode: code, matchedSources: ["openfoodfacts"], reason: r.reason }],
            providerNames: ["openfoodfacts"],
            providerStatuses: [...ladderProviderStatuses],
            decision: r.decision,
            reasonCode: "needs_review",
            reasonText: r.reason,
          } satisfies LadderPayload,
        };
      }
      return { settled: false, reason: r.reason };
    };

    // ---- Rung 1: Go-UPC (GTIN codes only; gated in buildLadderRungs) --------------------------------
    const runGoUpc = async (): Promise<RungOutcome> => {
      // E2E MOCK MODE: live rungs are bypassed exactly like the legacy [mockProvider] path - E2E
      // resolves only via the GPT rung's zero-network mockGptLadder fixture (or falls to Needs Review).
      if (e2eMode()) return { settled: false, reason: "Go-UPC skipped (E2E mock mode)" };
      const ladderStore = await ladderStorage();
      const r = await goUpcRung(code, {
        apiKey: process.env.GO_UPC_API_KEY,
        client: (c, d) => goUpcLookup(c, d),
        gate: goUpcGate,
        usage: goUpcUsage(ladderStore),
        storage: ladderStore,
        prefixLookup: goUpcPrefixLookup,
      });
      ladderProviderStatuses.push({
        provider: "go-upc",
        status: r.path === "goupc_exact" || r.path === "goupc_inferred" || r.path === "goupc_prefix_conflict" ? "ok" : "skipped",
        latencyMs: 0,
        sourceUrlsReturned: 0,
        exactCodeFound: r.path === "goupc_exact",
        identityFound: !!r.results?.length,
        errorCode: r.path === "goupc_unavailable" || r.path === "goupc_miss" ? r.reason : undefined,
      });
      if (r.path === "goupc_exact" && r.decision) {
        return {
          settled: true,
          reason: r.reason,
          payload: {
            results: r.results ?? [],
            evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["go-upc"], reason: "Go-UPC exact barcode match" }],
            providerNames: ["go-upc"],
            providerStatuses: [...ladderProviderStatuses],
            decision: r.decision,
            reasonCode: "ok",
            reasonText: "",
          } satisfies LadderPayload,
        };
      }
      if ((r.path === "goupc_inferred" || r.path === "goupc_prefix_conflict") && r.decision) {
        return {
          settled: true,
          reason: r.reason,
          payload: {
            results: r.results ?? [],
            evidences: [{ verified: false, strength: "snippet", matchedCode: code, matchedSources: ["go-upc"], reason: r.reason }],
            providerNames: ["go-upc"],
            providerStatuses: [...ladderProviderStatuses],
            decision: r.decision,
            reasonCode: "needs_review",
            reasonText: r.reason,
          } satisfies LadderPayload,
        };
      }
      // goupc_miss / goupc_unavailable: fall through, reason recorded.
      return { settled: false, reason: r.reason };
    };

    // ---- Rung 2: Fetch V2 (web evidence engine; balanced, 3 sources, 25s cap) -----------------------
    const runFetchV2 = async (): Promise<RungOutcome> => {
      // E2E MOCK MODE: no live web crawl (see runGoUpc note); fall straight through to the GPT rung.
      if (e2eMode()) return { settled: false, reason: "Fetch V2 skipped (E2E mock mode)" };
      const deps: FetchV2Deps = {
        fetchPage: fetchV2Page,
        discovery: fetchV2Discovery(), // Brave + Firecrawl only when keyed
        structured: [{ name: "brocade", lookup: (variants) => brocadeLookup(variants) }],
        cache: fetchV2Cache,
        patternUrls: (variants) => {
          // AM-10 (Task 12 deferred hunk, owner-ratified 2026-07-15): an ASIN-shaped variant
          // (Amazon's "B0" + 8 alphanumerics) gets its public /dp/ catalog page as the pattern URL
          // instead of a numeric-barcode source list. The fetchV2 engine's door gate (AM-7,
          // fetchV2/index.ts:198) already allows `identifier.type === "asin"` to reach this door
          // even with zero discovery providers configured - this hunk is what actually feeds it a
          // URL. Evidence from this door is suggestion-grade by construction: decideDecode never
          // verifies a non-public-barcode code, so an ASIN can never auto-count from this alone.
          const asin = variants.find((v) => /^B0[0-9A-Z]{8}$/i.test(v));
          if (asin) return [`https://www.amazon.com/dp/${asin.toUpperCase()}`];
          const c = variants.find((v) => /^\d{12,14}$/.test(v)) ?? variants[0];
          return selectBarcodeUrls(c).slice(0, 4);
        },
      };
      let fv2;
      try {
        fv2 = await fetchV2(code, deps, { mode: "balanced", maxSourcesPerCode: FETCHV2_MAX_SOURCES, maxTotalMs: FETCHV2_MAX_TOTAL_MS });
      } catch (e) {
        const detail = e instanceof Error ? e.message : "error";
        ladderProviderStatuses.push({ provider: "fetchv2", status: "error", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: "fetchv2_error" });
        return { settled: false, reason: `Fetch V2 error: ${detail}` };
      }
      const identity = [fv2.product.brand, fv2.product.name].filter(Boolean).join(" ").trim();
      const settledOutcome = fv2.outcome === "verified" || fv2.outcome === "suggested" || fv2.outcome === "needs_review";
      ladderProviderStatuses.push({
        provider: "fetchv2",
        status: settledOutcome ? "ok" : "skipped",
        latencyMs: Math.round(fv2.performance.durationMs),
        sourceUrlsReturned: fv2.sourcesChecked.length,
        exactCodeFound: fv2.evidence.exactCodeFound,
        identityFound: !!identity,
        errorCode: settledOutcome ? undefined : fv2.outcome,
      });
      if (!settledOutcome || !identity) {
        return { settled: false, reason: `Fetch V2 ${fv2.outcome} (no usable identity) -> fall through` };
      }
      const verified = fv2.outcome === "verified";
      const result: AiLookupResult = {
        ...emptyResult(),
        productName: fv2.product.name,
        brand: fv2.product.brand,
        category: fv2.product.category,
        specsShort: fv2.product.size || "",
        primaryBarcode: code,
        imageUrl: fv2.product.imageUrl || "",
        confidence: verified ? Math.max(0.9, fv2.evidence.finalConfidence) : Math.min(fv2.evidence.finalConfidence || 0.5, 0.6),
        sourceUrls: fv2.evidence.winningSourceUrl ? [fv2.evidence.winningSourceUrl] : [],
        verifiedFacts: verified ? ["Fetch V2 exact barcode evidence"] : [],
        needsHumanReview: !verified,
      };
      const evidence: EvidenceResult = verified
        ? { verified: true, strength: "fetched_source", matchedCode: code, matchedSources: [fv2.evidence.winningSourceUrl || "fetchv2"], reason: "Fetch V2 app-verified exact code on page" }
        : { verified: false, strength: "snippet", matchedCode: "", matchedSources: [], reason: `Fetch V2 ${fv2.outcome} (unverified) - human review` };
      const fw = evalCombinedFirewall(code, result, [evidence]);
      const decision = decideDecode({ codeType, results: [result], evidences: [evidence], confidenceThreshold: threshold, code, scanContext: req.scanContext, brandPrefixConflict: fw.conflict, allowNonPublicAutoCount });
      return {
        settled: true,
        reason: `Fetch V2 ${fv2.outcome}`,
        payload: {
          results: [result],
          evidences: [evidence],
          providerNames: ["fetchv2"],
          providerStatuses: [...ladderProviderStatuses],
          decision,
          reasonCode: verified ? "ok" : "needs_review",
          reasonText: verified ? "" : (REASON_TEXT["needs_review"] ?? ""),
        } satisfies LadderPayload,
      };
    };

    // ---- Rung 3: GPT-5.5 (paid END of the ladder; reuses maybeGptLadder) ----------------------------
    const runGpt = async (): Promise<RungOutcome> => {
      const ladder = await maybeGptLadder({ priorStatus: "needs_review", timedOut: false });
      gptLadderResult = ladder;
      if (ladder.payload) {
        return {
          settled: true,
          reason: "gpt-5.5 ladder answered",
          payload: {
            results: [ladder.payload.result],
            evidences: [gptLadderEvidenceStub()],
            providerNames: ["gpt-5.5-ladder"],
            providerStatuses: ladder.surfaceSkip ? [...ladderProviderStatuses, gptLadderSkipEntry(ladder.skipReason!)] : [...ladderProviderStatuses],
            decision: ladder.payload.decision,
            reasonCode: "gpt_ladder",
            reasonText: ladder.payload.reasonText,
          } satisfies LadderPayload,
        };
      }
      if (ladder.surfaceSkip) ladderProviderStatuses.push(gptLadderSkipEntry(ladder.skipReason!));
      return { settled: false, reason: ladder.skipReason ? `gpt-5.5 skipped: ${ladder.skipReason}` : "gpt-5.5 tier none (no product)" };
    };

    // ===== ORDER v3 (owner-ratified 2026-07-14) =====================================================
    // retail peek (above, unchanged) -> FREE rungs -> Plan D -> cap gate -> paid ladder.
    // Free-before-paid now holds STRICTLY: Plan D's internal Firecrawl legs no longer run before the $0
    // UPCitemdb/OFF rungs. ESCALATION: a free-rung SUGGESTION is a fallback, not a stop - one cap-charged
    // Go-UPC exact-verify may still upgrade it to verified; fetchv2/gpt NEVER run past it. A total free
    // MISS keeps today's exact behavior (Plan D -> cap gate -> full paid ladder: goupc -> fetchv2 -> gpt).
    //
    // A6 (owner-ratified 2026-07-15, AM-3 hardened): a code with a strong, >=8-digit tire-prefix hint
    // skips BOTH free rungs (UPCitemdb/OFF have never returned a tire). The steered path is otherwise
    // IDENTICAL to today's non-GTIN path (buildFreeLadderRungs already returns [] for non-GTINs), so no
    // downstream freeSuggestion/total-miss branch needed any change - see freeRungSteering.ts's doc
    // comment for the full blast-radius rationale (a false steer can cost a real paid cap slot).
    const steering = steerFreeRungs(code);
    const freeRungs = steering.skip ? [] : buildFreeLadderRungs(code, { runUpcItemDb, runOpenFoodFacts });
    const freeRun = await runLadder(code, freeRungs, { deadlineAt: ladderDeadlineAt });
    if (steering.skip) freeRun.reasons.push({ rung: "free-steering", reason: steering.reason });
    // The free rungs (UPCitemdb / Open Food Facts) NEVER emit "verified" today - both are always
    // suggestions (Resolver Trust Rules). freeStatus is read defensively so a future verified free rung
    // (none exists now) would still be handled as a terminal free win via the `else` branch below.
    const freeStatus = (freeRun.outcome?.payload as LadderPayload | undefined)?.decision.status ?? null;
    const freeSuggestion = freeRun.outcome && freeStatus !== "verified" ? freeRun : null;

    // ---- PLAN D EXECUTION (grounding-first fast resolver) --------------------------------------------
    // Runs AFTER the free ladder rungs (ORDER v3) and BEFORE the cap gate. A VERIFIED Plan D win is a
    // genuine free-tier resolution and RETURNS immediately, exactly as before (no cap charge, no paid
    // rung). A non-verified floor/suggestion is STASHED (planDStash) as the all-miss fallback. Gated to
    // PUBLIC barcodes and skipped under E2E (mock-only). This is the same block that used to sit above the
    // ladder; only its POSITION moved (owner cost-order fix), the internals are byte-for-byte unchanged.
    if (!e2eMode() && isPublicBarcode) {
      const fast = await resolveUnknownFast(code, {
        lookupBarcodeDb: (c) => lookupBarcodeDb(c),
        retailDb: async () => (retailHit ? { name: retailHit.productName, brand: retailHit.brand } : null),
        // Gemini grounding arm gated off with the rest of Gemini (owner order 2026-07-06); null
        // is the arm's documented "miss" value, so Plan D consensus just proceeds without it.
        groundIdentify: (c, opts) => (GEMINI_DECODE_DISABLED ? Promise.resolve(null) : groundIdentify(c, opts)),
        verifyCodeOnPage: (urls, c) => verifyCodeOnPage(urls, c),
        firecrawlScrapeCheap: (u) => firecrawlScrapeCheap(u),
        searchIdentify: (c) => searchIdentifyByBarcode(c),
        prefixFloor: (c) => prefixFloorName(c, codeType),
      }).catch(() => null);
      if (fast) {
        const verifiedWin = fast.verified && isUsableProductName(fast.name);
        const result: AiLookupResult = {
          ...emptyResult(),
          productName: fast.name,
          brand: fast.brand,
          confidence: verifiedWin ? 0.9 : 0.5,
          needsHumanReview: !verifiedWin,
          sourceUrls: [],
        };
        const evidence: EvidenceResult = verifiedWin
          ? { verified: true, strength: "fetched_source", matchedCode: code, matchedSources: [`parallel-${fast.source}`], reason: `Exact identification via parallel ${fast.source}` }
          : { verified: false, strength: "none", matchedCode: "", matchedSources: [], reason: `Unverified parallel ${fast.source} (suggestion/floor) - not auto-counted` };
        let decision = decideDecode({ codeType, results: [result], evidences: [evidence], confidenceThreshold: threshold, code, scanContext: req.scanContext, brandPrefixConflict: false });
        const floorReasonCode = decodeReasonCode({ hasProduct: isUsableProductName(fast.name), fallbackFound: false, timedOut: false, decisionStatus: decision.status, statuses: [], firecrawlKey: !!firecrawlKey, coverageMissed: false });
        const floorReasonText = verifiedWin ? "" : (REASON_TEXT[floorReasonCode] ?? "");
        if (decision.status !== "verified" && floorReasonText) decision = { ...decision, reason: floorReasonText };

        const pdResults: AiLookupResult[] = [result];
        const pdEvidences: EvidenceResult[] = [evidence];
        const pdProviderNames = [`parallel:${fast.source}`];
        const pdProviderStatus: ProviderStatus = { provider: `parallel:${fast.source}`, status: "ok" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: verifiedWin, identityFound: isUsableProductName(fast.name) };
        const pdReasonCode = verifiedWin ? "ok" : floorReasonCode;
        const pdReasonText = floorReasonText;

        if (verifiedWin) {
          // Verified win is a genuine free-tier resolution - terminal, exactly like a corpus hit.
          // The ladder never runs and no paid spend occurs.
          return {
            mode: "decode" as const,
            providerNames: pdProviderNames,
            results: pdResults,
            evidences: pdEvidences,
            providerStatuses: [pdProviderStatus],
            decision,
            reasonCode: pdReasonCode,
            reasonText: pdReasonText,
            timedOut: false,
            // groundingStatus makes a silent grounding outage (e.g. a model 503) visible in the decode
            // debug instead of consensus quietly degrading to the two correlated DB votes.
            debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled, pageFetched: false, cached: false, groundingStatus: getLastGroundingStatus(), retailLookup: retailLookupStatus },
            sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
          };
        }

        // Non-verified (floor/suggestion): STASH the payload; it is the all-miss fallback (see below).
        planDAiCalled = fast.aiCalled;
        planDProviderStatusForStash = pdProviderStatus;
        planDStash = {
          mode: "decode" as const,
          providerNames: pdProviderNames,
          results: pdResults,
          evidences: pdEvidences,
          providerStatuses: [pdProviderStatus],
          decision,
          reasonCode: pdReasonCode,
          reasonText: pdReasonText,
          timedOut: false,
          debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled, pageFetched: false, cached: false, groundingStatus: getLastGroundingStatus(), retailLookup: retailLookupStatus },
          sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
        };
      }
    }

    // ---- LAZY DAILY CAP GATE, extracted ONCE (Task 7) -----------------------------------------------
    // The single read-then-charge block, used by BOTH the escalation branch (before the Go-UPC-only run)
    // and the full-paid branch (before the full ladder). READ-ONLY check first (never writes on a block),
    // THEN one atomic charge - exactly once per request, immediately before genuine paid work starts. A
    // blown cap throws DailyCapExceededError BEFORE any paid rung runs (its semantics are unchanged on
    // both branches: every free stage has already completed and returned by this point). E2E is a no-op.
    const chargePaidSlot = async (): Promise<void> => {
      if (e2eMode()) return;
      const ladderStore = await ladderStorage();
      const limit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
      const used = await readDailyUsed(ladderStore);
      if (used >= limit) throw new DailyCapExceededError(used, limit);
      await chargeDailySlot(ladderStore, { limit });
    };

    let ladderRun: LadderResult;
    if (freeSuggestion) {
      // ESCALATION PATH: a free suggestion stands as a fallback; a single cap-charged Go-UPC exact-verify
      // may still upgrade it to verified (Go-UPC wins). Otherwise the free suggestion is the final answer;
      // fetchv2/gpt NEVER run past a free suggestion (owner-ratified). receiptState stays {eligible:false}
      // and gptLadderResult stays null on this branch - the GPT rung never runs, so the code was NOT
      // exhaustively probed and earns no permanent no_result_receipt.
      //
      // The cap is charged BEFORE the Go-UPC-only run (paid work is paid work) - but ONLY when Go-UPC is
      // genuinely capable of a paid attempt: the goupc rung is present (GTIN-gated; a NON-GTIN code yields
      // an empty array) AND a Go-UPC key is configured. Charging (and cap-blocking) for a rung that would
      // immediately no-op as "unavailable" would violate the doctrine that the cap bounds only genuine
      // PAID work and must never block a $0 free resolution - so when Go-UPC can't actually pay, we skip
      // the charge and the free suggestion simply stands (no fetchv2/gpt escalation past it).
      const goUpcRungOnly = buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt }).filter((r) => r.name === "goupc");
      const goUpcCanPay = goUpcRungOnly.length > 0 && !!process.env.GO_UPC_API_KEY;
      if (goUpcCanPay) {
        await chargePaidSlot();
        const goRun = await runLadder(code, goUpcRungOnly, { deadlineAt: ladderDeadlineAt });
        const goStatus = (goRun.outcome?.payload as LadderPayload | undefined)?.decision.status ?? null;
        ladderRun = goStatus === "verified"
          ? { settledBy: goRun.settledBy, outcome: goRun.outcome, reasons: [...freeRun.reasons, ...goRun.reasons] }
          : { settledBy: freeRun.settledBy, outcome: freeRun.outcome, reasons: [...freeRun.reasons, ...goRun.reasons] };
      } else {
        // No paid Go-UPC attempt possible -> the free suggestion is the answer, unblocked, uncharged.
        ladderRun = freeRun;
      }
    } else if (!freeRun.outcome) {
      // TOTAL FREE MISS: cap gate then the FULL paid ladder (goupc -> fetchv2 -> gpt) - BUT (L6, Task
      // 12c) only charge the cap slot when paid work is genuinely POSSIBLE for this code. With zero
      // provider keys configured, this branch degrades entirely to the AM-7 keyless pattern-URL scrape
      // and honest per-rung skips - never a slot for work that was never actually paid. Escalation
      // above already applies the equivalent gate (goUpcCanPay) for its own paid attempt.
      if (paidWorkPossible(code)) await chargePaidSlot();
      const paidRun = await runLadder(code, buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt }), { deadlineAt: ladderDeadlineAt });
      // Concatenate reasons free-phase-then-paid-phase so an unresolved response still lists every rung
      // that actually ran, honestly, in the order it ran.
      ladderRun = { settledBy: paidRun.settledBy, outcome: paidRun.outcome, reasons: [...freeRun.reasons, ...paidRun.reasons] };
    } else {
      // Future-proof: a VERIFIED free win (no free rung emits one today). Terminal, no paid work.
      ladderRun = freeRun;
    }
    let win = ladderRun.outcome?.payload as LadderPayload | undefined;

    // QA ROUND-3 FIX #5 DEFENSE-IN-DEPTH (secondary to the pre-paid-rung gate at the top of
    // computeDecode): if any paid rung STILL settled a decode whose CODE or decoded identity is an
    // example/test row, never let it stand as verified/suggested. This catches an example code that
    // reached a paid rung via a path the pre-gate missed (e.g. a future rung added ahead of the gate,
    // or a non-blocklisted example the model itself names as a "test"/"sample" product). It only ever
    // DOWNGRADES to needs_review with an honest reason - never upgrades or blocks a legitimate result.
    if (win && (win.decision.status === "verified" || win.decision.status === "suggested")) {
      const winResult = win.results[0];
      if (isExampleOrTestRow(code, winResult?.productName ?? "", winResult?.brand)) {
        const reason = sanitizeCustomerReason(
          "This looks like an example or test barcode, not a real product. Enter the item manually if needed.",
          { status: "needs_review" },
        );
        win = {
          ...win,
          results: [],
          evidences: [],
          decision: { ...win.decision, status: "needs_review", confidence: 0, reason, exactCodeEvidenceVerifiedByApp: false },
          reasonCode: "no_result",
          reasonText: reason,
        };
      }
    }

    // PAID-VERIFIED CONTRADICTION GUARD (live-proven bug: the salmon/beer regression). A paid rung
    // (goupc/fetchv2/gpt) SELF-REPORTS "verified" for an identity; independently, the retail corpus
    // (retailHit, looked up above) may hold its OWN row for this exact code. When the two CONTRADICT -
    // different brand/name, reusing the same structural comparator (crossCheck) every other
    // cross-provider check in this pipeline already uses - a paid "verified" claim must NEVER survive
    // unchallenged: it downgrades to "conflict" with an honest, customer-safe reason naming the
    // disagreement. An AGREEING retail row (or no retail row at all) changes nothing - this guard only
    // ever downgrades, never upgrades or blocks an otherwise-clean verify.
    //
    // REVIEW FINDING FIX: a retailHit with a GARBAGE productName (barcode-site search-results title,
    // scrape error title, run-on junk, etc.) must be ignored here exactly like the rung-0 settle above
    // ignores it (isUsableProductName gate, ~line 528) - otherwise a poisoned retail row with junk text
    // but a plausible-but-wrong brand can structurally "disagree" via crossCheck and wrongly downgrade a
    // legitimate paid verify to needs_review/conflict (recall-only risk, but the pilot's core is tires).
    //
    // QA HARDENING FIX #5: a retailHit that is itself an example/test row (isExampleOrTestRow) must be
    // ignored the same way - a fake "Test Shopidoo"/"Healthyholics" example row must never be allowed to
    // downgrade a legitimate paid verify into a false conflict.
    if (
      win &&
      win.decision.status === "verified" &&
      retailHit &&
      isUsableProductName(retailHit.productName) &&
      !isExampleOrTestRow(code, retailHit.productName, retailHit.brand)
    ) {
      const retailAsResult: AiLookupResult = { ...emptyResult(), productName: retailHit.productName, brand: retailHit.brand };
      const paidResult = win.results[0];
      const cc = paidResult ? crossCheck(paidResult, retailAsResult) : null;
      if (cc && cc.decision === "conflict") {
        const reason = `The retail product database disagrees with this result (${cc.contradictions.join("; ")}). Routed to human review.`;
        win = {
          ...win,
          decision: {
            ...win.decision,
            status: "conflict",
            reason,
            crossCheck: cc,
          },
          reasonCode: "needs_review",
          reasonText: reason,
        };
      }
    }

    // receiptState: only a GPT rung that genuinely ran + came back empty earns a permanent receipt.
    receiptState = gptLadderResult ? classifyReceipt(gptLadderResult) : { eligible: false };

    // Assemble the response. A settled rung supplies its payload verbatim; an all-miss ladder falls back
    // to the stashed Plan D floor/suggestion (TASK T8b) so the user experience for a genuinely
    // unfindable code is unchanged; a Plan D stash always records its own attempt in providerStatuses so
    // debug shows both what Plan D found AND what the ladder did with it.
    if (win) {
      // BUG #14 (QA hardening 2026-07-16): every settled rung's reason (upcitemdb/openfoodfacts/go-upc/
      // fetchv2/gpt) is raw, internal, provider-shaped text - sanitize BOTH the top-level reasonText and
      // decision.reason (the two fields the client actually renders) before they leave the server. The
      // raw per-rung chain still survives untouched in debug.ladderReasons for platform diagnosis.
      const cleanReasonText = sanitizeCustomerReason(win.reasonText, { status: win.decision.status });
      const cleanDecision = { ...win.decision, reason: sanitizeCustomerReason(win.decision.reason, { status: win.decision.status }) };
      return {
        mode: "decode" as const,
        providerNames: planDStash ? [...planDStash.providerNames, ...win.providerNames] : win.providerNames,
        results: win.results,
        evidences: win.evidences,
        providerStatuses: planDProviderStatusForStash ? [planDProviderStatusForStash, ...win.providerStatuses] : win.providerStatuses,
        decision: cleanDecision,
        reasonCode: win.reasonCode,
        reasonText: cleanReasonText,
        timedOut: false,
        debug: {
          providersAttempted: planDStash ? [...planDStash.providerNames, ...win.providerNames] : win.providerNames,
          evidenceStrengths: win.evidences.map((e) => e.strength),
          sourceCounts: win.results.map((r) => (r.sourceUrls ?? []).length),
          corroborationPath: win.decision.corroborationPath ?? ladderRun.settledBy,
          ladderPath: ladderRun.settledBy,
          ladderReasons: ladderRun.reasons,
          aiCalled: planDAiCalled || ladderRun.settledBy === "gpt",
          pageFetched: ladderRun.settledBy === "fetchv2",
          cached: false,
          gptLadderSkipReason: gptSkipReason(),
          retailLookup: retailLookupStatus,
        },
        sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
      };
    }

    // ALL RUNGS MISSED. If Plan D had already stashed a floor/suggestion, fall back to it exactly as
    // before the T8b fix (unchanged user experience for a genuinely unfindable public barcode), merging
    // the ladder's per-rung miss reasons into the reason text/providerStatuses/debug so nothing is
    // silent. Otherwise (non-public code, or Plan D itself found nothing to stash) emit the plain
    // needs_review whose reason lists every rung that came back empty (owner: never silent).
    // BUG #14 (QA hardening 2026-07-16): allMissReason names every rung by its internal name and joins
    // each rung's raw miss reason (provider names, internal skip-reason codes like "gpt_call_failed").
    // It stays RAW here for debug.ladderReasons (below) and for building the merged customer text, but
    // the value that actually reaches reasonText/decision.reason is always the SANITIZED one.
    const allMissReason = `No rung resolved the code. ${ladderRun.reasons.map((r) => `${r.rung}: ${r.reason}`).join("; ")}`;
    const cleanAllMissReason = sanitizeCustomerReason(allMissReason);
    if (planDStash) {
      const mergedReasonText = `${planDStash.reasonText || planDStash.decision.reason || "Unresolved"}. ${allMissReason}`;
      const cleanMergedReasonText = sanitizeCustomerReason(mergedReasonText, { status: planDStash.decision.status });
      return {
        ...planDStash,
        reasonText: cleanMergedReasonText,
        decision: { ...planDStash.decision, reason: cleanMergedReasonText },
        providerStatuses: [...planDStash.providerStatuses, ...ladderProviderStatuses],
        timedOut: false,
        debug: {
          ...planDStash.debug,
          ladderPath: "none",
          ladderReasons: ladderRun.reasons,
          aiCalled: planDAiCalled || ladderRun.reasons.some((r) => r.rung === "gpt"),
          pageFetched: ladderRun.reasons.some((r) => r.rung === "fetchv2"),
          cached: false,
          gptLadderSkipReason: gptSkipReason(),
          retailLookup: retailLookupStatus,
        },
        sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
      };
    }
    const nrDecision = decideDecode({ codeType, results: [], evidences: [], confidenceThreshold: threshold, code, scanContext: req.scanContext, brandPrefixConflict: false, allowNonPublicAutoCount });
    // P1 (owner "never fully unknown"): when the GS1 company prefix maps to a known brand, this plain
    // all-miss arm (reached by a non-public code, or a public code where Plan D's resolveUnknownFast
    // threw) still names the row "<Brand> / product unconfirmed" instead of leaving it bare. It is a
    // naming aid ONLY - confidence 0.3, needsHumanReview true, empty sourceUrls, NEVER verified. The
    // decision stays needs_review and the reason keeps the full all-miss chain (owner: never silent).
    const allMissFloor = prefixFloorName(code, codeType);
    const nrResults: AiLookupResult[] = allMissFloor
      ? [{ ...emptyResult(), productName: allMissFloor.name, brand: allMissFloor.brand, confidence: 0.3, needsHumanReview: true, sourceUrls: [] }]
      : [];
    return {
      mode: "decode" as const,
      providerNames: ladderRun.reasons.map((r) => r.rung),
      results: nrResults,
      evidences: [],
      providerStatuses: ladderProviderStatuses,
      decision: { ...nrDecision, reason: cleanAllMissReason },
      reasonCode: "no_result",
      reasonText: cleanAllMissReason,
      timedOut: false,
      debug: {
        providersAttempted: ladderRun.reasons.map((r) => r.rung),
        evidenceStrengths: [],
        sourceCounts: [],
        ladderPath: "none",
        ladderReasons: ladderRun.reasons,
        aiCalled: ladderRun.reasons.some((r) => r.rung === "gpt"),
        pageFetched: ladderRun.reasons.some((r) => r.rung === "fetchv2"),
        cached: false,
        gptLadderSkipReason: gptSkipReason(),
        retailLookup: retailLookupStatus,
      },
      sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
    };
  };

  const hasUsable = (p: Awaited<ReturnType<typeof computeDecode>>) => p.results.some((r) => isUsableProductName(r.productName));
  let payload: Awaited<ReturnType<typeof computeDecode>>;
  let cached: boolean;
  // AM-5/AM-6 reconciliation: a request that JOINED another in-flight computation (L3 coalescing,
  // decodeCache.ts) never ran its own compute - the winner's compute already appends its own ledger
  // row. Appending again here would double-count one underlying decode as N ledger rows for N
  // concurrent callers. `joined` is undefined for e2eMode/every non-coalesced path (real cache hit,
  // fresh compute), so the ledger append below still fires exactly as before for those.
  let joinedInFlight = false;
  try {
    const outcome = e2eMode()
      ? { value: await computeDecode(), cached: false }
      : await withDecodeCache(cacheKey, hasUsable, computeDecode, { forceRefresh: forceRetry });
    payload = outcome.value;
    cached = outcome.cached;
    joinedInFlight = !!(outcome as { joined?: true }).joined;
  } catch (e) {
    // Daily cap blocked the paid ladder (see DailyCapExceededError above): every free stage already
    // ran and found nothing, so this is a genuine paid-work block, not a free-hit false block. Nothing
    // was cached (the throw happens before withDecodeCache's setDecodeCache call) - the next request
    // for this code retries from scratch, which is correct once the cap resets.
    if (e instanceof DailyCapExceededError) {
      // P2 (owner "never fully unknown"): the $0 prefix floor must survive a cap block so the client can
      // still name the row "<Brand> / product unconfirmed" instead of a bare "Unidentified item". Null
      // when the code isn't a public barcode or the prefix maps to no confident brand (unchanged behavior).
      const floor = prefixFloorName(code, codeType) ?? undefined;
      // A4: the cap blocked every paid rung before it could run - settledBy is null and there is no
      // per-rung reason chain (the block happened BEFORE the paid ladder was ever built), so this is
      // recorded distinctly as status "cap_blocked" (never conflated with a genuine all-miss).
      appendDecodeOutcome({ settledBy: null, status: "cap_blocked", reasons: [], sourceTier: null });
      return { kind: "cap_blocked", message: e.message, floor };
    }
    throw e;
  }

  // A4 outcome ledger (AM-5): the route choke point, now that `payload`/`cached` are both known --
  // this is the ONE place that sees every settled-decode exit (Plan D verified early return, an
  // escalation/free-ladder win, a full paid-ladder win, and a total all-rung miss all funnel through
  // computeDecode into `payload` here). A genuine cache replay (L1 memory hit or L2 persisted read via
  // a fresh `withDecodeCache` call that found a cache entry) is recorded with its status prefixed
  // "cached:" so a replay is distinguishable from a fresh compute in the rollup. A request that instead
  // JOINED another in-flight computation (L3 coalescing) is WINNER-ONLY per AM-5/AM-6: it never ran
  // its own compute, so its ledger append is suppressed entirely here - the original (winning) caller's
  // own pass through this same code path already appended the one true row for this decode.
  if (!joinedInFlight) {
    const ladderPath = (payload.debug as Record<string, unknown>).ladderPath as string | undefined;
    const ladderReasons = ((payload.debug as Record<string, unknown>).ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
    const status = payload.decision.status;
    appendDecodeOutcome({
      settledBy: ladderPath && ladderPath !== "none" ? ladderPath : null,
      status: cached ? `cached:${status}` : status,
      reasons: ladderReasons,
      sourceTier: classifySourceTier(payload.reasonCode, payload.providerNames),
    });
  }

  // L2 WRITE-THROUGH (Task 4; IMPORTANT 3 review fix; extended by the PAY-ONCE rule, owner 2026-07-14):
  // only on a genuinely fresh compute (cached === false) - a repeat served straight from L1 must never
  // re-persist. Never touches the store under E2E. verified/suggested -> permanent "result" ONLY when
  // classifySourceTier says the outcome came from a PAID stage (a later decode of this code then
  // replays it with zero provider work, in ANY serverless instance, not just this one); a free-rung win
  // (tire corpus / Turso retail / Plan D) is intentionally left UNPERSISTED so a future corpus/index
  // correction is never masked by a stale permanent cache entry.
  //
  // PAY-ONCE nuance: a Go-UPC/Fetch V2 SUGGESTION (e.g. goupc_inferred) is ALSO paid work - the call
  // already happened and was already charged - even though decideDecode leaves it at status
  // "needs_review" rather than "suggested". So a paid_rung outcome persists on ANY status, as long as
  // it carries a usable identity (isUsableProductName), not just on "verified"/"suggested". It replays
  // as the same suggestion next time; forceRetry still overrides. Free-rung needs_review outcomes are
  // NOT covered by this branch (sourceTier is null for them), so they still never persist.
  //
  // A genuinely exhausted ladder (classifyReceipt, tracked in receiptState from whichever exit ran the
  // ladder) -> permanent "no_result_receipt". Anything else (needs_review from a transient skip, or a
  // conflict, with no paid-rung identity) is left untouched - it stays retryable exactly like today's
  // short-TTL L1 miss cache. forceRetry's fresh compute overwrites whatever was there (persistDecode is
  // an upsert by code).
  if (!e2eMode() && !cached) {
    const status = payload.decision.status;
    const sourceTier = classifySourceTier(payload.reasonCode, payload.providerNames);
    const hasUsableIdentity = payload.results.some((r) => isUsableProductName(r.productName));
    if (status === "verified" || status === "suggested") {
      if (sourceTier) {
        await persistDecode({ code: cacheKey, kind: "result", payload: JSON.stringify(payload), tier: status, sourceTier, createdAt: Date.now() });
      }
    } else if (sourceTier === "paid_rung" && hasUsableIdentity) {
      // A paid_rung suggestion that never reached "verified"/"suggested" status (e.g. goupc_inferred
      // stays "needs_review") - still paid work, still persists, tier records the true status.
      await persistDecode({ code: cacheKey, kind: "result", payload: JSON.stringify(payload), tier: status, sourceTier, createdAt: Date.now() });
    } else if (receiptState.eligible) {
      await persistDecode({ code: cacheKey, kind: "no_result_receipt", payload: JSON.stringify(payload), tier: receiptState.reason ?? "unknown", createdAt: Date.now() });
    }
  }

  // TASK 21 (owner-ratified 2026-07-15): LEARNED-PRODUCTS WRITE. Fire-and-forget, best-effort - a
  // learned-tier write failure must never affect the scan response (same posture as the A4 outcome
  // ledger). Only on a genuinely FRESH compute (never a cache replay, never a joined in-flight
  // request, never under E2E) and only when the full shouldLearnDecode gate passes: verified status +
  // app-verified exact code + fetched_source strength + a trusted product host + the barcode's own
  // GS1 prefix POSITIVELY CORROBORATING the decoded brand (never merely "no conflict") + (for tires)
  // the required tire specs. A joined in-flight waiter never writes here - the winning caller's own
  // pass through this same code path already would have (winner-only, same rule as the ledger above).
  if (!e2eMode() && !cached && !joinedInFlight && payload.decision.status === "verified") {
    const winningResult = payload.results[0];
    const winningSourceUrl = payload.decision.evidenceStrength === "fetched_source" ? (winningResult?.sourceUrls ?? [])[0] ?? "" : "";
    if (winningResult && winningSourceUrl) {
      const gateInput = {
        code: cacheKey,
        status: payload.decision.status,
        exactCodeEvidenceVerifiedByApp: payload.decision.exactCodeEvidenceVerifiedByApp,
        evidenceStrength: payload.decision.evidenceStrength,
        sourceUrl: winningSourceUrl,
        brand: winningResult.brand,
        category: winningResult.category,
        productName: winningResult.productName,
        specsShort: winningResult.specsShort,
        specsFull: winningResult.specsFull,
      };
      if (shouldLearnDecode(gateInput)) {
        void (async () => {
          try {
            await upsertLearnedProduct({
              code: cacheKey,
              name: winningResult.productName,
              brand: winningResult.brand,
              category: winningResult.category,
              specsShort: winningResult.specsShort,
              specsFull: winningResult.specsFull,
              confidence: payload.decision.confidence,
              sourceUrl: winningSourceUrl,
              evidenceStrength: payload.decision.evidenceStrength,
              prefixCheck: prefixCheckNote(cacheKey, winningResult.brand),
              createdAt: new Date().toISOString(),
            });
          } catch {
            /* learned-tier write is best-effort */
          }
        })();
      }
    }
  }

  return { kind: "computed", payload, cached };
}
