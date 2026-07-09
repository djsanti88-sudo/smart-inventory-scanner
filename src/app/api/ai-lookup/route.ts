import type { AiLookupResult, EvidenceResult, DecodeDecision } from "@/types";
import { type AiProvider, emptyResult } from "@/services/ai/provider";
import { mockProvider } from "@/services/ai/mockProvider";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import { createOpenAiProvider } from "@/services/ai/openaiProvider";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/services/codeTypeDetector";
import { formatGs1Hint } from "@/services/gs1Prefixes";
import { type ProviderStatus } from "@/services/ai/decodeOrchestrator";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { firecrawlScrapeCheap, searchIdentifyByBarcode, firecrawlKeysFromEnv } from "@/services/ai/firecrawlProvider";
import { lookupBarcodeDb } from "@/server/retail-knowledge/barcodeDbProvider";
import { groundIdentify, getLastGroundingStatus } from "@/services/ai/flashLiteGrounding";
import { verifyCodeOnPage } from "@/services/ai/verifyCodeOnPage";
import { resolveUnknownFast } from "@/services/ai/parallelResolve";
import { prefixFloorName } from "@/services/catalog/prefixFloor";
import { decodeReasonCode, REASON_TEXT } from "@/services/ai/decodeFallback";
import { withDecodeCache, getDecodeCache } from "@/services/ai/decodeCache";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { lookupPrefix, candidateKnownPrefixes } from "@/services/catalog/prefixIndex";
import { evaluatePrefixFirewall } from "@/services/catalog/prefixFirewall";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { killSwitchOn, checkRateLimit, checkAndIncrementDaily, intEnv, checkGptLadderBudget, recordGptLadderSpend, recordGptLadderCall, getGptLadderStatus } from "@/services/security/aiSpendGuard";
import { gptFromScratch, type GptFromScratchResult, GPT_LADDER_WORST_CASE_USD } from "@/services/ai/gptFromScratch";
import { shouldRunGptRung, gptResultToDecodePayload } from "@/services/ai/gptLadderRung";
import { getPersistedDecode, persistDecode, type PersistedDecode } from "@/server/decodeCacheStore";
import { goUpcUsage } from "@/server/upc/goUpcUsage";
import { ladderStorage } from "@/server/upc/storage";
import { goUpcRung, makeDefaultPrefixLookup } from "@/server/upc/GoUpcProvider";
import { goUpcLookup } from "@/services/upc/goUpcClient";
import { GoUpcGate } from "@/services/upc/goUpcThrottle";
import tirePrefixMap from "@/services/catalog/tirePrefixMap.generated.json";
import { fetchV2, type FetchV2Deps, type FetchedPage } from "@/services/fetchV2/index";
import { FetchV2Cache } from "@/services/fetchV2/cache";
import { braveProvider, firecrawlSearchProvider, type DiscoveryProvider, type MinimalFetch } from "@/services/fetchV2/sources/discovery";
import { brocadeLookup } from "@/services/fetchV2/sources/brocade";
import { selectBarcodeUrls } from "@/services/ai/barcodeSources";
import { isSafePublicUrl } from "@/services/ai/urlSafety";
import { runLadder, buildLadderRungs, type RungOutcome } from "@/server/upc/ladder";

// NOTE (spec v6): the legacy deep-fallback budget constants (FALLBACK_*, FIRECRAWL_MAX_SCRAPE,
// FIRECRAWL_ENABLED) and the synchronous DECODE_BUDGET_MS clamp were removed with the legacy
// Gemini/OpenAI fast-path + deep-fallback stage. Fetch V2 owns its own time budget (FETCHV2_MAX_TOTAL_MS).

// FAST-FIRST: cheap/fast models do the first pass (+ page-fetch). The slow PRO models are only used
// to escalate when the fast pass found no product. All overridable via env.
const GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-flash-latest";
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-5-mini";
const GEMINI_DECODE_MODEL = process.env.GEMINI_DECODE_MODEL || "gemini-2.5-pro"; // pro escalation
const OPENAI_DECODE_MODEL = process.env.OPENAI_DECODE_MODEL || "gpt-5"; // pro escalation

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

// NOTE (spec v6): TRUSTED_HOSTS (the url_only trust allowlist for the legacy runDecode orchestrator)
// was removed with that stage. Fetch V2 owns its own source scoring/junk gates; Go-UPC is a
// deterministic keyed API (not url_only). Restore here if a future rung needs a url_only allowlist.

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

