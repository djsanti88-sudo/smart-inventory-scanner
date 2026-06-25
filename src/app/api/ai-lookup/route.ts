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
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";
import { groundedSpecFind } from "@/services/ai/groundedSpecFinder";
import { runSizeRace } from "@/services/ai/sizeRace";
import { tireSizeToken } from "@/services/ai/tireSpecs";

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

// url-only evidence (the exact code appears ONLY in a source URL, never confirmed in page text) is
// trusted ONLY from these authoritative GS1 registries. Deliberately NOT expanded to crowd barcode DBs
// (upcitemdb / go-upc / barcodespider / barcodelookup): those build the URL FROM the scanned code
// (/upc/<code>, /search?q=<code>) and serve a page for ANY code - even unregistered/not-found ones - so
// "the code is in the URL" there carries ZERO evidentiary value and would make every scan look "verified",
// defeating the evidence gate. Trust for those hosts must come from fetched_source instead: the app opens
// the candidate page, confirms the exact code in the REAL page text, and rejects "product not found" pages
// (see enrichWithPageFetch + looksLikeNotFound). gs1.org/gtin.info only return a page when a GTIN is
// actually registered, so url_only from them is sound.
const TRUSTED_HOSTS = ["gs1.org", "gtin.info"];

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
    dailyLimit: Number(process.env.AI_LOOKUP_DAILY_LIMIT || 200),
    missingKeys,
    e2e: e2eMode(),
  });
}

export async function POST(request: Request) {
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

  if (body.mode === "decode" || body.mode === "decode-deep") {
    // Task 4/5: the tire hot path issues NO synchronous deep/Firecrawl call. The deep path stays
    // reachable for the client: it sends mode "decode-deep" (or "decode" with deep:true) to opt INTO
    // the existing multi-stage deep/Firecrawl orchestration and SKIP the tire hot path below.
    const deepRequested = body.mode === "decode-deep" || body.deep === true;
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

      // PREFIX-ANCHORED FAST TIRE HOT PATH (Task 4). A known tire GS1 prefix hit IS the tire signal:
      // the route may not receive an explicit "tire" scanContext, so a lookupTirePrefix match scopes
      // this path. The anchor brand comes from the STRONG prefix family only (a hint, never authority).
      // One grounded 3s call + one decideDecode(scanContext "tire"), then return - with NO synchronous
      // deep/Firecrawl call. The deep path stays reachable via deepRequested (mode "decode-deep").
      // Skipped under E2E (mock-only orchestration below) and when the client opted into the deep path.
      const prefixMatch = lookupTirePrefix(code);
      const anchorBrand = prefixMatch ? (prefixMatch.brands.find((b) => b.weight === "strong")?.brand ?? null) : null;
      const isTireScan = !!prefixMatch;
      if (isTireScan && !deepRequested && !e2eMode()) {
        const { result, evidence } = await groundedSpecFind({ code, codeType, anchorBrand });
        // decideDecode is the ONLY gate that decides truth/auto-count: it verifies on the app-built
        // evidence from groundedSpecFind (never the model's self-claim), so false-auto-count stays 0.
        const decision = decideDecode({
          codeType,
          results: [result].filter((r): r is NonNullable<typeof r> => Boolean(r)),
          evidences: [evidence],
          confidenceThreshold: threshold,
          code,
          scanContext: "tire",
        });
        const results = result ? [result] : [];
        const providerNames = ["grounded-spec"];
        const providerStatuses = [{
          provider: "grounded-spec",
          status: (result ? "ok" : "no_match") as "ok" | "no_match",
          latencyMs: 0,
          sourceUrlsReturned: result?.sourceUrls?.length ?? 0,
          exactCodeFound: evidence.verified,
          identityFound: !!result,
        }];
        const hasProductHot = results.some((r) => isUsableProductName(r.productName));
        const reasonCode = decodeReasonCode({ hasProduct: hasProductHot, fallbackFound: false, timedOut: false, decisionStatus: decision.status, statuses: providerStatuses, firecrawlKey: false, coverageMissed: false });
        const reasonText = REASON_TEXT[reasonCode] ?? "";
        const finalDecision = decision.status !== "verified" && reasonText ? { ...decision, reason: reasonText } : decision;
        return {
          mode: "decode" as const,
          providerNames,
          results,
          evidences: [evidence],
          providerStatuses,
          decision: finalDecision,
          reasonCode,
          reasonText,
          timedOut: false,
          debug: {
            providersAttempted: providerNames,
            evidenceStrengths: [evidence].map((e) => e.strength),
            sourceCounts: results.map((r) => (r.sourceUrls ?? []).length),
            anchorBrand,
            tireHotPath: true,
            aiCalled: true,
            pageFetched: false,
            firecrawlCreditsEstimated: 0,
            cached: false,
          },
          sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
        };
      }

      // FAST PATH - CONCURRENT, HARD ~13s BUDGET. Providers + page-fetch race under one budget signal.
      // On timeout the orchestrator aborts everything and returns Needs Review (never a partial).
      const baseProviders = decodeProviders(body.proRecheck === true); // fast models; pro models for a correction recheck
      const providers: DecodeProvider[] = baseProviders.map((p) => ({
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
      let decision = decideDecode({ codeType, results, evidences, confidenceThreshold: threshold, code, scanContext: body.scanContext });
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
            // Apply the same app-computed sizeAgreement from the race to the fallback winner before
            // decideDecode so PATH 3 (internetTwoSourceSize) is available here too. sizeAgreement is
            // ONLY set from the race result - never from any provider field.
            const winnerWithSize = { ...outcome.hit.result, sizeAgreement: sizeRace.sizeAgreement };
            results = [winnerWithSize, ...results];
            evidences = [outcome.hit.evidence, ...evidences];
            providerNames = [outcome.hit.providerName, ...providerNames];
            fallbackFound = true;
            // Decide on the WINNER alone so leftover fast-path noise can't manufacture a false conflict.
            decision = decideDecode({ codeType, results: [winnerWithSize], evidences: [outcome.hit.evidence], confidenceThreshold: threshold, code, scanContext: body.scanContext });
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
