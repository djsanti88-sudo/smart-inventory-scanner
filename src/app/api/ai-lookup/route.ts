import type { AiLookupResult } from "@/types";
import { type AiProvider, emptyResult } from "@/services/ai/provider";
import { mockProvider } from "@/services/ai/mockProvider";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import { createOpenAiProvider } from "@/services/ai/openaiProvider";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/services/codeTypeDetector";
import { formatGs1Hint } from "@/services/gs1Prefixes";
import { killSwitchOn, checkRateLimit, readDailyUsed, chargeDailySlot, intEnv, getGptLadderStatus } from "@/services/security/aiSpendGuard";
import { GPT_LADDER_WORST_CASE_USD, type GptFromScratchResult } from "@/services/ai/gptFromScratch";
import { goUpcUsage } from "@/server/upc/goUpcUsage";
import { ladderStorage } from "@/server/upc/storage";
// PURE EXTRACTION (Task 2.4): the whole decode pipeline (computeDecode, the ladder rung runners, the
// cap/breaker gating and the L1/L2 cache write-through) now lives in @/server/decode/pipeline. This
// route keeps only HTTP concerns: request parsing, the abuse/mock-mode guards, response shaping, the
// legacy 'lookup' back-compat path, and the GET status endpoint. e2eMode is shared from the pipeline.
import { runDecodePipeline, e2eMode } from "@/server/decode/pipeline";

// FAST-FIRST: cheap/fast models do the first pass (+ page-fetch). The slow PRO models are only used
// to escalate when the fast pass found no product. All overridable via env. (Reported by GET only;
// decode itself no longer calls Gemini - the pipeline runs corpus -> Go-UPC -> Fetch V2 -> GPT.)
const GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-flash-latest";
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-5-mini";
const GEMINI_DECODE_MODEL = process.env.GEMINI_DECODE_MODEL || "gemini-2.5-pro"; // pro escalation
const OPENAI_DECODE_MODEL = process.env.OPENAI_DECODE_MODEL || "gpt-5"; // pro escalation

// Server-side AI endpoint. Keys live in env and never reach the client. Two modes:
//   - "lookup": single-provider suggestion (back-compat).
//   - "decode": delegates to runDecodePipeline (the APP independently verifies the exact code in each
//     rung's evidence and returns a DecodeDecision; the model's own exactCodeEvidence claim is NOT
//     used to decide truth).
//
// TEST SAFETY: when IS_E2E=1 (set by the Playwright webServer) real providers are NEVER called -
// only the local mock - so automated runs cannot burn live tokens. Live providers run only in
// normal/manual use with a key present (the "manual / LIVE_AI_TEST" path).

export const dynamic = "force-dynamic";

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
  // Task 1 (v2 daily cap): read-only peek at today's atomic, storage-backed usage - makes NO writes
  // (readDailyUsed never increments), so this GET never inflates the counter it is reporting on.
  const dailyLimit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
  const dailyUsed = await readDailyUsed(await ladderStorage());
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
    dailyLimit: dailyLimit,
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
    // Task 1 (v2 daily cap): exposes the SAME atomic, storage-backed counter the route gates and
    // the paid-rung charge site use - a read-only peek, never incremented by this GET.
    daily: { used: dailyUsed, limit: dailyLimit },
    // Task 8: the real decode ladder order (MASTER BASELINE v1) so Settings can stop implying
    // Gemini participates in decode. Gemini fields above (geminiEnabled/geminiConfigured/
    // geminiModel) are kept as-is - Settings and refreshAiStatus still read them - but decode
    // itself never calls Gemini; it is corpus -> Go-UPC -> Fetch V2 -> GPT only.
    decodeLadder: ["corpus", "go_upc", "fetch_v2", "gpt"],
    geminiUsedForDecode: false,
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
  //
  // v2 (Task 1): READ-ONLY gate. The legacy 'lookup' mode has no separate ladder - the single paid
  // provider call happens right after this block (see "lookup mode" below) - so this IS the first (and
  // only) paid rung for that mode, and chargeDailySlot fires here, once, only when the gate passes. A
  // request that is blocked here never charges (the old counter's bug: it incremented on rejects too).
  const isDecodeMode = body.mode === "decode" || body.mode === "decode-deep";
  const forceRetry = body.forceRetry === true;
  if (!e2eMode() && !isDecodeMode) {
    const ladderStore = await ladderStorage();
    const used = await readDailyUsed(ladderStore);
    const limit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
    if (used >= limit) {
      return Response.json(
        { error: `Daily AI lookup cap reached (${used}/${limit}). No AI call made.`, reasonCode: "daily_cap" },
        { status: 429 }
      );
    }
    await chargeDailySlot(ladderStore, { limit });
  }

  if (isDecodeMode) {
    const threshold = body.confidenceThreshold ?? 0.8;
    // Option 3 (owner): non-public codes auto-verify from a single trusted source unless explicitly disabled.
    const allowNonPublicAutoCount = body.autoCountNonPublicWithEvidence !== false;

    // DECODE PIPELINE (Task 2.4): the entire cost-ordered ladder + cache/cap machinery lives in
    // @/server/decode/pipeline now. This handler only parses/sanitizes the request and shapes the
    // pipeline's settled result into an HTTP response - behavior is byte-for-byte what it was inline.
    const outcome = await runDecodePipeline({
      code,
      codeType,
      rawCodeSanitized,
      cleanCodeSanitized,
      threshold,
      allowNonPublicAutoCount,
      forceRetry,
      scanContext: body.scanContext,
      mockGptLadder: body.mockGptLadder,
    });
    if (outcome.kind === "persisted") {
      return Response.json(outcome.body);
    }
    if (outcome.kind === "cap_blocked") {
      // Daily cap blocked the paid ladder: same 429 daily_cap shape the route has always returned, now
      // carrying the $0 prefix floor (P2) when the GS1 prefix knows the company, so the client names the
      // row "<Brand> / product unconfirmed" instead of a bare "Unidentified item". Absent (undefined)
      // when the code isn't a public barcode or the prefix maps to no confident brand - unchanged there.
      return Response.json({ error: outcome.message, reasonCode: "daily_cap", floor: outcome.floor }, { status: 429 });
    }
    // computed: echo the L1/L2 `cached` flag into debug exactly as before.
    return Response.json({ ...outcome.payload, debug: { ...outcome.payload.debug, cached: outcome.cached } });
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