// NOTE (spec v6, 2026-07-08): the legacy decode-path provider builders (decodeProviders /
// escalationProviders) and the page-reader factory (pageReader) are DELETED. The decode ladder is
// now Go-UPC -> Fetch V2 -> GPT-5.5 (see the POST handler); Gemini is out of decode entirely. The
// legacy `lookup` mode still uses createGeminiProvider via selectProvider/lookupChain (back-compat).

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
  // Task 16: Go-UPC monthly quota visibility for the Settings panel. canSpend() only READS the usage
  // counter (no record()), so this GET spends nothing. Booleans + numbers ONLY - never the key value.
  // ladderStorage() selects Turso in production (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set), else the
  // file adapter next to .go-upc-usage.json (process.cwd()) for local dev + preview.
  const goUpcConfigured = Boolean(process.env.GO_UPC_API_KEY);
  const goUpcSpend = await goUpcUsage(await ladderStorage()).canSpend();
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
    goUpc: {
      configured: goUpcConfigured,
      used: goUpcSpend.used,
      limit: goUpcSpend.limit,
      warn: goUpcSpend.warn,
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
    const threshold = body.confidenceThreshold ?? 0.8;
    // Option 3 (owner): non-public codes auto-verify from a single trusted source unless explicitly disabled.
    const allowNonPublicAutoCount = body.autoCountNonPublicWithEvidence !== false;

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
        const mock = normalizeMockGptLadder(body.mockGptLadder);
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

          // GPT-5.5 LADDER RUNG (Task 3b): Plan D is TERMINAL for public barcodes - its generic
          // "Unidentified item" floor still ends unresolved (needs_review), so the paid rung must run
          // HERE or it can never see a real upc/ean/gtin. A GPT identity (verified or suggested)
          // REPLACES the unresolved floor, exactly as returned (owner order 2026-07-06: no firewall
          // cap, no info_only burial). A verified/suggested Plan D outcome skips the rung (not surfaced).
          const ladder = await maybeGptLadder({ priorStatus: decision.status });
          if (ladder.payload) {
            pdResults = [ladder.payload.result, ...pdResults];
            pdEvidences = [gptLadderEvidenceStub(), ...pdEvidences];
            pdProviderNames = [...pdProviderNames, "gpt-5.5-ladder"];
            decision = ladder.payload.decision;
            pdReasonCode = "gpt_ladder";
            pdReasonText = ladder.payload.reasonText;
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
            debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled || pdReasonCode === "gpt_ladder", pageFetched: false, cached: false, groundingStatus: getLastGroundingStatus(), retailLookup: retailLookupStatus, gptLadderSkipReason },
            sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
          };
        }
      }

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
        const decision = decideDecode({ codeType, results: [result], evidences: [evidence], confidenceThreshold: threshold, code, scanContext: body.scanContext, brandPrefixConflict: fw.conflict, allowNonPublicAutoCount });
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

      const rungs = buildLadderRungs(code, { runGoUpc, runFetchV2, runGpt });
      const ladderRun = await runLadder(code, rungs);
      const win = ladderRun.outcome?.payload as LadderPayload | undefined;

      // receiptState: only a GPT rung that genuinely ran + came back empty earns a permanent receipt.
      receiptState = gptLadderResult ? classifyReceipt(gptLadderResult) : { eligible: false };

      // Assemble the response. A settled rung supplies its payload verbatim; an all-miss ladder emits a
      // needs_review decision whose reason lists every rung that came back empty (owner: never silent).
      if (win) {
        return {
          mode: "decode" as const,
          providerNames: win.providerNames,
          results: win.results,
          evidences: win.evidences,
          providerStatuses: win.providerStatuses,
          decision: win.decision,
          reasonCode: win.reasonCode,
          reasonText: win.reasonText,
          timedOut: false,
          debug: {
            providersAttempted: win.providerNames,
            evidenceStrengths: win.evidences.map((e) => e.strength),
            sourceCounts: win.results.map((r) => (r.sourceUrls ?? []).length),
            corroborationPath: win.decision.corroborationPath ?? ladderRun.settledBy,
            ladderPath: ladderRun.settledBy,
            ladderReasons: ladderRun.reasons,
            aiCalled: ladderRun.settledBy === "gpt",
            pageFetched: ladderRun.settledBy === "fetchv2",
            cached: false,
            gptLadderSkipReason: gptSkipReason(),
            retailLookup: retailLookupStatus,
          },
          sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
        };
      }

      // ALL RUNGS MISSED -> Needs Review with the accumulated per-rung reasons.
      const allMissReason = `No rung resolved the code. ${ladderRun.reasons.map((r) => `${r.rung}: ${r.reason}`).join("; ")}`;
      const nrDecision = decideDecode({ codeType, results: [], evidences: [], confidenceThreshold: threshold, code, scanContext: body.scanContext, brandPrefixConflict: false, allowNonPublicAutoCount });
      return {
        mode: "decode" as const,
        providerNames: ladderRun.reasons.map((r) => r.rung),
        results: [],
        evidences: [],
        providerStatuses: ladderProviderStatuses,
        decision: { ...nrDecision, reason: allMissReason },
        reasonCode: "no_result",
        reasonText: allMissReason,
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
