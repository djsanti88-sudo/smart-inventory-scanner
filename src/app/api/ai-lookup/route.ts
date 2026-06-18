import type { AiLookupResult } from "@/types";
import { type AiProvider, emptyResult } from "@/services/ai/provider";
import { mockProvider } from "@/services/ai/mockProvider";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import { createOpenAiProvider } from "@/services/ai/openaiProvider";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/services/codeTypeDetector";
import { formatGs1Hint } from "@/services/gs1Prefixes";
import { enrichWithPageFetch } from "@/services/ai/pageFetch";
import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";
import { clampDecodeBudgetMs } from "@/services/ai/decodeBudget";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { discoverViaFirecrawl } from "@/services/ai/firecrawlProvider";
import { filterSafeUrls } from "@/services/ai/urlSafety";
import { shouldRunFallback, decodeReasonCode, REASON_TEXT } from "@/services/ai/decodeFallback";
import { raceFinders, type Finder } from "@/services/ai/fallbackRunner";
import { withDecodeCache } from "@/services/ai/decodeCache";

// Separate budgets (owner rule): the fast path stays fast; only a hard-failed barcode gets the deep,
// parallel fallback. Each value is env-overridable.
const FALLBACK_AI_TIMEOUT_MS = Number(process.env.FALLBACK_AI_TIMEOUT_MS || 25_000); // grounded AI re-run
const FALLBACK_HARD_CAP_MS = Number(process.env.FALLBACK_HARD_CAP_MS || 30_000); // whole-fallback ceiling
const FALLBACK_PAGE_TIMEOUT_MS = Number(process.env.FALLBACK_PAGE_TIMEOUT_MS || 15_000);
const FIRECRAWL_MAX_SCRAPE = Number(process.env.FIRECRAWL_MAX_SCRAPE || 6);

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

function decodeProviders(pro = false): AiProvider[] {
  if (e2eMode()) return [mockProvider];
  const chain: AiProvider[] = [];
  // Fast first: fast models with web search/grounding. The page-fetch step does the heavy lifting.
  // proRecheck (correction-only) escalates to the strongest configured verification models instead -
  // it does NOT change the normal scan provider order or the premium fallback path.
  if (process.env.GEMINI_API_KEY) chain.push(createGeminiProvider({ model: pro ? GEMINI_DECODE_MODEL : GEMINI_FAST_MODEL }));
  if (process.env.OPENAI_API_KEY) chain.push(createOpenAiProvider({ model: pro ? OPENAI_DECODE_MODEL : OPENAI_FAST_MODEL }));
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
    proRecheck?: boolean; // correction-only: use the strongest configured Gemini verification model
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
  };

  if (body.mode === "decode") {
    const threshold = body.confidenceThreshold ?? 0.85;
    // The budget may be owner-configured and arrives from the client - clamp it server-side so a
    // client can never request an abusive (e.g. 10-minute) decode. Falls back to the env default.
    const budgetMs = clampDecodeBudgetMs(body.budgetMs, DECODE_BUDGET_MS);

    const reader = pageReader();
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;

    // The expensive decode (fast path + deep fallback) is cached by code: once a barcode resolves to a
    // real product, a repeat scan in this server returns instantly with NO AI/Firecrawl spend. Only a
    // SUCCESS (a usable product) is cached - a failure stays retryable. Skipped under E2E (mock-only).
    const computeDecode = async () => {
      // FAST PATH - CONCURRENT, HARD ~13s BUDGET. Providers + page-fetch race under one budget signal.
      // On timeout the orchestrator aborts everything and returns Needs Review (never a partial).
      const baseProviders = decodeProviders(body.proRecheck === true); // fast models; pro models for a correction recheck
      const providers: DecodeProvider[] = baseProviders.map((p) => ({
        name: p.name,
        lookup: (signal) => p.lookup(req, signal),
      }));
      const enrich = e2eMode()
        ? undefined
        : (signal: AbortSignal) => enrichWithPageFetch({ code, codeType, extract: reader, signal });

      const run = await runDecode({ code, codeType, confidenceThreshold: threshold, providers, enrich, budgetMs, trustedHosts: TRUSTED_HOSTS });

      let results = run.results;
      let evidences = run.evidences;
      let providerNames = run.providerNames;
      let providerStatuses = run.providerStatuses;
      let decision = run.decision;
      let fallbackFound = false;
      let coverageMissed = false;
      let firecrawlCreditsEstimated = 0; // best-effort, for benchmark/cost tracking (0 if Firecrawl never ran)
      let firecrawlCandidates = 0;

      const hasProduct = () => results.some((r) => isUsableProductName(r.productName));
      const eligibleForFallback = shouldRunFallback({ hasProduct: hasProduct(), timedOut: run.timedOut, decisionStatus: decision.status, e2e: e2eMode() });

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
                code, codeType, confidenceThreshold: threshold, providers,
                enrich: (s) => enrichWithPageFetch({ code, codeType, extract: reader, signal: s, extraUrls: citedFromFast }),
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
                const fb = await enrichWithPageFetch({ code, codeType, extraUrls: freshCited, extract: reader, signal });
                if (fb.result && isUsableProductName(fb.result.productName) && fb.evidence.verified) {
                  return { result: fb.result, evidence: fb.evidence, providerName: "ai-cited-deep" };
                }
              }
              return null;
            },
          });
        }

        // Finder B: Firecrawl open-web discovery (6 safe candidates, scraped in PARALLEL).
        if (firecrawlKey) {
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
            results = [outcome.hit.result, ...results];
            evidences = [outcome.hit.evidence, ...evidences];
            providerNames = [outcome.hit.providerName, ...providerNames];
            fallbackFound = true;
            // Decide on the WINNER alone so leftover fast-path noise can't manufacture a false conflict.
            decision = decideDecode({ codeType, results: [outcome.hit.result], evidences: [outcome.hit.evidence], confidenceThreshold: threshold });
          }
        }
      }

      const reasonCode = decodeReasonCode({ hasProduct: hasProduct(), fallbackFound, timedOut: run.timedOut, decisionStatus: decision.status, statuses: providerStatuses, firecrawlKey: !!firecrawlKey, coverageMissed });
      const reasonText = REASON_TEXT[reasonCode] ?? "";
      // Never surface the generic "no provider returned a usable product": prefer the honest reason.
      if (decision.status !== "verified" && reasonText) decision = { ...decision, reason: reasonText };

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
          cached: false,
        },
        sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
      };
    };

    const hasUsable = (p: Awaited<ReturnType<typeof computeDecode>>) => p.results.some((r) => isUsableProductName(r.productName));
    const { value: payload, cached } = e2eMode()
      ? { value: await computeDecode(), cached: false }
      : await withDecodeCache(code, hasUsable, computeDecode);

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
