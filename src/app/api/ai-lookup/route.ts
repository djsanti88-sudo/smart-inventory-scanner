import type { AiLookupResult, EvidenceResult } from "@/types";
import { type AiProvider, emptyResult } from "@/services/ai/provider";
import { mockProvider } from "@/services/ai/mockProvider";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import { createOpenAiProvider } from "@/services/ai/openaiProvider";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/services/codeTypeDetector";
import { formatGs1Hint } from "@/services/gs1Prefixes";
import { enrichWithPageFetch } from "@/services/ai/pageFetch";
import { runDecode, type DecodeProvider, type ProviderStatus } from "@/services/ai/decodeOrchestrator";
import { clampDecodeBudgetMs } from "@/services/ai/decodeBudget";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { discoverViaFirecrawl, firecrawlScrapeCheap, searchIdentifyByBarcode } from "@/services/ai/firecrawlProvider";
import { lookupBarcodeDb } from "@/server/retail-knowledge/barcodeDbProvider";
import { groundIdentify, getLastGroundingStatus } from "@/services/ai/flashLiteGrounding";
import { verifyCodeOnPage } from "@/services/ai/verifyCodeOnPage";
import { resolveUnknownFast } from "@/services/ai/parallelResolve";
import { prefixFloorName } from "@/services/catalog/prefixFloor";
import { filterSafeUrls } from "@/services/ai/urlSafety";
import { shouldRunFallback, decodeReasonCode, REASON_TEXT } from "@/services/ai/decodeFallback";
import { raceFinders, type Finder } from "@/services/ai/fallbackRunner";
import { withDecodeCache, getDecodeCache } from "@/services/ai/decodeCache";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { lookupPrefix, recordLearnedPrefix, candidateKnownPrefixes } from "@/services/catalog/prefixIndex";
import { evaluatePrefixFirewall } from "@/services/catalog/prefixFirewall";
import { isLearnablePrefix } from "@/services/catalog/prefixLearning";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { groundedSpecFind } from "@/services/ai/groundedSpecFinder";
import { runSizeRace } from "@/services/ai/sizeRace";
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { killSwitchOn, checkRateLimit, checkAndIncrementDaily, intEnv, checkGptLadderBudget, recordGptLadderSpend, recordGptLadderCall, getGptLadderStatus } from "@/services/security/aiSpendGuard";
import { gptFromScratch, type GptFromScratchResult, GPT_LADDER_WORST_CASE_USD } from "@/services/ai/gptFromScratch";
import { shouldRunGptRung, gptResultToDecodePayload, capTierForFirewall } from "@/services/ai/gptLadderRung";
import { getPersistedDecode, persistDecode, type PersistedDecode } from "@/server/decodeCacheStore";

// Separate budgets (owner rule): the fast path stays fast; only a hard-failed barcode gets the deep,
// parallel fallback. Each value is env-overridable.
// Background deep fallback (mode "decode-deep" ONLY) caps. Owner cost rule: keep the whole deep search
// <= ~15s (was 30s) so it can't run away on tokens. The synchronous live scan NEVER runs this fallback.
const FALLBACK_AI_TIMEOUT_MS = Number(process.env.FALLBACK_AI_TIMEOUT_MS || 12_000); // grounded AI re-run
const FALLBACK_HARD_CAP_MS = Number(process.env.FALLBACK_HARD_CAP_MS || 15_000); // whole-fallback ceiling
const FALLBACK_PAGE_TIMEOUT_MS = Number(process.env.FALLBACK_PAGE_TIMEOUT_MS || 10_000);
const FIRECRAWL_MAX_SCRAPE = Number(process.env.FIRECRAWL_MAX_SCRAPE || 6);
// Firecrawl open-web fallback is OFF by default: it currently errors instantly (wasting a reserved
// credit + a finder slot); we lean on free Gemini grounding instead. Set ENABLE_FIRECRAWL=1 to re-enable.
const FIRECRAWL_ENABLED = process.env.ENABLE_FIRECRAWL === "1";

// Owner cost rule: the SYNCHRONOUS live decode (what the user waits on every scan) defaults to an 8s
// budget and is clamped to a hard 8s ceiling (clampDecodeBudgetMs / DECODE_BUDGET_MAX_MS).
const DECODE_BUDGET_MS = Number(process.env.DECODE_BUDGET_MS || 8_000);

// FAST-FIRST: cheap/fast models do the first pass (+ page-fetch). The slow PRO models are only used
// to escalate when the fast pass found no product. All overridable via env.
const GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-flash-latest";
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-5-mini";
const GEMINI_DECODE_MODEL = process.env.GEMINI_DECODE_MODEL || "gemini-2.5-pro"; // pro escalation
const OPENAI_DECODE_MODEL = process.env.OPENAI_DECODE_MODEL || "gpt-5"; // pro escalation

// Server-side AI endpoint. Keys live in env and never reach the client. Two modes:
//   - "lookup": single-provider suggestion (back-compat).
//   - "decode": calls up to two providers, the APP independently verifies the exact code in each
//     provider's evidence (snippets/grounding/url), cross-checks the providers, and returns a
//     DecodeDecision. The model's own exactCodeEvidence claim is NOT used to decide truth.
//
// TEST SAFETY: when IS_E2E=1 (set by the Playwright webServer) real providers are NEVER called -
// only the local mock - so automated runs cannot burn live tokens. Live providers run only in
// normal/manual use with a key present (the "manual / LIVE_AI_TEST" path).

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

export const dynamic = "force-dynamic";

// url-only evidence (the exact code appears ONLY in a source URL, never confirmed in page text) is
// trusted ONLY from these authoritative GS1 registries. Deliberately NOT expanded to crowd barcode DBs
// (upcitemdb / go-upc / barcodespider / barcodelookup): those build the URL FROM the scanned code
// (/upc/<code>, /search?q=<code>) and serve a page for ANY code - even unregistered/not-found ones - so
// "the code is in the URL" there carries ZERO evidentiary value and would make every scan look "verified",
// defeating the evidence gate. Trust for those hosts must come from fetched_source instead: the app opens
// the candidate page, confirms the exact code in the REAL page text, and rejects "product not found" pages
// (see enrichWithPageFetch + looksLikeNotFound). gs1.org/gtin.info only return a page when a GTIN is
// actually registered, so url_only from them is sound.
// OPTION 3 (owner): trusted hosts where a url_only match (the exact code appears in the URL) counts as
// app-verified. GS1 registries + the major barcode databases + the big online retailers - per owner "Gemini
// found the code on Amazon = that's all it takes for Sam's/Walmart/an online retailer". A url_only match
// from ANY OTHER host stays weak (-> Suggested, not Verified). The brand-prefix firewall + 0.8 + the
// non-public setting still gate every auto-count, so a wrong host can never alone force a count.
const TRUSTED_HOSTS = [
  "gs1.org", "gtin.info",
  // barcode databases
  "go-upc.com", "upcitemdb.com", "barcodelookup.com", "barcodespider.com", "eandata.com", "ean-search.org", "buycott.com",
  // major online retailers
  "amazon.com", "walmart.com", "samsclub.com", "target.com", "costco.com", "bestbuy.com", "homedepot.com",
  "lowes.com", "kroger.com", "ebay.com", "chewy.com", "wayfair.com",
];

