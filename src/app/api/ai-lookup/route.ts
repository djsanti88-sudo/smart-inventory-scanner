import type { AiLookupResult } from "@/types";
import { type AiProvider, emptyResult } from "@/services/ai/provider";
import { mockProvider } from "@/services/ai/mockProvider";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import { createOpenAiProvider } from "@/services/ai/openaiProvider";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/services/codeTypeDetector";
import { enrichWithPageFetch } from "@/services/ai/pageFetch";
import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";
import { clampDecodeBudgetMs } from "@/services/ai/decodeBudget";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { discoverViaFirecrawl } from "@/services/ai/firecrawlProvider";
import { filterSafeUrls } from "@/services/ai/urlSafety";
import { shouldRunFallback, decodeReasonCode, REASON_TEXT } from "@/services/ai/decodeFallback";

const DECODE_BUDGET_MS = Number(process.env.DECODE_BUDGET_MS || 13_000);

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

export const dynamic = "force-dynamic";

const TRUSTED_HOSTS = ["gs1.org", "gtin.info"]; // url-only evidence is trusted only from these

function e2eMode(): boolean {
  return process.env.IS_E2E === "1";
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

function decodeProviders(): AiProvider[] {
  if (e2eMode()) return [mockProvider];
  const chain: AiProvider[] = [];
  // Fast first: fast models with web search/grounding. The page-fetch step does the heavy lifting.
  if (process.env.GEMINI_API_KEY) chain.push(createGeminiProvider({ model: GEMINI_FAST_MODEL }));
  if (process.env.OPENAI_API_KEY) chain.push(createOpenAiProvider({ model: OPENAI_FAST_MODEL }));
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
export async function GET() {
  const geminiConfigured = !!process.env.GEMINI_API_KEY;
  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  // firecrawlConfigured gates the Stage-2 open-web fallback. Absent is NOT a blocker (decode still
  // works via barcode DBs + AI-cited URLs); the client just knows open-web discovery is unavailable.
  const firecrawlConfigured = !!process.env.FIRECRAWL_API_KEY;
  const missingKeys: string[] = [];
  if (!geminiConfigured) missingKeys.push("GEMINI_API_KEY");
  if (!openaiConfigured) missingKeys.push("OPENAI_API_KEY");
  if (!firecrawlConfigured) missingKeys.push("FIRECRAWL_API_KEY");
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
    dailyLimit: Number(process.env.AI_LOOKUP_DAILY_LIMIT || 100),
    missingKeys,
    e2e: e2eMode(),
  });
}

export async function POST(request: Request) {
  let body: {
    rawCode?: string;
    cleanCode?: string;
    codeType?: string;
    mode?: "lookup" | "decode";
    provider?: string;
    allowImageSuggestions?: boolean;
    confidenceThreshold?: number;
    budgetMs?: number;
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
  const req = {
    rawCodeSanitized,
    cleanCodeSanitized,
    allowImageSuggestions: body.allowImageSuggestions ?? false,
  };

  if (body.mode === "decode") {
    const threshold = body.confidenceThreshold ?? 0.85;
    // The budget may be owner-configured and arrives from the client - clamp it server-side so a
    // client can never request an abusive (e.g. 10-minute) decode. Falls back to the env default.
    const budgetMs = clampDecodeBudgetMs(body.budgetMs, DECODE_BUDGET_MS);

    // FAST-FIRST, CONCURRENT, HARD 13s BUDGET. Providers + page-fetch race under one budget signal.
    // On timeout the orchestrator aborts everything and returns Needs Review (never a partial).
    const baseProviders = decodeProviders(); // fast models only (gemini-flash + gpt-5-mini)
    const providers: DecodeProvider[] = baseProviders.map((p) => ({
      name: p.name,
      lookup: (signal) => p.lookup(req, signal),
    }));
    const reader = pageReader();
    const enrich = e2eMode()
      ? undefined
      : (signal: AbortSignal) => enrichWithPageFetch({ code, codeType, extract: reader, signal });

    const run = await runDecode({
      code,
      codeType,
      confidenceThreshold: threshold,
      providers,
      enrich,
      budgetMs,
      trustedHosts: TRUSTED_HOSTS,
    });

    // STAGE 2 - fallback source discovery. Runs ONLY when the fast path found no usable product (and
    // not a timeout / provider conflict), so normal successful scans add ZERO extra calls. Order:
    // (2a) read the URLs the AI already cited (free), then (2b) Firecrawl open-web search (gated by key).
    let results = run.results;
    let evidences = run.evidences;
    let providerNames = run.providerNames;
    let providerStatuses = run.providerStatuses;
    let decision = run.decision;
    let fallbackFound = false;

    const hasProduct = () => results.some((r) => isUsableProductName(r.productName));
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    const eligibleForFallback = shouldRunFallback({ hasProduct: hasProduct(), timedOut: run.timedOut, decisionStatus: decision.status, e2e: e2eMode() });

    if (eligibleForFallback && reader) {
      // 2a: read AI-cited URLs (the app never did this before) through the SSRF-guarded page reader.
      const citedUrls = filterSafeUrls(results.flatMap((r) => r.sourceUrls ?? []), 4);
      if (citedUrls.length > 0) {
        const t = Date.now();
        try {
          const fb = await enrichWithPageFetch({ code, codeType, extraUrls: citedUrls, extract: reader });
          const ok = !!fb.result && isUsableProductName(fb.result.productName);
          providerStatuses = [...providerStatuses, { provider: "ai-cited-urls", status: ok ? "ok" : "no_match", latencyMs: Date.now() - t, sourceUrlsReturned: citedUrls.length, exactCodeFound: fb.evidence.verified, identityFound: ok }];
          if (ok && fb.result) { results = [fb.result, ...results]; evidences = [fb.evidence, ...evidences]; providerNames = ["ai-cited", ...providerNames]; fallbackFound = true; }
        } catch {
          providerStatuses = [...providerStatuses, { provider: "ai-cited-urls", status: "error", latencyMs: Date.now() - t, sourceUrlsReturned: citedUrls.length, exactCodeFound: false, identityFound: false }];
        }
      }
      // 2b: Firecrawl open-web discovery (only if still no product). Gated by FIRECRAWL_API_KEY.
      if (!hasProduct()) {
        if (firecrawlKey) {
          const disc = await discoverViaFirecrawl(code, codeType, { apiKey: firecrawlKey }, { maxScrape: 3 });
          providerStatuses = [...providerStatuses, { provider: "firecrawl", status: disc.status, latencyMs: disc.latencyMs, sourceUrlsReturned: disc.searchCount, exactCodeFound: !!disc.result, identityFound: !!disc.result }];
          if (disc.result) { results = [disc.result, ...results]; evidences = [disc.evidence, ...evidences]; providerNames = ["firecrawl", ...providerNames]; fallbackFound = true; }
        } else {
          providerStatuses = [...providerStatuses, { provider: "firecrawl", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false }];
        }
      }
      if (fallbackFound) decision = decideDecode({ codeType, results, evidences, confidenceThreshold: threshold });
    }

    const reasonCode = decodeReasonCode({ hasProduct: hasProduct(), fallbackFound, timedOut: run.timedOut, decisionStatus: decision.status, statuses: providerStatuses, firecrawlKey: !!firecrawlKey });

    return Response.json({
      mode: "decode",
      providerNames,
      results,
      evidences,
      providerStatuses,
      decision,
      reasonCode,
      reasonText: REASON_TEXT[reasonCode] ?? "",
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
      },
      sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
    });
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
