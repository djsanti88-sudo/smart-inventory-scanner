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
import { clampDecodeBudgetMs } from "@/services/ai/decodeBudget";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/services/auth/authMode";
import { clampConfidenceThreshold } from "@/services/security/decodePolicy";
import { readDailyUsedForAccount, chargeDailySlotForAccount } from "@/services/security/aiSpendGuard";
import { buildMasterCatalogEntry, appendMasterCatalogEntry } from "@/server/catalog/masterAppend";
import { logServerEvent } from "@/server/log";

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
export const runtime = "nodejs"; // Admin SDK requires the Node runtime (same as resolve-scan/route.ts:25)

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

// P5b Task 2 (master-truth write hook, GC7/GC8): shared helper fired ONLY on a FRESH compute
// (`kind:"computed"`) that carries a settled DecodeDecision passing the Task-1 trust gate. FIX 4
// (review MEDIUM): a PERSISTED/L2-replay hit (`kind:"persisted"`) NEVER fires this hook - a cached
// payload may have been written under a looser historical verify gate, so replaying it to master
// would be both a trust hole and a per-request transaction storm; pre-P5b cache rows are exactly the
// untrusted class this excludes. Also NEVER fired on `kind:"cap_blocked"` (no decision was ever
// settled). Fire-and-forget: never awaited into the HTTP response, never lets a rejection escape
// (masterAppend.ts already swallows its own errors into "error"; this helper also wraps its entire
// body in try/catch as a second, cheap safety net against a synchronous throw - GC7/review MEDIUM).
// Skipped under e2eMode()/IS_E2E (GC7) and behind a default-ON feature flag so a single env var can
// kill the whole write path without a deploy.
function maybeAppendMasterCatalogEntry(payloadLike: {
  sanitizedInput?: { cleanCodeSanitized?: string; rawCodeSanitized?: string };
  decision?: { status?: string; exactCodeEvidenceVerifiedByApp?: boolean; confidence?: number };
  results?: Array<{ productName?: string; brand?: string; category?: string }>;
}, fallbackCode: string, codeType: string): void {
  // FIX 3 (review MEDIUM, sync-throw): the ENTIRE body runs inside try/catch, not just the async
  // appendMasterCatalogEntry().catch() tail - a synchronous throw in buildMasterCatalogEntry (a plain
  // function call, never awaited) would otherwise propagate straight into the POST handler and break
  // the HTTP response for what is meant to be a fire-and-forget side effect.
  try {
    if (e2eMode()) return;
    if (process.env.MASTER_CATALOG_APPEND === "0") return;
    const decision = payloadLike.decision;
    if (!decision) return;
    const normalizedBarcode = payloadLike.sanitizedInput?.cleanCodeSanitized || fallbackCode;
    const winningResult = payloadLike.results?.[0];
    const entry = buildMasterCatalogEntry({
      normalizedBarcode,
      codeType,
      decision: {
        status: decision.status ?? "",
        exactCodeEvidenceVerifiedByApp: decision.exactCodeEvidenceVerifiedByApp,
        confidence: decision.confidence,
      },
      identity: {
        name: winningResult?.productName,
        brand: winningResult?.brand,
        category: winningResult?.category,
      },
    });
    if (!entry) return;
    void appendMasterCatalogEntry(entry).catch(() => {
      /* GC7: an append failure must never affect the decode response */
    });
  } catch {
    // Never let a synchronous failure in this fire-and-forget side effect break the decode response.
    console.error("maybeAppendMasterCatalogEntry: synchronous failure swallowed");
  }
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
    // B1: durable, storage-backed rate limiting (LadderStorage - Turso in production, so a
    // multi-instance deployment shares one real counter instead of each instance's own in-memory bucket).
    //
    // FINDING C (P6 fix wave): wrapped fail-open so a storage INIT throw (`await ladderStorage()` itself
    // rejecting) never turns the status endpoint into a raw 500 - it logs rate_limit_unavailable and falls
    // through unthrottled, matching the export route's pattern and the POST handler below.
    try {
      const rl = await checkRateLimit(`GET:${ip}`, { limit: intEnv(process.env.AI_LOOKUP_GET_RATE_LIMIT, 120), storage: await ladderStorage() });
      if (!rl.allowed) {
        logServerEvent({ route: "/api/ai-lookup", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
        return Response.json(
          { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
        );
      }
    } catch {
      logServerEvent({ route: "/api/ai-lookup", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
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
  // B1: reads through the same durable LadderStorage seam as the daily cap / rate limit.
  const gptLadderStatus = await getGptLadderStatus({ worstCaseUsd: GPT_LADDER_WORST_CASE_USD, storage: await ladderStorage() });
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
      // Infinity is not JSON-serializable (JSON.stringify -> null), so an unlimited (subscription) cap
      // is reported as limit:null + unlimited:true; a configured numeric cap reports the number.
      limit: Number.isFinite(goUpcSpend.limit) ? goUpcSpend.limit : null,
      unlimited: !Number.isFinite(goUpcSpend.limit),
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
      logServerEvent({ route: "/api/ai-lookup", event: "kill_switch", reasonCode: "kill_switch", status: 503 });
      return Response.json({ error: "AI lookup is temporarily disabled.", reasonCode: "kill_switch" }, { status: 503 });
    }
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "local";
    // B1: durable, storage-backed rate limiting - see the GET handler's comment above.
    //
    // FINDING C (P6 fix wave): the whole rate-limit block is wrapped so a storage INIT throw (e.g.
    // Turso/libsql unreachable) never crashes the request into a raw 500 - it logs rate_limit_unavailable
    // and falls through WITHOUT rate limiting instead, mirroring the export route's now-standard fail-open
    // pattern (src/app/api/account/export/route.ts). checkRateLimit already fails open on a storage error
    // once storage is in hand; this closes the remaining hole where `await ladderStorage()` ITSELF throws
    // before checkRateLimit is even called. A storage hiccup must never take the whole app down.
    try {
      const rl = await checkRateLimit(clientIp, { storage: await ladderStorage() });
      if (!rl.allowed) {
        logServerEvent({ route: "/api/ai-lookup", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
        return Response.json(
          { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
        );
      }
    } catch {
      logServerEvent({ route: "/api/ai-lookup", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
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
    // D4 (live-mode auth): the caller's Firebase ID token + the businessId they claim membership in.
    // Ignored entirely in mock mode (today's open-demo behavior is unchanged).
    idToken?: string;
    businessId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // LIVE-MODE AUTH (D4). In mock mode this whole block is skipped, so the open-demo behavior and every
  // existing test are unchanged. In live mode the caller must present a verified Firebase ID token and a
  // businessId they are a member of - identical pattern to resolve-scan/route.ts. ORDERING CONTRACT
  // (locked by route.d4.test.ts): this gate completes BEFORE any quota read or charge, global or
  // per-account - a 401/403 request must never touch a counter key.
  let authedBusinessId: string | null = null;
  if (isLiveAuth() && !e2eMode()) {
    const idToken = (body as { idToken?: string }).idToken ?? "";
    const bizId = (body as { businessId?: string }).businessId ?? "";
    if (!idToken.trim()) {
      return Response.json({ error: "Sign in required.", reasonCode: "unauthenticated" }, { status: 401 });
    }
    if (!bizId.trim()) {
      return Response.json({ error: "Missing businessId.", reasonCode: "no_business" }, { status: 400 });
    }
    let uid = "";
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
        return Response.json({ error: "Server auth is not configured.", reasonCode: "auth_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "Invalid or expired sign-in.", reasonCode: "bad_token" }, { status: 401 });
    }
    const member = await getAdminDb().doc(`${COLLECTIONS.businessMembers}/${memberDocId(bizId, uid)}`).get();
    if (!member.exists) {
      return Response.json({ error: "Not a member of this business.", reasonCode: "not_member" }, { status: 403 });
    }
    authedBusinessId = bizId;
  }

  // Defense in depth: sanitize again on the server before anything reaches a provider.
  const rawCodeSanitized = sanitizeForAiLookup(body.rawCode ?? "").clean;
  const cleanCodeSanitized = sanitizeForAiLookup(body.cleanCode ?? "").clean;
  const code = cleanCodeSanitized || rawCodeSanitized;
  // D4: never trust the client's codeType. Always recompute from the sanitized code server-side.
  const codeType = detectCodeType(code);
  // W3 (v1.0.0): app-derived GS1 numbering-authority region hint for PUBLIC barcodes (null otherwise).
  // NON-AUTHORITATIVE prompt context only - it never changes resolver truth, alias approval, auto-count,
  // or evidence thresholds, and is never placed in untrusted scraped text.
  const gs1RegionHint = formatGs1Hint(code, codeType) ?? undefined;
  // D4 (full surface): scanContext and autoCountNonPublicWithEvidence are DECISION inputs, not hints.
  // scanContext === "tire" unlocks three extra auto-verify paths in decideDecode (decode.ts:285/304/323)
  // and allowNonPublicAutoCount unlocks nonPublicTrustedVerified (decode.ts:269) - the ladder-1225
  // hallucinated-auto-count class. LIVE mode: server policy decides, the client's values are ignored
  // (AI_LIVE_SCAN_CONTEXT=tire opts a deployment into the tire context; default "any" unlocks nothing;
  // AI_ALLOW_NONPUBLIC_AUTOCOUNT=1 opts into non-public auto-count; default off). MOCK mode: the client
  // hint is honored exactly as today (validated to the known set), so the demo substrate is unchanged.
  const SCAN_CONTEXTS = new Set(["any", "tire"]);
  const clientScanContext =
    typeof body.scanContext === "string" && SCAN_CONTEXTS.has(body.scanContext)
      ? (body.scanContext as "any" | "tire")
      : undefined;
  const scanContext: "any" | "tire" | undefined =
    isLiveAuth() && !e2eMode()
      ? (process.env.AI_LIVE_SCAN_CONTEXT === "tire" ? "tire" : "any")
      : clientScanContext;
  const allowNonPublicAutoCount =
    isLiveAuth() && !e2eMode()
      ? process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT === "1"
      : body.autoCountNonPublicWithEvidence !== false;
  const req = {
    rawCodeSanitized,
    cleanCodeSanitized,
    allowImageSuggestions: body.allowImageSuggestions ?? false,
    gs1RegionHint,
    scanContext,
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
  //
  // GC-A (P6 Task A2, tenant-starvation fix): for AUTHED traffic the PER-ACCOUNT cap is the primary
  // gate and is checked/charged FIRST - a tenant with remaining account budget must never be 429'd
  // because ANOTHER tenant (or anonymous demo traffic) drained the shared global bucket. The "global"
  // check for authed traffic is only a high platform-wide BACKSTOP (AI_LOOKUP_GLOBAL_BACKSTOP, default
  // AI_LOOKUP_DAILY_LIMIT*10) - a last-resort circuit breaker, not the primary gate. Anonymous traffic
  // (no authedBusinessId) has no per-account bucket at all, so it keeps today's behavior unchanged:
  // gated by the plain AI_LOOKUP_DAILY_LIMIT global cap. L12 unchanged: exactly one global charge +
  // one account charge per genuine paid compute, only after every applicable check passes.
  const isDecodeMode = body.mode === "decode" || body.mode === "decode-deep";
  const forceRetry = body.forceRetry === true;
  if (!e2eMode() && !isDecodeMode) {
    const ladderStore = await ladderStorage();
    const limit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
    if (authedBusinessId) {
      // Per-account cap FIRST (primary gate for authed traffic).
      const acctUsed = await readDailyUsedForAccount(ladderStore, authedBusinessId);
      const acctLimit = intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, limit);
      if (acctUsed >= acctLimit) {
        logServerEvent({
          route: "/api/ai-lookup",
          event: "cap_blocked",
          reasonCode: "account_daily_cap",
          businessId: authedBusinessId,
          status: 429,
        });
        return Response.json(
          { error: `Your daily AI lookup cap is reached (${acctUsed}/${acctLimit}).`, reasonCode: "account_daily_cap" },
          { status: 429 }
        );
      }
      // Platform-wide BACKSTOP, not the per-tenant-fair gate - sized well above the normal global cap
      // so one heavy tenant (or a burst of anonymous traffic) cannot starve another tenant that still
      // has account budget remaining.
      const backstop = intEnv(process.env.AI_LOOKUP_GLOBAL_BACKSTOP, limit * 10);
      const used = await readDailyUsed(ladderStore);
      if (used >= backstop) {
        logServerEvent({
          route: "/api/ai-lookup",
          event: "cap_blocked",
          reasonCode: "daily_cap",
          businessId: authedBusinessId,
          status: 429,
        });
        return Response.json(
          { error: `Daily AI lookup cap reached (${used}/${backstop}). No AI call made.`, reasonCode: "daily_cap" },
          { status: 429 }
        );
      }
      await chargeDailySlot(ladderStore, { limit: backstop });
      await chargeDailySlotForAccount(ladderStore, authedBusinessId);
    } else {
      // Anonymous/unauthenticated traffic: unchanged behavior, gated by the plain global cap.
      const used = await readDailyUsed(ladderStore);
      if (used >= limit) {
        logServerEvent({ route: "/api/ai-lookup", event: "cap_blocked", reasonCode: "daily_cap", status: 429 });
        return Response.json(
          { error: `Daily AI lookup cap reached (${used}/${limit}). No AI call made.`, reasonCode: "daily_cap" },
          { status: 429 }
        );
      }
      await chargeDailySlot(ladderStore, { limit });
    }
  }

  if (isDecodeMode) {
    const threshold = clampConfidenceThreshold(body.confidenceThreshold);

    // GC-A (P6 Task A2): per-account decode cap is the TENANT GATE, checked here before the pipeline
    // runs. Read-only gate (the pipeline owns the single global charge). The account counter is
    // charged below ONLY when the pipeline reports a genuine paid compute. When this gate passes for
    // an authed tenant, accountCapCleared is threaded into the pipeline so its OWN internal global cap
    // gate compares against the high platform-wide BACKSTOP instead of the plain daily limit - the
    // pipeline must never independently 429 an authed tenant who is under their own account limit.
    // Anonymous/uncleared requests keep today's behavior byte-identical (accountCapCleared stays false,
    // the pipeline's internal gate uses the plain AI_LOOKUP_DAILY_LIMIT exactly as before).
    let accountCapCleared = false;
    if (authedBusinessId && !e2eMode()) {
      const ladderStore = await ladderStorage();
      const acctUsed = await readDailyUsedForAccount(ladderStore, authedBusinessId);
      const acctLimit = intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500));
      if (acctUsed >= acctLimit) {
        logServerEvent({
          route: "/api/ai-lookup",
          event: "cap_blocked",
          reasonCode: "account_daily_cap",
          businessId: authedBusinessId,
          status: 429,
        });
        return Response.json(
          { error: `Your daily AI lookup cap is reached (${acctUsed}/${acctLimit}).`, reasonCode: "account_daily_cap" },
          { status: 429 }
        );
      }
      accountCapCleared = true;
    }

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
      scanContext,
      mockGptLadder: body.mockGptLadder,
      // Server-side clamp (review hardening 2026-07-15): the client already clamps, but a hand-crafted
      // request must not be able to stretch the ladder deadline via a huge budgetMs.
      budgetMs: typeof body.budgetMs === "number" ? clampDecodeBudgetMs(body.budgetMs) : undefined,
      // GC-A: undefined for anonymous traffic (pipeline default behavior unchanged); set for authed
      // traffic once the per-account gate above has run (accountCapCleared reflects the gate's outcome).
      capContext: authedBusinessId ? { authedBusinessId, accountCapCleared } : undefined,
    });
    if (outcome.kind === "persisted") {
      // FIX 4 (review MEDIUM, stale-verified replay + transaction storm): NEVER appends here. A cached/
      // L2-replay payload may have been written under a LOOSER historical verify gate than the current
      // one - replaying it to the master catalog on every cache hit is a trust hole (an old, weaker
      // "verified" gets minted into master truth today) and a per-request transaction storm (every
      // repeat scan of a cached code would re-run the idempotent-but-not-free transactional upsert).
      // Only the fresh `computed` branch below appends - a fresh compute is exactly the point where the
      // CURRENT verify gate was applied, so it is the only outcome kind trusted to write master.
      return Response.json(outcome.body);
    }
    if (outcome.kind === "cap_blocked") {
      // Daily cap blocked the paid ladder: same 429 daily_cap shape the route has always returned, now
      // carrying the $0 prefix floor (P2) when the GS1 prefix knows the company, so the client names the
      // row "<Brand> / product unconfirmed" instead of a bare "Unidentified item". Absent (undefined)
      // when the code isn't a public barcode or the prefix maps to no confident brand - unchanged there.
      // NEVER fires the master-append hook here (GC7/review F4): no decision was ever settled.
      logServerEvent({
        route: "/api/ai-lookup",
        event: "cap_blocked",
        reasonCode: "daily_cap",
        businessId: authedBusinessId ?? undefined,
        status: 429,
      });
      return Response.json({ error: outcome.message, reasonCode: "daily_cap", floor: outcome.floor }, { status: 429 });
    }
    // computed: echo the L1/L2 `cached` flag into debug exactly as before. FINDING B (P6 fix wave): the
    // per-account charge USED to happen here, gated on outcome.paidComputeCharged, AFTER the pipeline
    // returned cleanly. That left the global and account counters out of sync whenever a paid rung threw
    // after the global charge. The per-account charge now fires INSIDE chargePaidSlot (pipeline.ts),
    // right after the global charge, so the two always move together and stay exception-consistent. This
    // route no longer post-charges the account - the pipeline owns BOTH charges at one site (L12 intact).
    // P5b Task 2: fresh-compute branch - the other qualifying outcome (fresh AND persisted replay).
    maybeAppendMasterCatalogEntry(outcome.payload, code, codeType);
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

  if (errors.length) {
    logServerEvent({
      route: "/api/ai-lookup",
      event: "provider_error",
      reasonCode: "lookup_provider_error",
      detail: `${errors.length} provider(s) failed in lookup chain`,
    });
  }

  return Response.json({
    mode: "lookup",
    providerName: usedProvider,
    result,
    notes: errors.length ? errors : undefined,
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  });
}