function e2eMode(): boolean {
  return process.env.IS_E2E === "1";
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
function classifySourceTier(reasonCode: string, providerNames: string[]): "paid_ai" | "gpt_ladder" | null {
  if (reasonCode === "gpt_ladder") return "gpt_ladder";
  if (providerNames.some((n) => PAID_AI_PROVIDER_MARKERS.has(n))) return "paid_ai";
  return null;
}

/** Fill in the full GptFromScratchResult shape from a Playwright test-fixture body (E2E only). */
function normalizeMockGptLadder(raw: Partial<GptFromScratchResult> | undefined): GptFromScratchResult | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    tier: raw.tier ?? "none",
    brand: raw.brand ?? "",
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

function selectProvider(name: string): AiProvider {
  switch (name) {
    case "gemini":
      return createGeminiProvider();
    case "openai":
      return createOpenAiProvider();
    default:
      return mockProvider;
  }
}

function lookupChain(primary: string): AiProvider[] {
  if (e2eMode()) return [mockProvider];
  const order = primary === "gemini" ? ["gemini", "openai"] : primary === "openai" ? ["openai", "gemini"] : [];
  const chain = order.map(selectProvider);
  chain.push(mockProvider);
  return chain;
}

function decodeProviders(pro = false): AiProvider[] {
  if (e2eMode()) return [mockProvider];
  const chain: AiProvider[] = [];
  // OWNER BASELINE (v1): Gemini Flash runs the FAST first pass ALONE - the loved 1-2s decode. ChatGPT
  // (OpenAI) is NOT run in parallel; it is the ESCALATION (escalationProviders) called ONLY when Gemini's
  // fast pass finds nothing. The pro path (proRecheck correction) still uses both strongest models.
  if (process.env.GEMINI_API_KEY) chain.push(createGeminiProvider({ model: pro ? GEMINI_DECODE_MODEL : GEMINI_FAST_MODEL }));
  if (pro && process.env.OPENAI_API_KEY) chain.push(createOpenAiProvider({ model: OPENAI_DECODE_MODEL }));
  if (chain.length === 0) chain.push(mockProvider);
  return chain;
}

// ESCALATION pass: runs ONLY when the Gemini fast pass found no usable product (the ~1-2/20 Gemini
// whiffs). ChatGPT mini first (owner-chosen GPT-5 mini fallback), then a Gemini retry in the longer
// window. A single verified hit here auto-counts under the same any-source rule. Sequential, not parallel:
// a normal Gemini hit never spends an OpenAI call.
function escalationProviders(): AiProvider[] {
  if (e2eMode()) return [mockProvider];
  const chain: AiProvider[] = [];
  if (process.env.OPENAI_API_KEY) chain.push(createOpenAiProvider({ model: OPENAI_FAST_MODEL }));
  if (process.env.GEMINI_API_KEY) chain.push(createGeminiProvider({ model: GEMINI_FAST_MODEL }));
  if (chain.length === 0) chain.push(mockProvider);
  return chain;
}

// Reading fetched page text is easy work - use a FAST model so a decode isn't minutes long.
const OPENAI_READ_MODEL = process.env.OPENAI_READ_MODEL || "gpt-5-mini";

/** Read fetched page text with a model (no web search - it just reads the text we hand it). */
function pageReader(): ((pageText: string, code: string) => Promise<Partial<AiLookupResult>>) | undefined {
  if (e2eMode()) return undefined;
  const provider = process.env.OPENAI_API_KEY
    ? createOpenAiProvider({ model: OPENAI_READ_MODEL, disableSearch: true, label: "openai:read" })
    : process.env.GEMINI_API_KEY
      ? createGeminiProvider({ model: GEMINI_FAST_MODEL, disableSearch: true, label: "gemini:read" })
      : null;
  if (!provider) return undefined;
  return async (pageText: string, code: string, signal?: AbortSignal) => {
    const ctx = `Text fetched from product/barcode pages for code ${code}:\n${pageText.slice(0, 16000)}`;
    return provider.lookup({ rawCodeSanitized: code, cleanCodeSanitized: code, contextSanitized: ctx }, signal);
  };
}

// GET reports which keys/flags are configured. NO secrets are returned (booleans + names only),
// so the client can decide whether to auto-decode and show exactly which keys are missing.
export async function GET(request: Request) {
  // Lightweight per-IP rate limit so the public status endpoint cannot be scraped or flooded unthrottled.
  // It returns only booleans + model names (no secrets), but an unbounded GET is still a cheap DoS / config-
  // scrape vector. Generous default for legit client polling; SEPARATE bucket from POST (GET: prefix) so the
  // two never interfere. Skipped under E2E mock mode, matching the POST guards.
  if (!e2eMode()) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "local";
    const rl = checkRateLimit(`GET:${ip}`, { limit: intEnv(process.env.AI_LOOKUP_GET_RATE_LIMIT, 120) });
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }
  }
  const geminiConfigured = !!process.env.GEMINI_API_KEY;
  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  // firecrawlConfigured gates the Stage-2 open-web fallback. Absent is NOT a blocker (decode still
  // works via barcode DBs + AI-cited URLs); the client just knows open-web discovery is unavailable.
  const firecrawlConfigured = !!process.env.FIRECRAWL_API_KEY;
  const missingKeys: string[] = [];
  if (!geminiConfigured) missingKeys.push("GEMINI_API_KEY");
  if (!openaiConfigured) missingKeys.push("OPENAI_API_KEY");
  if (!firecrawlConfigured) missingKeys.push("FIRECRAWL_API_KEY");
  // Task 6: read-only GPT ladder spend/call status for the Settings panel. getGptLadderStatus makes
  // no writes and spends nothing (it composes checkGptLadderBudget's peek + the call-count peek).
  const gptLadderStatus = getGptLadderStatus({ worstCaseUsd: GPT_LADDER_WORST_CASE_USD });
  return Response.json({
    liveEnabled: process.env.ENABLE_LIVE_AI_LOOKUP !== "false",
    autoDecodeOnScan: process.env.ENABLE_AUTO_DECODE_ON_SCAN !== "false",
    geminiEnabled: process.env.ENABLE_GEMINI_LOOKUP !== "false",
    openaiEnabled: process.env.ENABLE_OPENAI_LOOKUP !== "false",
    geminiConfigured,
    openaiConfigured,
    firecrawlConfigured,
    openWebFallback: firecrawlConfigured,
    geminiSearchGrounding: process.env.ENABLE_GEMINI_SEARCH_GROUNDING !== "false",
    openaiWebSearch: process.env.ENABLE_OPENAI_WEB_SEARCH !== "false",
    geminiModel: GEMINI_FAST_MODEL,
    openaiModel: OPENAI_FAST_MODEL,
    geminiProModel: GEMINI_DECODE_MODEL,
    openaiProModel: OPENAI_DECODE_MODEL,
    pageFetchAndRead: true,
    premiumFallback: process.env.ENABLE_PREMIUM_MODEL_FALLBACK !== "false",
    mode: process.env.AI_LOOKUP_MODE || "aggressive",
    dailyLimit: Number(process.env.AI_LOOKUP_DAILY_LIMIT || 200),
    missingKeys,
    e2e: e2eMode(),
    gptLadder: {
      spentTodayUsd: gptLadderStatus.spentUsd,
      capUsd: gptLadderStatus.capUsd,
      callsToday: gptLadderStatus.calls,
      enabled: openaiConfigured && gptLadderStatus.allowed,
    },
  });
}

export async function POST(request: Request) {
  // Server-side abuse + spend guard (auth DEFERRED by owner). Bounds bill-drain without login:
  // kill switch (503) and per-IP rate limit (429) here; the hard daily cap is checked at the decode
  // path below. Each control makes ZERO provider calls when it blocks. Local-first state; a deployed
  // multi-instance setup needs a shared store (see services/security/aiSpendGuard.ts). Inert under E2E
  // mock mode (no real provider spend to bound), so deterministic test runs are unaffected.
  if (!e2eMode()) {
    if (killSwitchOn()) {
      return Response.json({ error: "AI lookup is temporarily disabled.", reasonCode: "kill_switch" }, { status: 503 });
    }
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "local";
    const rl = checkRateLimit(clientIp);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }
  }

  let body: {
    rawCode?: string;
    cleanCode?: string;
    codeType?: string;
    mode?: "lookup" | "decode" | "decode-deep";
    deep?: boolean; // Task 5: client opt-in to the synchronous deep/Firecrawl decode (off the tire hot path)
    provider?: string;
    allowImageSuggestions?: boolean;
    confidenceThreshold?: number;
    budgetMs?: number;
    proRecheck?: boolean; // correction-only: use the strongest configured Gemini verification model
    scanContext?: "any" | "tire"; // Phase 8B: app-derived, non-authoritative prompt hint
    brandPrefixHint?: string; // Phase 8B: unambiguous learned brand-prefix hint (non-authoritative)
    autoCountNonPublicWithEvidence?: boolean; // Option 3 (owner): allow a non-public code (SKU/vendor/FNSKU) to auto-verify from a single trusted source. Default true.
    // Playwright test hook ONLY: under IS_E2E, a request carrying this fixture runs the GPT ladder
    // rung's mapping logic with ZERO network so E2E can prove the rung's UI/decision wiring
    // deterministically. Ignored entirely outside E2E.
    mockGptLadder?: Partial<GptFromScratchResult>;
    // Task 4 (owner manual override): bypasses a permanent no_result_receipt AND overwrites it once the
    // fresh compute finishes. Also forces a fresh compute past the in-memory L1 cache (forceRefresh).
    forceRetry?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Defense in depth: sanitize again on the server before anything reaches a provider.
  const rawCodeSanitized = sanitizeForAiLookup(body.rawCode ?? "").clean;
  const cleanCodeSanitized = sanitizeForAiLookup(body.cleanCode ?? "").clean;
  const code = cleanCodeSanitized || rawCodeSanitized;
  const codeType = (body.codeType as ReturnType<typeof detectCodeType>) || detectCodeType(code);
  // W3 (v1.0.0): app-derived GS1 numbering-authority region hint for PUBLIC barcodes (null otherwise).
  // NON-AUTHORITATIVE prompt context only - it never changes resolver truth, alias approval, auto-count,
  // or evidence thresholds, and is never placed in untrusted scraped text.
  const gs1RegionHint = formatGs1Hint(code, codeType) ?? undefined;
  const req = {
    rawCodeSanitized,
    cleanCodeSanitized,
    allowImageSuggestions: body.allowImageSuggestions ?? false,
    gs1RegionHint,
    scanContext: body.scanContext,
    brandPrefixHint: body.brandPrefixHint,
  };

  // Hard server-side daily spend cap (auth DEFERRED) for the LEGACY lookup path. The decode modes run
  // their own cap check below (after the decode-cache peek) so a zero-spend cached repeat scan never
  // consumes a cap slot - checking here for decode too would double-count every decode POST (each scan
  // burned 2 slots; regression tests in route.test.ts). Skipped under E2E mock mode (no real spend).
  const isDecodeMode = body.mode === "decode" || body.mode === "decode-deep";
  const forceRetry = body.forceRetry === true;
  if (!e2eMode() && !isDecodeMode) {
    const cap = checkAndIncrementDaily();
    if (!cap.allowed) {
      return Response.json(
        { error: `Daily AI lookup cap reached (${cap.used}/${cap.limit}). No AI call made.`, reasonCode: "daily_cap" },
        { status: 429 }
      );
    }
  }

  if (isDecodeMode) {
    // Task 4/5: the tire hot path issues NO synchronous deep/Firecrawl call. The deep path stays
    // reachable for the client: it sends mode "decode-deep" (or "decode" with deep:true) to opt INTO
    // the existing multi-stage deep/Firecrawl orchestration and SKIP the tire hot path below.
    const deepRequested = body.mode === "decode-deep" || body.deep === true;
    const threshold = body.confidenceThreshold ?? 0.8;
    // Option 3 (owner): non-public codes auto-verify from a single trusted source unless explicitly disabled.
    const allowNonPublicAutoCount = body.autoCountNonPublicWithEvidence !== false;
    // The budget may be owner-configured and arrives from the client - clamp it server-side so a
    // client can never request an abusive (e.g. 10-minute) decode. Falls back to the env default.
    const budgetMs = clampDecodeBudgetMs(body.budgetMs, DECODE_BUDGET_MS);

    // L2 PERSISTENT DECODE CACHE (Task 4): consulted on an L1 miss, BEFORE the daily cap check below -
    // same guard window as the existing L1 peek, so a persisted "result" OR a permanent
    // "no_result_receipt" never burns a daily slot. Never touched under E2E (tests/Playwright must
    // never read/write the real store) and skipped entirely when the caller asks for forceRetry
    // (owner manual override: bypasses the receipt here, and overwrites it once the fresh compute
    // below finishes - see the write-through at the withDecodeCache call site).
    let persistedHit: PersistedDecode | null = null;
    if (!e2eMode() && !forceRetry && getDecodeCache(code) === undefined) {
      persistedHit = await getPersistedDecode(code);
    }

    // Hard server-side daily spend cap (auth DEFERRED). Checked AFTER both cache peeks: a cached
    // repeat scan (L1 or L2) makes ZERO provider calls, so it must not consume a cap slot nor be
    // blocked once the cap trips (the cap bounds genuine compute runs, not free repeats). The per-IP
    // rate limit above still throttles floods of cached hits. Skipped under E2E mock mode (no real spend).
    // CRITICAL FIX (review): forceRetry ALWAYS burns a slot, even with a warm L1 entry. Before this fix
    // the condition only looked at getDecodeCache(code)/persistedHit, but withDecodeCache below is called
    // with { forceRefresh: forceRetry } which bypasses L1 UNCONDITIONALLY - so a forceRetry with a warm L1
    // entry recomputed (real provider calls) while burning ZERO daily-cap slots. forceRetry must count as
    // "genuinely going to compute" regardless of cache state.
    if (!e2eMode() && (forceRetry || (getDecodeCache(code) === undefined && !persistedHit))) {
      const cap = checkAndIncrementDaily();
      if (!cap.allowed) {
        return Response.json(
          { error: `Daily AI lookup cap reached (${cap.used}/${cap.limit}). No AI call made.`, reasonCode: "daily_cap" },
          { status: 429 }
        );
      }
    }

    // A persisted hit short-circuits with ZERO provider work: a "result" replays the prior
    // verified/suggested decode; a "no_result_receipt" replays the prior unresolved shape so the
    // ladder is never re-run for a code it has already exhausted (owner rule: no auto-retry - only
    // forceRetry above bypasses this). A corrupted stored payload degrades to a miss (recompute).
    if (persistedHit) {
      let parsedPayload: Record<string, unknown> | null = null;
      try {
        parsedPayload = JSON.parse(persistedHit.payload);
      } catch {
        parsedPayload = null;
      }
      if (parsedPayload) {
        const priorDebug = (parsedPayload.debug as Record<string, unknown> | undefined) ?? {};
        return Response.json({
          ...parsedPayload,
          debug: { ...priorDebug, cached: true, persistedCacheHit: true, persistedKind: persistedHit.kind, persistedTier: persistedHit.tier },
        });
      }
    }

    const reader = pageReader();
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
    const maybeGptLadder = async (opts: {
      priorStatus: string;
      // Firewall conflict for capTierForFirewall, resolved per exit: the final exit passes the
      // request-tracked combined-firewall value; the Plan D exit derives the catalog brand-prefix
      // sanity from the GPT payload's own brand (no combined firewall was evaluated on that path).
      conflictOf: (brand: string) => boolean;
      timedOut?: boolean;
    }): Promise<{ payload: ReturnType<typeof gptResultToDecodePayload>; skipReason?: string; surfaceSkip: boolean }> => {
      if (opts.priorStatus === "verified" || opts.priorStatus === "suggested") {
        return { payload: null, skipReason: "prior_status_already_decided", surfaceSkip: false };
      }
      if (e2eMode()) {
        // Deterministic Playwright hook ONLY (zero network): lets E2E prove the rung's decision/UI
        // wiring without a live OpenAI call. Ignored when the request carries no mockGptLadder fixture.
        const mock = normalizeMockGptLadder(body.mockGptLadder);
        const raw = mock ? gptResultToDecodePayload(mock, code) : null;
        return { payload: raw ? capTierForFirewall(raw, opts.conflictOf(raw.result.brand)) : null, surfaceSkip: false };
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
      const raw = gptResultToDecodePayload(r, code);
      return { payload: raw ? capTierForFirewall(raw, opts.conflictOf(raw.result.brand)) : null, surfaceSkip: false };
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
    // reason - the rung was never short-circuited) or "info_only" (payload present but never auto-count
    // worthy). Every other skip is transient and must NOT create a receipt.
    // DOCTRINE CORRECTION (review, supersedes Task 4's original "budget_exceeded is eligible" rule): a
    // receipt certifies "the ladder was fully probed and every door came back empty." A code blocked by
    // the ladder's OWN dollar budget was NEVER probed at all - it is exactly as unresolved as a missing
    // API key or an e2e run, and the daily budget resets tomorrow. Treating "budget_exceeded" as eligible
    // would permanently freeze every code unlucky enough to arrive right when the daily cap was tight,
    // with no automatic recovery once the cap resets (only a manual forceRetry would ever revisit it).
    // "budget_exceeded" therefore now falls into the same transient/not-eligible bucket as no_api_key,
    // non_public_code_type, e2e_mode, and request_budget_exhausted (all `ladder.surfaceSkip === true`).
    const classifyReceipt = (ladder: { payload: ReturnType<typeof gptResultToDecodePayload>; skipReason?: string; surfaceSkip: boolean }): { eligible: boolean; reason?: string } => {
      if (ladder.payload && (ladder.payload.decision.status === "verified" || ladder.payload.decision.status === "suggested")) {
        return { eligible: false }; // resolved by the ladder itself
      }
      if (ladder.payload) return { eligible: true, reason: "gpt_info_only" }; // ran, tier info_only
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
    const computeDecode = async () => {
      // SERVER-ONLY DETERMINISTIC TIRE KNOWLEDGE FIRST: an EXACT trusted-corpus barcode (or, for SKU-shaped
      // codes, an exact part number) resolves with NO AI call and NO page fetch. A miss returns null and the
      // existing AI/page-fetch path below runs unchanged. The corpus is GROUNDING - the downstream store
      // auto-count gate (firewall + tire specs + brand-prefix + >=0.9) still applies, so a non-tire or a
      // near-match can never auto-count this way. (Human-confirmed business catalog/flywheel still wins
      // first, in the store, before this route is ever called for an unknown code.)
      if (!e2eMode()) {
        const skuShaped = codeType === "alpha_sku" || codeType === "vendor_label";
        const corpus = (await resolveExactBarcode(code)) ?? (skuShaped ? await resolveExactPartNumber(code) : null);
        if (corpus) {
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
      }

      // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
      // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
      // is surfaced in the decode debug payload below (both the hit-return here and the AI-path
      // fallback) so a broken Turso connection ("turso_error") is distinguishable from a genuine
      // corpus miss ("turso_miss") instead of both silently falling through to paid AI decode.
      let retailLookupStatus: string | undefined;
      let retailHit: { productName: string; brand: string } | null = null;
      if (!e2eMode()) {
        const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
        retailHit = await lookupRetailBarcodeAsync(code);
        retailLookupStatus = getLastRetailLookupStatus();
        // The 4M-row Open Food Facts retail DB (Turso) is a FREE structured source. Its data is mostly right
        // but has some WRONG rows (glycine UPC 0737870166917 -> "Coconut oil"), so it is NO LONGER trusted
        // ALONE (that produced wrong Verified identities - the old Fix 5). Instead it is passed into the
        // resolver below as ONE consensus VOTE (the retailDb dep): a wrong OFF row is OUTVOTED by UPCitemdb +
        // grounding, while its millions of correct rows give FREE, instant (~50-160ms) coverage - so most
        // food/retail codes auto-count with no AI and no Firecrawl.
      }

      // PLAN D - GROUNDING-FIRST FAST RESOLVER (flash-lite grounding -> fetch-verify -> barcode-DB fallback).
      // Runs AFTER the free corpus/retail misses and BEFORE the legacy Gemini/OpenAI fast path. One flash-lite
      // grounding call names the product; the APP fetch-verifies the exact code on a candidate page before
      // marking Verified, falling back to the barcode-DB leg, Firecrawl, and the prefix floor on a miss.
      // Gated to PUBLIC barcodes (upc/ean/gtin): a SKU/vendor label must never auto-verify from grounding
      // (semantic firewall - those still route through the legacy path -> Needs Review).
      //
      // TERMINAL for public barcodes (Fix 2, 2026-07-01): whenever the resolver returns ANY result - a
      // VERIFIED win OR the prefix floor / an unverified grounding suggestion - computeDecode RETURNS it
      // and NEVER runs the expensive legacy Gemini/OpenAI fast path (the real money-pit). A verified win
      // auto-counts (like a corpus hit); a floor/suggestion returns as Suggested/Needs Review with NO
      // legacy AI call at all. Only a null return (non-public code, or no floor) falls through to legacy.
      // Never runs under E2E (mock-only).
      const isPublicBarcode = codeType === "upc_a" || codeType === "ean_13" || codeType === "gtin_14";
      if (!e2eMode() && isPublicBarcode) {
        const fast = await resolveUnknownFast(code, {
          lookupBarcodeDb: (c) => lookupBarcodeDb(c),
          retailDb: async () => (retailHit ? { name: retailHit.productName, brand: retailHit.brand } : null),
          groundIdentify: (c, opts) => groundIdentify(c, opts),
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
          let decision = decideDecode({ codeType, results: [result], evidences: [evidence], confidenceThreshold: threshold, code, scanContext: body.scanContext, brandPrefixConflict: false });
          const floorReasonCode = decodeReasonCode({ hasProduct: isUsableProductName(fast.name), fallbackFound: false, timedOut: false, decisionStatus: decision.status, statuses: [], firecrawlKey: !!firecrawlKey, coverageMissed: false });
          const floorReasonText = verifiedWin ? "" : (REASON_TEXT[floorReasonCode] ?? "");
          if (decision.status !== "verified" && floorReasonText) decision = { ...decision, reason: floorReasonText };

          let pdResults: AiLookupResult[] = [result];
          let pdEvidences: EvidenceResult[] = [evidence];
          let pdProviderNames = [`parallel:${fast.source}`];
          let pdProviderStatuses: ProviderStatus[] = [{ provider: `parallel:${fast.source}`, status: "ok" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: verifiedWin, identityFound: isUsableProductName(fast.name) }];
          let pdReasonCode = verifiedWin ? "ok" : floorReasonCode;
          let pdReasonText = floorReasonText;
          let gptLadderSkipReason: string | undefined;
          let gptLadderInfoOnly: string | undefined;

          // GPT-5.5 LADDER RUNG (Task 3b): Plan D is TERMINAL for public barcodes - its generic
          // "Unidentified item" floor still ends unresolved (needs_review), so the paid rung must run
          // HERE or it can never see a real upc/ean/gtin. A verified/suggested GPT identity REPLACES
          // the unresolved floor; an info_only guess leaves the floor result EXACTLY as-is (its floor
          // productName keeps today's caching semantics) and only surfaces the background info in
          // debug. A verified/suggested Plan D outcome skips the rung entirely (not surfaced).
          const ladder = await maybeGptLadder({ priorStatus: decision.status, conflictOf: (b) => prefixBrandConflict(code, b) });
          if (ladder.payload && (ladder.payload.decision.status === "verified" || ladder.payload.decision.status === "suggested")) {
            pdResults = [ladder.payload.result, ...pdResults];
            pdEvidences = [gptLadderEvidenceStub(), ...pdEvidences];
            pdProviderNames = [...pdProviderNames, "gpt-5.5-ladder"];
            decision = ladder.payload.decision;
            pdReasonCode = "gpt_ladder";
            pdReasonText = ladder.payload.reasonText;
          } else if (ladder.payload) {
            // info_only: keep Plan D's result untouched; the guess is debug-only here (Task 3b rule).
            gptLadderInfoOnly = ladder.payload.result.guesses[0] ?? ladder.payload.reasonText;
          } else if (ladder.surfaceSkip) {
            gptLadderSkipReason = ladder.skipReason;
            pdProviderStatuses = [...pdProviderStatuses, gptLadderSkipEntry(ladder.skipReason!)];
          }
          receiptState = classifyReceipt(ladder);

          return {
            mode: "decode" as const,
            providerNames: pdProviderNames,
            results: pdResults,
            evidences: pdEvidences,
            providerStatuses: pdProviderStatuses,
            decision,
            reasonCode: pdReasonCode,
            reasonText: pdReasonText,
            timedOut: false,
            // groundingStatus makes a silent grounding outage (e.g. a model 503) visible in the decode
            // debug instead of consensus quietly degrading to the two correlated DB votes.
            debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled || pdReasonCode === "gpt_ladder", pageFetched: false, cached: false, groundingStatus: getLastGroundingStatus(), retailLookup: retailLookupStatus, gptLadderSkipReason, gptLadderInfoOnly },
            sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
          };
        }
      }

      // PREFIX detection for tire scan context (used by the AI decode path below for brand hints
      // and tire-specific decideDecode). The corpus check above already handles exact barcode hits
      // instantly — corpus misses fall through to the AI decode with the normal 8s budget.
      const prefixMatch = lookupTirePrefix(code);
      const anchorBrand = prefixMatch ? (prefixMatch.brands.find((b) => b.weight === "strong")?.brand ?? null) : null;
      const isTireScan = !!prefixMatch;

      // FAST PATH - CONCURRENT, HARD ~13s BUDGET. Providers + page-fetch race under one budget signal.
      // On timeout the orchestrator aborts everything and returns Needs Review (never a partial).
      const baseProviders = decodeProviders(body.proRecheck === true); // fast = Gemini only; pro = both strongest
      const providers: DecodeProvider[] = baseProviders.map((p) => ({
        name: p.name,
        lookup: (signal) => p.lookup(req, signal),
      }));
      // Escalation providers (ChatGPT mini first) - used ONLY by the on-miss Stage-2 finder below, so a
      // normal Gemini hit never calls OpenAI. proRecheck keeps its strongest-model set.
      const escBase = body.proRecheck === true ? baseProviders : escalationProviders();
      const escProviders: DecodeProvider[] = escBase.map((p) => ({
        name: p.name,
        lookup: (signal) => p.lookup(req, signal),
      }));
      // Phase 9: enable PATH-2 corroboration (page-fetch + one independent model read agree) for tire
      // scans, so an accurate tire whose grounded providers lost the race can still auto-count safely.
      const corroborate = body.scanContext === "tire";
      const enrich = e2eMode()
        ? undefined
        : (signal: AbortSignal) => enrichWithPageFetch({ code, codeType, extract: reader, signal, corroborate });

      // SIZE RACE (PATH 3 setup): run groundedSpecFind (Arm A) concurrently with runDecode (which
      // internally runs enrichWithPageFetch as Arm B). Neither arm is the other - these are genuinely
      // different Internet roads (grounded Gemini search vs barcode-DB page fetch). sizeAgreement is
      // set ONLY from this app-computed race result - NEVER from any provider's self-claim.
      const [run, groundedForRace] = await Promise.all([
        runDecode({ code, codeType, confidenceThreshold: threshold, providers, enrich, budgetMs, trustedHosts: TRUSTED_HOSTS }),
        e2eMode() ? Promise.resolve(null) : groundedSpecFind({ code, codeType, anchorBrand }).catch(() => null),
      ]);

      let results = run.results;
      let evidences = run.evidences;
      let providerNames = run.providerNames;
      let providerStatuses = run.providerStatuses;

      // ESCALATION ON FAST-PATH FAILURE: when Gemini (the only fast-path provider) returns a hard
      // error (rate_limited, error) with zero usable results, immediately run the escalation
      // providers (OpenAI) within the same live request. This preserves the baseline rule "a normal
      // Gemini hit never spends an OpenAI call" while ensuring a dead Gemini (spending cap, outage)
      // doesn't send every scan to Needs Review with no suggestion.
      // Escalation triggers when the fast path produced ZERO usable results: either all providers
      // hard-failed (rate_limited/error), OR the budget timed out before any provider found a product.
      // This ensures a dead/slow Gemini always falls through to OpenAI instead of silently routing
      // to Needs Review with no suggestion.
      const hasUsableResult = results.some((r) => isUsableProductName(r.productName));
      const fastPathFailed = !hasUsableResult
        && providerStatuses.length > 0
        && providerStatuses.every((s) => s.status !== "ok" || !s.identityFound);
      if (fastPathFailed && !e2eMode()) {
        // The escalation budget is INDEPENDENT of the fast-path budget. When the fast path's only
        // provider (Gemini) is dead, we give OpenAI a fresh 20s window — not the leftover from the
        // 8s clamp. This is the only path where a live scan can exceed 8s; it only fires when the
        // primary provider hard-failed (spending cap, outage), never on a normal slow decode.
        const ESCALATION_BUDGET_MS = Number(process.env.ESCALATION_BUDGET_MS || 20_000);
        const escRun = await runDecode({
          code, codeType, confidenceThreshold: threshold,
          providers: escProviders,
          enrich: enrich ? (s) => enrichWithPageFetch({ code, codeType, extract: reader, signal: s, corroborate }) : undefined,
          budgetMs: ESCALATION_BUDGET_MS,
          providerTimeoutMs: ESCALATION_BUDGET_MS - 2_000, // give each provider nearly the full budget
          trustedHosts: TRUSTED_HOSTS,
        });
        results = [...results, ...escRun.results];
        evidences = [...evidences, ...escRun.evidences];
        providerNames = [...providerNames, ...escRun.providerNames];
        providerStatuses = [...providerStatuses, ...escRun.providerStatuses.map((s) => ({ ...s, provider: `esc:${s.provider}` }))];
      }

      // Arm A: grounded search size (from groundedSpecFind run concurrently above).
      const armASize = tireSizeToken(groundedForRace?.result ?? null) || "";
      // Arm B: page-fetch size - the page-fetch path (enrichWithPageFetch) sets fetchedSourceText on
      // the result it produces; look for that first, then fall back to the first available result.
      const pageFetchResult = results.find((r) => r.fetchedSourceText) ?? results[0] ?? null;
      const armBSize = tireSizeToken(pageFetchResult) || "";
      const sizeRace = await runSizeRace({
        armAGetSize: async () => armASize,
        armBGetSize: async () => armBSize,
      });
      // Set sizeAgreement on the first result (the one decideDecode reads as `a`). This is the app's
      // computation - it is NEVER copied from a provider field. Provider self-claims are untrusted.
      if (results.length > 0) results[0] = { ...results[0], sizeAgreement: sizeRace.sizeAgreement };

      // Re-decide with the business scan context + scanned code so a deterministically-corroborated tire
      // (strong brand-prefix family + full specs + app-verified exact code) can auto-count even from a
      // single provider. Same inputs as the orchestrator otherwise; pure + cheap.
      const fw0 = evalCombinedFirewall(code, results[0], evidences);
      let prefixHint = fw0.hint;
      let firewallReason = fw0.reason;
      let brandPrefixAdvisory = fw0.brandPrefixAdvisory; // Plan C: advisory-only, non-blocking (reported, never blocks)
      let brandPrefixConflict = fw0.conflict; // tracked across the fallback winner below - the GPT ladder rung at the end needs the LATEST value
      let decision = decideDecode({ codeType, results, evidences, confidenceThreshold: threshold, code, scanContext: body.scanContext, brandPrefixConflict, allowNonPublicAutoCount });
      let fallbackFound = false;
      let coverageMissed = false;
      let firecrawlCreditsEstimated = 0; // best-effort, for benchmark/cost tracking (0 if Firecrawl never ran)
      let firecrawlCandidates = 0;

      const hasProduct = () => results.some((r) => isUsableProductName(r.productName));
      // Owner cost rule: the SYNCHRONOUS live decode NEVER runs the deep Stage-2 fallback (that was the
      // 30s hang + the token bleed). It runs ONLY for an explicit background "decode-deep" request.
      const eligibleForFallback = deepRequested && shouldRunFallback({ hasProduct: hasProduct(), timedOut: run.timedOut, decisionStatus: decision.status, e2e: e2eMode() });

      // STAGE 2 - DEEP, PARALLEL fallback. Runs ONLY when the fast path found no usable product (so a
      // normal successful scan adds ZERO extra calls). Gemini grounded + OpenAI mini (deep 25s budget)
      // and Firecrawl (6 safe candidates, parallel scrapes) RACE; the first VERIFIED + usable product
      // wins and the losers are aborted. A hard cap bounds the whole thing (no 60s+ chains).
      if (eligibleForFallback) {
        const citedFromFast = filterSafeUrls(results.flatMap((r) => r.sourceUrls ?? []), 4);
        const finders: Finder[] = [];

        // Finder A: deep grounded AI re-run. Reuses the orchestrator (gemini + openai + page-fetch run
        // concurrently) with a longer per-provider timeout and VERIFIED-only early-exit, then reads any
        // URLs the deeper providers cited (the fast pass's providers had timed out before citing any).
        if (reader) {
          finders.push({
            name: "ai-deep",
            run: async (signal) => {
              const deep = await runDecode({
                code, codeType, confidenceThreshold: threshold, providers: escProviders,
                enrich: (s) => enrichWithPageFetch({ code, codeType, extract: reader, signal: s, extraUrls: citedFromFast, corroborate }),
                budgetMs: FALLBACK_AI_TIMEOUT_MS + 5_000,
                providerTimeoutMs: FALLBACK_AI_TIMEOUT_MS,
                pageTimeoutMs: FALLBACK_PAGE_TIMEOUT_MS,
                trustedHosts: TRUSTED_HOSTS,
                requireVerifiedEarlyExit: true,
              });
              providerStatuses = [...providerStatuses, ...deep.providerStatuses.map((s) => ({ ...s, provider: `deep:${s.provider}` }))];
              const i = deep.results.findIndex((r, idx) => isUsableProductName(r.productName) && deep.evidences[idx]?.verified);
              if (i >= 0) return { result: deep.results[i], evidence: deep.evidences[i], providerName: deep.providerNames[i] ?? "ai-deep" };
              const freshCited = filterSafeUrls(deep.results.flatMap((r) => r.sourceUrls ?? []), 4).filter((u) => !citedFromFast.includes(u));
              if (freshCited.length && !signal.aborted) {
                const fb = await enrichWithPageFetch({ code, codeType, extraUrls: freshCited, extract: reader, signal, corroborate });
                if (fb.result && isUsableProductName(fb.result.productName) && fb.evidence.verified) {
                  return { result: fb.result, evidence: fb.evidence, providerName: "ai-cited-deep" };
                }
              }
              return null;
            },
          });
        }

        // Finder B: Firecrawl open-web discovery (6 safe candidates, scraped in PARALLEL). OFF by default
        // (set ENABLE_FIRECRAWL=1) - it currently errors instantly and wastes a reserved credit.
        if (FIRECRAWL_ENABLED && firecrawlKey) {
          const key = firecrawlKey;
          finders.push({
            name: "firecrawl",
            run: async (signal) => {
              // RESERVE worst-case credits up front so the fallback hard-cap can never hide Firecrawl
              // spend from the cost guard (safe to over-count; refined down to actual after it returns).
              firecrawlCreditsEstimated = 1 + FIRECRAWL_MAX_SCRAPE;
              firecrawlCandidates = FIRECRAWL_MAX_SCRAPE;
              const disc = await discoverViaFirecrawl(code, codeType, { apiKey: key, signal }, { maxScrape: FIRECRAWL_MAX_SCRAPE });
              providerStatuses = [...providerStatuses, { provider: "firecrawl", status: disc.status, latencyMs: disc.latencyMs, sourceUrlsReturned: disc.searchCount, exactCodeFound: !!disc.result, identityFound: !!disc.result }];
              firecrawlCandidates = disc.searchCount;
              // Actual credits if the API reported them, else estimate 1 search + 1 per candidate opened.
              firecrawlCreditsEstimated = disc.creditsUsed > 0 ? disc.creditsUsed : 1 + disc.searchCount;
              if (disc.coverageMissed) coverageMissed = true;
              if (disc.result) return { result: disc.result, evidence: disc.evidence, providerName: "firecrawl" };
              return null;
            },
          });
        } else {
          providerStatuses = [...providerStatuses, { provider: "firecrawl", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false }];
        }

        if (finders.length > 0) {
          const outcome = await raceFinders(finders, { hardCapMs: FALLBACK_HARD_CAP_MS });
          if (outcome.hit) {
            // Apply the same app-computed sizeAgreement from the race to the fallback winner before
            // decideDecode so PATH 3 (internetTwoSourceSize) is available here too. sizeAgreement is
            // ONLY set from the race result - never from any provider field.
            const winnerWithSize = { ...outcome.hit.result, sizeAgreement: sizeRace.sizeAgreement };
            results = [winnerWithSize, ...results];
            evidences = [outcome.hit.evidence, ...evidences];
            providerNames = [outcome.hit.providerName, ...providerNames];
            fallbackFound = true;
            // Decide on the WINNER alone so leftover fast-path noise can't manufacture a false conflict.
            const fwW = evalCombinedFirewall(code, winnerWithSize, [outcome.hit.evidence]);
            prefixHint = fwW.hint;
            firewallReason = fwW.reason;
            brandPrefixAdvisory = fwW.brandPrefixAdvisory;
            brandPrefixConflict = fwW.conflict;
            decision = decideDecode({ codeType, results: [winnerWithSize], evidences: [outcome.hit.evidence], confidenceThreshold: threshold, code, scanContext: body.scanContext, brandPrefixConflict, allowNonPublicAutoCount });
          }
        }
      }

      let reasonCode = decodeReasonCode({ hasProduct: hasProduct(), fallbackFound, timedOut: run.timedOut, decisionStatus: decision.status, statuses: providerStatuses, firecrawlKey: !!firecrawlKey, coverageMissed });
      let reasonText = REASON_TEXT[reasonCode] ?? "";
      // Never surface the generic "no provider returned a usable product": prefer the honest reason.
      if (decision.status !== "verified" && reasonText) decision = { ...decision, reason: reasonText };

      // SELF-LEARNING FLYWHEEL: a genuinely verified decode (app-verified exact code, conf >= 0.90, public
      // barcode, real brand) teaches the prefix map so future scans + the firewall get smarter, for $0.
      // In-memory + server-side; gated by isLearnablePrefix; LEARNED is the lowest-precedence prefix tier.
      if (isLearnablePrefix({ status: decision.status, confidence: decision.confidence, exactCodeEvidenceVerifiedByApp: decision.exactCodeEvidenceVerifiedByApp, codeType, brand: results[0]?.brand })) {
        recordLearnedPrefix(code, results[0]!.brand, results[0]?.category);
      }

      // GPT-5.5 LADDER RUNG (owner spec 2026-07-05): the paid END of the decode ladder. Runs ONLY
      // when nothing above already verified or suggested a product - it never runs in parallel with,
      // and never overrides, an earlier win. Every call (success, error, or abort) records its spend
      // via recordGptLadderSpend so the daily dollar guard can never be silently bypassed by a
      // provider failure (usdActual carries the worst-case reservation on abort/HTTP failure). The
      // catalog-derived brand-prefix firewall still gates auto-count: a firewall conflict downgrades
      // an otherwise-verified GPT self-report to suggested (capTierForFirewall), same as every other
      // rung on this ladder.
      // Task 3b: same shared helper as the Plan D exit above. `run.timedOut` additionally skips the
      // paid rung here (the synchronous decode budget is already blown; skip reason surfaced as
      // "request_budget_exhausted"). The e2e mockGptLadder fixture path lives inside the helper.
      // Surfaced in `debug` below, and (except the happy-path "a prior rung already decided" case)
      // also pushed to providerStatuses - a paid rung must never skip silently.
      let gptLadderSkipReason: string | undefined;
      const ladder = await maybeGptLadder({ priorStatus: decision.status, conflictOf: () => brandPrefixConflict, timedOut: run.timedOut });
      const gptLadderPayload = ladder.payload;
      if (!gptLadderPayload) {
        gptLadderSkipReason = ladder.skipReason;
        if (ladder.surfaceSkip) providerStatuses = [...providerStatuses, gptLadderSkipEntry(ladder.skipReason!)];
      }
      if (gptLadderPayload) {
        results = [gptLadderPayload.result, ...results];
        evidences = [gptLadderEvidenceStub(), ...evidences];
        providerNames = [...providerNames, "gpt-5.5-ladder"];
        decision = gptLadderPayload.decision;
        reasonCode = "gpt_ladder";
        reasonText = gptLadderPayload.reasonText;
      }
      receiptState = classifyReceipt(ladder);

      return {
        mode: "decode" as const,
        providerNames,
        results,
        evidences,
        providerStatuses,
        decision,
        reasonCode,
        reasonText,
        timedOut: run.timedOut,
        debug: {
          providersAttempted: providerNames,
          evidenceStrengths: evidences.map((e) => e.strength),
          sourceCounts: results.map((r) => (r.sourceUrls ?? []).length),
          geminiSearchGrounding: process.env.ENABLE_GEMINI_SEARCH_GROUNDING !== "false",
          openaiWebSearch: process.env.ENABLE_OPENAI_WEB_SEARCH !== "false",
          baseModels: [GEMINI_FAST_MODEL, OPENAI_FAST_MODEL],
          latencyMs: run.latencyMs,
          timedOut: run.timedOut,
          budgetMs,
          reasonCode,
          fallbackFound,
          coverageMissed,
          firecrawlCreditsEstimated,
          firecrawlCandidates,
          gptLadderSkipReason, // undefined when the rung ran or wasn't needed (a prior rung already decided)
          cached: false,
          prefixHint, // platformOwner-only: brand the barcode prefix maps to (recall/transparency)
          firewallReason, // platformOwner-only: why a prefix/UPC conflict routed this to review (if any)
          brandPrefixAdvisory, // Plan C: catalog brand-prefix mismatch is ADVISORY (reported, never blocks)
          retailLookup: retailLookupStatus, // "turso_error" (broken connection) vs "turso_miss"/"unavailable" (genuine miss/not configured) — makes a swallowed Turso failure visible instead of silently falling through to this AI path
        },
        sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
      };
    };

    const hasUsable = (p: Awaited<ReturnType<typeof computeDecode>>) => p.results.some((r) => isUsableProductName(r.productName));
    const { value: payload, cached } = e2eMode()
      ? { value: await computeDecode(), cached: false }
      : await withDecodeCache(code, hasUsable, computeDecode, { forceRefresh: forceRetry });

    // L2 WRITE-THROUGH (Task 4; IMPORTANT 3 review fix): only on a genuinely fresh compute
    // (cached === false) - a repeat served straight from L1 must never re-persist. Never touches the
    // store under E2E. verified/suggested -> permanent "result" ONLY when classifySourceTier says the
    // outcome came from a PAID stage (a later decode of this code then replays it with zero provider
    // work, in ANY serverless instance, not just this one); a free-rung win (tire corpus / Turso retail /
    // Plan D) is intentionally left UNPERSISTED so a future corpus/index correction is never masked by a
    // stale permanent cache entry. A genuinely exhausted ladder (classifyReceipt, tracked in receiptState
    // from whichever exit ran the ladder) -> permanent "no_result_receipt". Anything else (needs_review
    // from a transient skip, or a conflict) is left untouched - it stays retryable exactly like today's
    // short-TTL L1 miss cache. forceRetry's fresh compute overwrites whatever was there (persistDecode is
    // an upsert by code).
    if (!e2eMode() && !cached) {
      const status = payload.decision.status;
      if (status === "verified" || status === "suggested") {
        const sourceTier = classifySourceTier(payload.reasonCode, payload.providerNames);
        if (sourceTier) {
          await persistDecode({ code, kind: "result", payload: JSON.stringify(payload), tier: status, sourceTier, createdAt: Date.now() });
        }
      } else if (receiptState.eligible) {
        await persistDecode({ code, kind: "no_result_receipt", payload: JSON.stringify(payload), tier: receiptState.reason ?? "unknown", createdAt: Date.now() });
      }
    }

    return Response.json({ ...payload, debug: { ...payload.debug, cached } });
  }

  // --- lookup mode (single suggestion) ---
  const primary = body.provider || process.env.AI_PROVIDER || "mock";
  const chain = lookupChain(primary);
  let result: AiLookupResult = emptyResult();
  let usedProvider = "none";
  const errors: string[] = [];
  for (const provider of chain) {
    try {
      result = await provider.lookup(req);
      usedProvider = provider.name;
      break;
    } catch (e) {
      errors.push(`${provider.name}: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  return Response.json({
    mode: "lookup",
    providerName: usedProvider,
    result,
    notes: errors.length ? errors : undefined,
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  });
}
