import "server-only";
import type { AiLookupResult, EvidenceResult, DecodeDecision } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { type ProviderStatus } from "@/services/ai/decodeOrchestrator";
import { decideDecode, isUsableProductName, isExampleOrTestRow } from "@/services/ai/decode";
import { firecrawlScrapeCheap, searchIdentifyByBarcode, firecrawlKeysFromEnv } from "@/services/ai/firecrawlProvider";
import { lookupBarcodeDb } from "@/server/retail-knowledge/barcodeDbProvider";
import { verifyCodeOnPage } from "@/services/ai/verifyCodeOnPage";
import { resolveUnknownFast, type ParallelResolveDeps } from "@/services/ai/parallelResolve";
import { decodeReasonCode, REASON_TEXT, sanitizeCustomerReason, allMissReasonCode, MISS_REASON_TEXT } from "@/services/ai/decodeFallback";
import { withDecodeCache, getDecodeCache, setDecodeCache } from "@/services/ai/decodeCache";
import { getDecodeKnowledgeVersion, decodeNegativeTtlMs } from "@/server/decode/knowledgeVersion";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { isLikelyMisreadGtin } from "@/services/upc/misread";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { lookupPrefixFull as lookupPrefix, candidateKnownPrefixesFull as candidateKnownPrefixes, prefixFloorNameFull as prefixFloorName } from "@/server/catalog/prefixIndexServer";
import { evaluatePrefixFirewall } from "@/services/catalog/prefixFirewall";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { readDailyUsed, chargeDailySlot, chargeDailySlotForAccount, chargeDailySlotConditional, chargeDailySlotForAccountConditional, refundDailySlot, intEnv, checkGptLadderBudget, recordGptLadderSpend, recordGptLadderCall } from "@/services/security/aiSpendGuard";
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
import { runLadder, buildFreeLadderRungs, buildPaidLadderRungs, type RungOutcome, type LadderResult, type RunLadderContext, type LadderRung } from "@/server/upc/ladder";
import { canonicalGtin, isGtinShaped } from "@/services/upc/gtin";
import { paidWorkPossible, liveAiLookupEnabled } from "@/server/upc/paidWorkPossible";
import { steerFreeRungs } from "@/server/upc/freeRungSteering";
import { getLearnedProduct, upsertLearnedProduct, shouldLearnDecode, prefixCheckNote, siblingPrefixConflict, type LearnedProductRow } from "@/server/learnedProducts";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { lookupMasterCatalog } from "@/server/catalog/masterLookup";

// PURE EXTRACTION (Task 2.4): this module is the decode pipeline lifted verbatim out of
// app/api/ai-lookup/route.ts. Zero behavior change - every domain rule (the daily cap charged only
// inside the paid rungs after the free corpus/cache peek; the corpus -> Go-UPC -> Fetch V2 -> GPT
// ladder order and short-circuit; IS_E2E mock-only; Gemini out of decode; honest reasons for
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

/** One wording for every "the cap refused a PAID upgrade, the free identity still stands" skip reason,
 *  so the escalation branch and the full-paid-ladder branch can never drift apart in what they report. */
function capSkipReason(message: string): string {
  return `skipped: daily cap reached (${message}); free suggestion kept`;
}

// OWNER ORDER 2026-07-06 ("remove Gemini for now"), made permanent by consolidation A1 (2026-08-19):
// Gemini is OUT of the decode path and its provider/grounding modules are DELETED. Forensics proved
// Gemini 3 grounding bills every executed search query with NO cap control and the queries are
// invisible client-side ($6 real vs $0.53 computed, see LESSONS_LEARNED L11) - the gpt-5.5 ladder rung
// (capped, fully meterable) is the only paid decode engine. Plan D consensus simply runs without a
// grounding leg (the resolver treats an absent leg exactly as it treated a null-returning one).

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

// wave-3 (2026-07-20 owner-ratified: realistic per-rung ladder budgets). Root cause fixed: paid rungs
// (Fetch V2, GPT) were starved by a uniform 8s-per-rung / 15s-total budget far below what they
// actually need, so the ladder aborted WAITING on them while the underlying call still ran (and
// billed) server-side - $9.75 burned across ~25 doomed calls in one day. Each paid rung now gets a
// budget derived from its OWN real completion-time ceiling, computed from the SAME constant its
// engine actually uses (never a hardcoded guess):
//   - goupc: unchanged, DECODE_LADDER_RUNG_MS (default 8000ms) - no new env var, no behavior change.
//   - fetchv2: FETCHV2_MAX_TOTAL_MS (the engine's own hard cap, read above) + 2000ms overhead margin
//     for the ladder's own bookkeeping around the call. Default ~27000ms.
//   - gpt: gptFromScratch's own internal 35s client timeout + 5000ms overhead margin. Default 40000ms.
const DECODE_LADDER_FETCHV2_MS = Number(process.env.DECODE_LADDER_FETCHV2_MS || FETCHV2_MAX_TOTAL_MS + 2_000);
const DECODE_LADDER_GPT_MS = Number(process.env.DECODE_LADDER_GPT_MS || 40_000);

// wave-3 PREFLIGHT (2026-07-20 owner-ratified): even with a realistic per-rung budget, a rung must
// never be STARTED when there clearly is not enough of the total ladder deadline left to have any
// chance of completing - that is exactly how the $9.75 burn happened (the ladder started a paid call
// with 2-3s left on the clock, aborted it a moment later, and still paid the worst-case charge for a
// call that could never have finished). These are the MINIMUM viable windows below which starting the
// rung is pointless - named constants, not magic numbers, so their rationale is visible at the call
// site:
//   - FETCHV2_MIN_VIABLE_MS: Fetch V2's cheapest real path (a single structured/pattern-URL door hit)
//     still needs a few seconds for DNS + TLS + a page fetch + parse; under 10s there is essentially
//     no chance of a genuine multi-source crawl completing.
//   - GPT_MIN_VIABLE_MS: GPT-5.5's own probe data shows a genuine answer (even a fast "no evidence"
//     empty-productName reply) takes at least several seconds once tool calls are involved; under 20s
//     there is no realistic chance of the model completing even one web_search round trip and replying
//     before the ladder's own deadline gives up on it.
const FETCHV2_MIN_VIABLE_MS = 10_000;
const GPT_MIN_VIABLE_MS = 20_000;

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

// Sync Truth Task 4: PURE payload assembly for a master-catalog hit (src/server/catalog/masterLookup.ts).
// Two honest shapes, mirroring the corpus/learned/retail payload builders above:
//   - human_verified -> a SETTLED VERIFIED result (an owner already approved this exact code+identity
//     via the catalog-review page; this rung stops the ladder before it ever reaches a paid gate).
//   - verified-but-not-human_verified (a fresh ladder-verified append, still pending owner review) ->
//     a high-trust SUGGESTION, never auto-verified - mirrors learnedPayload/retailPayload's honest
//     review-first posture so a still-unreviewed master entry never silently becomes ground truth.
const MASTER_CATALOG_SUGGESTION_CONFIDENCE = 0.85;
function masterCatalogPayload(
  entry: { name?: string; brand?: string; category?: string },
  outcomeKind: "verified" | "suggestion",
  code: string,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  const isVerified = outcomeKind === "verified";
  const reason = isVerified
    ? "Matched an owner-approved master catalog entry (exact barcode). No AI lookup needed."
    : "Matched a master catalog entry pending owner review (exact barcode). No AI lookup needed.";
  const confidence = isVerified ? 1 : MASTER_CATALOG_SUGGESTION_CONFIDENCE;
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: entry.name ?? "",
    brand: entry.brand ?? "",
    category: entry.category ?? "",
    confidence,
    needsHumanReview: !isVerified,
    sourceUrls: [],
    verifiedFacts: [`Master catalog: exact barcode ${code}`],
  };
  const evidence: EvidenceResult = {
    verified: isVerified,
    strength: isVerified ? "fetched_source" : "none",
    matchedCode: isVerified ? code : "",
    matchedSources: [],
    reason: isVerified
      ? "Master-catalog replay: human-verified via the owner catalog-review approval flow."
      : "Master-catalog replay: not yet human-verified, a single structured-DB row this scan.",
  };
  const decision: DecodeDecision = {
    status: isVerified ? "verified" : "suggested",
    confidence,
    reason,
    evidenceStrength: evidence.strength,
    exactCodeEvidenceVerifiedByApp: isVerified,
    crossCheck: { decision: "single_provider", confidence, reason: "Master-catalog exact barcode (single source).", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    // No CorroborationPath variant exists for "master-catalog human-verified" (types.ts is out of
    // scope for this task); corroborationPath stays unset, which is valid (optional field).
  };
  return {
    mode: "decode" as const,
    providerNames: ["master-catalog"],
    results: [result],
    evidences: [evidence],
    providerStatuses: [{ provider: "master-catalog", status: "ok" as const, latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: true, identityFound: true }],
    decision,
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["master-catalog"], evidenceStrengths: [evidence.strength], sourceCounts: [0], corroborationPath: "master_catalog_exact_barcode", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

// Combined prefix conflict fed to decideDecode: the existing catalog-derived brand sanity OR the new
// evidence-weighted firewall (barcode prefix-owner vs the candidate's manufacturer/category). The
// firewall is OVERRIDE-AWARE - strong app-verified exact-code evidence makes fw.conflict false - so this
// never blocks a legitimately exact-verified decode, only conflicting non-exact verify paths (e.g. the
// internet-two-source-size tire path) and Gemini-style "plausible product, wrong code" hallucinations.
async function evalCombinedFirewall(code: string, result: AiLookupResult | undefined, evidences: EvidenceResult[]): Promise<{ conflict: boolean; hint: string; reason: string; brandPrefixAdvisory: boolean }> {
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

  // LANE C ITEM C4 (owner-reported live regression, 2026-07-20): SAME-PREFIX SIBLING CONTRADICTION
  // GUARD. `fw` above only checks the STATIC catalog-derived prefix map; it says nothing about what the
  // app's OWN decode history has already verified for this prefix. siblingPrefixConflict consults the
  // learned-products tier (genuinely verified-then-learned rows) for a sibling sharing this code's GS1
  // prefix block whose brand+category CONTRADICTS the current candidate - e.g. a code on the same
  // prefix as an already-learned Fortune tire decoding to an unrelated Lattafa perfume. Folded into the
  // SAME `conflict` boolean fed to decideDecode (never a parallel gate) so it demotes exactly like any
  // other prefix conflict: blocks auto-verify, forces Needs Review, is overridden by this scan's own
  // strong app-verified exact-code evidence, and NEVER suppresses the row (still appears + counts).
  const sibling = await siblingPrefixConflict(code, { brand: result?.brand, category: result?.category }, { exactCodeVerifiedByApp: strongExact });
  const conflict = fw.conflict || sibling.conflict;
  // platformOwner-only display: what the barcode prefix maps to, and why a conflict (if any) fired.
  const hint = prefix?.dominant ? `${prefix.dominant.name} (${prefix.dominant.kind}, from barcode prefix - ${prefix.source})` : "";
  const reason = fw.conflict ? fw.reason : sibling.conflict ? sibling.reason : "";
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
// escalationProviders - the provider names of the retired legacy Gemini/OpenAI path, still present in old cached rows),
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

// L2 ROW STAMP (owner 2026-08-19): every row this pipeline persists records the decode knowledge
// version it was computed under, and - for a free suggestion the paid rungs already failed to beat -
// that paying again would buy nothing new. It lives INSIDE the payload's debug (debug.cache), so the
// decode_cache schema is untouched: no new column, no migration. The read side treats an absent stamp
// as stale (legacy rows predate this rule). See knowledgeVersion.ts for the two dials.
function withCacheStamp(body: object, extra?: { paidEscalationExhausted?: true }): string {
  const debug = (body as { debug?: Record<string, unknown> }).debug ?? {};
  return JSON.stringify({ ...body, debug: { ...debug, cache: { knowledgeVersion: getDecodeKnowledgeVersion(), ...extra } } });
}

/** The stamp a stored row carries (absent on a legacy row - see withCacheStamp). */
function readCacheStamp(parsedPayload: Record<string, unknown>): { knowledgeVersion?: string; paidEscalationExhausted?: true } {
  const debug = (parsedPayload.debug as Record<string, unknown> | undefined) ?? {};
  return (debug.cache as { knowledgeVersion?: string; paidEscalationExhausted?: true } | undefined) ?? {};
}

export function classifySourceTier(reasonCode: string, providerNames: string[]): "paid_ai" | "gpt_ladder" | "paid_rung" | null {
  if (reasonCode === "gpt_ladder") return "gpt_ladder";
  if (providerNames.some((n) => PAID_AI_PROVIDER_MARKERS.has(n))) return "paid_ai";
  if (providerNames.some((n) => PAID_RUNG_PROVIDERS.has(n))) return "paid_rung";
  return null;
}

// Diagnostic observability fix (2026-08-05, gpt-failure-rootcause.md): maybeGptLadder used to collapse
// EVERY real GPT provider failure (429 rate limit, 5xx server error, network exception, auth failure,
// non-JSON parse, ...) into the single generic skipReason "gpt_call_failed", leaving zero diagnostic
// trace in ladderReasons/providerStatuses/the Turso decode_outcomes ledger about what actually failed.
// This derives a compact, SANITIZED suffix from gptFromScratch's r.error (a status code when present,
// else a coarse error-class name) - NEVER the raw response body, prompt, key, or full message text
// (key-safety / PII rule). The caller prefixes it onto "gpt_call_failed:" so the combined string still
// contains the literal "gpt_call_failed" substring and therefore still trips
// decodeFallback.ts's CUSTOMER_REASON_DENYLIST exactly like the bare code did - this never becomes more
// visible to the customer, only to the platform-only debug/ladder/Turso trail.
export function classifyGptFailureDetail(rawError: string | undefined): string {
  if (!rawError) return "other"; // gptFromScratch always sets an error string on a real "none" outcome;
  // this is a defensive default for an unexpected/missing detail, never hit by the real ladder today.
  const httpMatch = /^HTTP (\d{3})$/.exec(rawError);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429) return "429";
    if (status >= 500 && status < 600) return "5xx";
    return String(status); // other 4xx (400/403/404/422) - still just a status code, no body/message
  }
  if (rawError.startsWith("openai_auth_failed")) return "401";
  if (rawError === "model returned non-JSON") return "bad_json";
  // Anything else reaching here comes from gptFromScratch's fetch-level catch block - the request never
  // got an HTTP response at all (DNS failure, connection refused, timeout, generic fetch exception).
  // Never echo the raw exception text (may embed a URL or stack fragment); "network" says enough.
  return "network";
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
  /** GC-A (P6 Task A2, tenant-starvation fix): threaded by the route ONLY for authed traffic, after its
   *  own per-account cap pre-check has run. accountCapCleared true means that tenant is genuinely under
   *  their own AI_LOOKUP_ACCOUNT_DAILY_LIMIT right now - the pipeline's internal global cap gate
   *  (chargePaidSlot below) then compares against the high platform-wide AI_LOOKUP_GLOBAL_BACKSTOP
   *  instead of the plain AI_LOOKUP_DAILY_LIMIT, so an authed tenant with remaining account budget is
   *  never 429'd purely because another tenant (or anonymous traffic) drained the shared global bucket.
   *  Undefined for anonymous/unauthenticated requests - the gate falls back to today's plain global cap,
   *  byte-identical to pre-A2 behavior. */
  capContext?: { authedBusinessId?: string; accountCapCleared: boolean; accountLimit?: number };
  /** GOD ACCOUNT (server-verified platform owner, owner order 2026-08-07): set TRUE by route.ts ONLY
   *  from isPlatformOwnerServer(verified uid/email) - never a client/header/body flag. When true the
   *  paid ladder's spend/cap GATES do not BLOCK: chargePaidSlot never throws DailyCapExceededError, the
   *  GPT $/day budget always allows, and the Go-UPC monthly cap is unlimited. Cost-truth is preserved -
   *  every charge/record still fires (chargeDailySlot, recordGptLadderSpend, Go-UPC record), so god
   *  spend is still counted; only the block/throw is skipped. The kill switch is NOT affected here (it
   *  is enforced in route.ts for everyone, god included). Undefined/false = today's behavior exactly. */
  god?: boolean;
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
  | { kind: "computed"; payload: DecodePayload; cached: boolean; paidComputeCharged: boolean };

/**
 * Run the full decode pipeline for one request. Encapsulates the L1/L2 cache peek, the free
 * corpus/retail/Plan-D stages, the lazy daily-cap gate, the spec-v6 ladder (Go-UPC -> Fetch V2 ->
 * GPT-5.5), and the L2 write-through. Returns a settled result the route turns into an HTTP response.
 * Behavior is identical to the former inline `isDecodeMode` block in route.ts.
 */
export async function runDecodePipeline(req: DecodePipelineRequest): Promise<DecodePipelineResult> {
  const { code, codeType, rawCodeSanitized, cleanCodeSanitized, threshold, allowNonPublicAutoCount, forceRetry, budgetMs, capContext, god } = req;

  // A4 (owner-ratified 2026-07-15, "trace every non-decode"): started at the very TOP of the OUTER
  // function (not computeDecode) so durationMs covers the corpus peek, the L2 persisted-decode peek,
  // and the full ladder -- every exit this request can take. Consumed by Task 12b's ladder deadline
  // wiring too (see AM-10 serialization note: this task lands first).
  const decodeStartedAt = Date.now();

  // L12 (per-account charge signal): true only once the pipeline's ONE genuine global paid charge has
  // fired (chargePaidSlot -> chargeDailySlot, below). Free rung-0 corpus/retail/learned hits return
  // kind:"computed" with this still false - `cached:false` is NOT a paid signal (those rungs are $0).
  // The route gates its own per-account chargeDailySlotForAccount on this flag, never on `!cached`.
  let paidComputeCharged = false;

  // ---- PAID CAP: CHECK AT THE GATE, CHARGE AT THE EGRESS (S5, deep review 2026-08-09) -------------
  // L12 says: charge exactly once per GENUINE compute. The old chargePaidSlot did the cap CHECK and the
  // cap CHARGE together, immediately BEFORE each paid rung ran - but a rung's own internal gates can
  // still short-circuit with ZERO provider egress after that point:
  //   - Go-UPC returns on its monthly spend cap
  //     (GoUpcProvider.ts goUpcRung: both branches return before deps.client is ever called);
  //   - the GPT rung declines inside shouldRunGptRung's own $/day budget check.
  // Every one of those burned a daily slot for a request that spent nothing. So the two halves are now
  // SPLIT:
  //   assertPaidCapAvailable()  READ-ONLY. Runs at exactly the old call sites, so a blown cap still
  //                             throws DailyCapExceededError BEFORE any paid rung starts (unchanged
  //                             429 semantics), and it never writes.
  //   chargeOnEgress()          THE WRITE. Called by a rung immediately before REAL provider egress.
  //                             A no-op unless a charge is currently armed, and it disarms itself first
  //                             so one armed step can never charge twice.
  //   withPaidChargeArmed(fn)   arms exactly one charge for the duration of one paid step, then
  //                             disarms. Multiple paid rungs in one request may each charge (each is a
  //                             distinct genuine compute - that is by design and unchanged); the
  //                             full-paid-ladder branch arms ONCE for the whole ladder, exactly as it
  //                             charged once before.
  // Charge failure at egress propagates to the rung, which means the provider call never happens -
  // fail closed, no unmetered spend.
  let paidChargeArmed = false;
  // STICKY CAP DENIAL (item 1 deep-review fix, 2026-08-10): set when a conditional charge in the current
  // armed scope is DENIED (a cap race consumed the last slot between the read gate and this egress). Once
  // set, every later egress in the same arm re-throws it, and withPaidChargeArmed re-throws it after the
  // run completes - so a swallowed per-rung denial can never let a DOWNSTREAM paid rung run unmetered,
  // and the request settles as an honest cap_blocked instead of a needs-review that hid the spend.
  let capDenialInArm: DailyCapExceededError | null = null;
  // GENERALIZED STICKY FAILURE (DC-2 fix, 2026-08-13, money-leak remediation, Codex xhigh review):
  // `paidChargeArmed` is consumed BEFORE awaiting settlePaidCharge() (see chargeOnEgress below), so a
  // re-entrant egress can never double-charge -- but until this fix ONLY a DailyCapExceededError made
  // the arm sticky (capDenialInArm above). settlePaidCharge() can also reject for a NON-cap reason: the
  // GLOBAL chargeDailySlot/chargeDailySlotConditional write itself is NOT wrapped in the S4 fail-open
  // try/catch that only the PER-ACCOUNT half gets (see settlePaidCharge's doc comment) -- a genuine
  // Turso/storage hiccup on that call throws a plain Error straight out of settlePaidCharge. Pre-fix,
  // that left the arm silently "spent" with ZERO successful charge behind it: in the SHARED full-ladder
  // arm (goupc -> fetchv2 -> gpt all arm together, see withPaidChargeArmed(runFullPaidLadder) below), a
  // LATER rung's own chargeOnEgress() saw `!paidChargeArmed`, silently no-op'd, and proceeded straight to
  // REAL PAID EGRESS with nothing charged. `chargeFailureInArm` makes every later chargeOnEgress() call
  // in this arm throw too (mirrors capDenialInArm's stickiness, generalized to any settlement failure),
  // so a later rung in the same arm always DECLINES egress instead of running unmetered.
  //
  // Deliberately NOT re-thrown by withPaidChargeArmed's `finally` (unlike capDenialInArm): a non-cap
  // storage hiccup fails only the paid rungs it actually blocked (each already catches chargeOnEgress()
  // locally and records an honest skip/miss reason -- see maybeGptLadder, runFetchV2, and runLadder's own
  // catch around runGoUpc's uncaught client() throw), so the request still settles as an honest
  // needs_review rather than an uncaught 500 that would blow past the DailyCapExceededError-only catch
  // in the outer computeDecode try/catch below. Unmetered spend is worse than a missed decode (owner
  // doctrine); refusing every later egress in this arm is the fail-closed choice, at the cost of this one
  // request's paid ladder for a single storage blip.
  let chargeFailureInArm: Error | null = null;

  const assertPaidCapAvailable = async (): Promise<void> => {
    if (e2eMode()) return;
    const ladderStore = await ladderStorage();
    const dailyLimit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
    // GC-A (P6 Task A2): when the route already cleared this request's per-account cap, this internal
    // global gate compares against the high platform-wide BACKSTOP instead of the plain daily limit -
    // it must never independently 429 an authed tenant who is under their own account limit just
    // because the shared global bucket is drained by other tenants. Anonymous/uncleared requests keep
    // today's behavior byte-identical: gated by the plain limit.
    const limit = capContext?.accountCapCleared
      ? intEnv(process.env.AI_LOOKUP_GLOBAL_BACKSTOP, dailyLimit * 10)
      : dailyLimit;
    const used = await readDailyUsed(ladderStore);
    // GOD ACCOUNT: the platform owner is never BLOCKED by the daily cap, but IS still charged below
    // (cost-truth law) - skip only the throw.
    if (used >= limit && !god) throw new DailyCapExceededError(used, limit);
  };

  const settlePaidCharge = async (): Promise<void> => {
    if (e2eMode()) return;
    const ladderStore = await ladderStorage();
    const dailyLimit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
    const limit = capContext?.accountCapCleared
      ? intEnv(process.env.AI_LOOKUP_GLOBAL_BACKSTOP, dailyLimit * 10)
      : dailyLimit;
    // GLOBAL FIRST, and it must succeed: this is the meter that bounds the BILL. If it throws, the
    // caller (the rung) aborts before egress - nothing is spent, so nothing went unrecorded.
    // ITEM 1 (2026-08-09): the global charge is now ATOMIC-CONDITIONAL for every non-god caller. The
    // read-only gate (assertPaidCapAvailable) can pass while a concurrent request takes the last slot
    // before this egress runs; the conditional charge closes that race - it grants at most the slots
    // still available and, on a denied grant, throws DailyCapExceededError so this rung aborts BEFORE
    // spending (fail closed, no overshoot). GOD is CHARGED but NEVER BLOCKED, so god keeps the
    // unconditional increment and can never be denied here (cost-truth: god spend is still recorded).
    if (god) {
      await chargeDailySlot(ladderStore, { limit });
    } else {
      const g = await chargeDailySlotConditional(ladderStore, { limit });
      if (!g.granted) throw new DailyCapExceededError(g.used, g.limit);
    }
    paidComputeCharged = true;
    // FINDING B (accounting symmetry) kept: the per-account charge fires at the SAME site as the
    // global one so the two move together on the exception path.
    // S4 (deep review 2026-08-09), ordering least-harm: once the GLOBAL slot has advanced, a failure of
    // the per-account increment must NOT abort the compute. Aborting here would leave the global
    // counter advanced with zero compute (a phantom charge) AND fail a request that cleared every real
    // gate. The bill stays bounded by the global counter; only the per-tenant counter can drift by one,
    // and that divergence is logged instead of being silent.
    // ITEM 1 + deep-review Finding 2 (2026-08-10): the per-account charge is ATOMIC-CONDITIONAL for
    // non-god. Two OUTCOMES are distinguished:
    //  - a STORAGE-ERROR throw from the conditional call = S4 fail-open: the bill is already bounded by
    //    the global charge above, so a per-account bookkeeping hiccup must NOT abort a request that
    //    cleared every real gate. Log the divergence and proceed (tenant counter lags by one).
    //  - an authoritative {granted:false} = a REAL per-account quota denial (the tenant raced past the
    //    route's read gate to its own cap). ENFORCE the cap: throw DailyCapExceededError so the request
    //    settles as an honest cap_blocked. Pinning-and-proceeding here would let the tenant burst past
    //    its account cap and under-count its own meter (L12 "one account charge per genuine compute").
    // The global slot charged just above is a conservative over-count on the 10x backstop for this rare
    // raced denial - never an under-count of the bill. God charges unconditionally (never denied).
    if (capContext?.authedBusinessId) {
      if (god) {
        try {
          await chargeDailySlotForAccount(ladderStore, capContext.authedBusinessId);
        } catch (err) {
          console.error(
            JSON.stringify({
              src: "scanbin",
              route: "decode/pipeline.settlePaidCharge",
              event: "charge_pair_incomplete",
              businessId: capContext.authedBusinessId,
              ts: new Date().toISOString(),
              detail: "god global slot charged, per-account slot failed; spend metered globally, tenant counter may lag by one",
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      } else {
        const acctLimit = capContext.accountLimit ?? intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, dailyLimit);
        let acct: { used: number; granted: boolean };
        try {
          acct = await chargeDailySlotForAccountConditional(ladderStore, capContext.authedBusinessId, acctLimit);
        } catch (err) {
          console.error(
            JSON.stringify({
              src: "scanbin",
              route: "decode/pipeline.settlePaidCharge",
              event: "charge_pair_incomplete",
              businessId: capContext.authedBusinessId,
              ts: new Date().toISOString(),
              detail: "global slot charged, per-account slot failed; spend metered globally, tenant counter may lag by one",
              error: err instanceof Error ? err.message : String(err),
            })
          );
          acct = { used: 0, granted: true }; // storage error is S4 fail-open, NOT a quota denial
        }
        if (!acct.granted) {
          // Finding 4 (2026-08-10): this request charged the GLOBAL slot just above but is now BLOCKED on
          // its account cap. Refund that global charge so a burst of account-denied requests cannot
          // inflate the shared backstop by N-1 and starve other tenants. Best-effort: a refund failure at
          // worst leaves the prior conservative over-count, never an under-count of the bill.
          try {
            await refundDailySlot(ladderStore);
          } catch {
            /* leave the conservative over-count if the refund itself fails */
          }
          throw new DailyCapExceededError(acct.used, acctLimit); // authoritative account-cap denial -> cap_blocked
        }
      }
    }
  };

  /** Called by a rung at the exact moment real provider egress is about to happen. */
  const chargeOnEgress = async (): Promise<void> => {
    // Sticky: a prior denial in this arm makes every later egress deny too, so the rung's own egress
    // catch skips it BEFORE its provider call (no unmetered spend down the shared full-ladder arm).
    if (capDenialInArm) throw capDenialInArm;
    // DC-2: a prior NON-cap settlement failure is equally sticky - see chargeFailureInArm's doc comment
    // above. Without this, a later rung in the same arm would see `!paidChargeArmed` and no-op straight
    // into unmetered egress instead of declining.
    if (chargeFailureInArm) throw chargeFailureInArm;
    if (!paidChargeArmed) return;
    paidChargeArmed = false; // consume BEFORE awaiting, so a re-entrant egress can never double-charge
    try {
      await settlePaidCharge();
    } catch (e) {
      if (e instanceof DailyCapExceededError) {
        capDenialInArm = e;
      } else {
        chargeFailureInArm = e instanceof Error ? e : new Error(String(e));
      }
      throw e;
    }
  };

  /** Arms exactly one charge for one paid step. The cap CHECK still happens up front (unchanged 429). */
  const withPaidChargeArmed = async <T>(run: () => Promise<T>): Promise<T> => {
    await assertPaidCapAvailable();
    paidChargeArmed = true;
    capDenialInArm = null;
    chargeFailureInArm = null;
    try {
      return await run();
    } finally {
      paidChargeArmed = false;
      // If any egress in this arm hit a cap denial - even one swallowed by a rung's skip handling or by
      // runLadder's per-rung catch - fail the WHOLE arm with it so the outer handler returns an honest
      // cap_blocked, never a needs-review that concealed an unmetered downstream rung.
      if (capDenialInArm) throw capDenialInArm;
      // DC-2: a non-cap chargeFailureInArm is deliberately NOT rethrown here (unlike capDenialInArm) -
      // see chargeFailureInArm's doc comment above for why: every rung it blocked already recorded its
      // own honest skip/miss reason, so the request still settles as a normal (if disappointing)
      // needs_review instead of an uncaught throw the outer catch doesn't special-case.
    }
  };

  // L2 total ladder deadline (AM-1(b), owner-reported 36-70s blocking decodes): ONE request-scoped
  // deadline, derived once, passed to EVERY runLadder call below (free run, escalation Go-UPC-only
  // run, full paid run). DECODE_LADDER_TOTAL_MS default RAISED 15000ms -> 90000ms (wave-3, 2026-07-20
  // owner-ratified): the old 15s ceiling could not fit even ONE realistic paid rung (Fetch V2 needs up
  // to ~27s, GPT's own client timeout is 35s) - it guaranteed every paid rung was aborted mid-flight
  // while still billing worst-case, which is the root cause this wave fixes. 90s comfortably fits the
  // full paid chain (goupc 8s + fetchv2 ~27s + gpt ~40s, with margin) end to end. Still overridable by
  // its env var, and still widened (never narrowed) by the client's own requested budgetMs. Never
  // trips on the golden gate: that gate runs fully offline with instant rungs, so wall-clock time never
  // reaches the deadline (do not make it time-sensitive there).
  const ladderDeadlineAt = decodeStartedAt + Math.max(intEnv(process.env.DECODE_LADDER_TOTAL_MS, 90_000), budgetMs ?? 0);

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

  // E1 (efficiency audit, 2026-07-20): thread the rung-0 retail peek's result INTO computeDecode so its
  // own retail peek (Plan D consensus vote + the paid-verified contradiction guard) reuses it instead of
  // re-querying lookupRetailBarcodeAsync a SECOND time for the identical code that just missed at rung 0.
  // This mirrors the D8 upcItemDbResult / upcItemDbExactTried thread-through below EXACTLY: the rung-0
  // retail peek (further down in runDecodePipeline) is GTIN-gated on the SAME `!e2eMode() && isGtinShaped
  // && !misread` predicate computeDecode's peek uses, and computeDecode is ONLY ever reached on a rung-0
  // MISS - so by the time computeDecode's retail peek would run, rung 0 has ALWAYS already performed the
  // exact same lookup (or was gated out identically). `rung0RetailTried` is true ONLY when rung 0
  // genuinely ran the exact-code lookup (e2e skip / non-GTIN / misread never set it), so on any path where
  // rung 0 did NOT look retail up, computeDecode still does its own lookup (finding rule (b)). The full
  // row (barcode/productName/brand) plus the last-lookup status are threaded so BOTH the retailDb
  // consensus vote and the retailLookup debug field are preserved byte-for-byte.
  let rung0RetailRow: { productName: string; brand: string; barcode: string } | null = null;
  let rung0RetailStatus: string | undefined;
  let rung0RetailTried = false;

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
  // persistedHit peek so a fresh corpus hit always beats any stored row for the code (receipts are
  // abolished, owner 2026-08-20; historical "no_result_receipt" rows read back as a plain miss). A corpus hit is never persisted to L2 (classifySourceTier returns null for
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
      return { kind: "computed", payload: corpusPayload(corpus, rawCodeSanitized, cleanCodeSanitized), cached: false, paidComputeCharged: false };
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
      const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
      const retailRow = await lookupRetailBarcodeAsync(code);
      // E1: capture the RAW row + status for computeDecode's peek to reuse - the retail index is never
      // queried twice for the same request. This is the raw pre-filter row (computeDecode applies its own
      // example/usable filters downstream exactly as before), and `rung0RetailTried` records that rung 0
      // genuinely performed the exact-code lookup so computeDecode may safely skip its own second query.
      rung0RetailRow = retailRow;
      rung0RetailStatus = getLastRetailLookupStatus();
      rung0RetailTried = true;
      if (retailRow && isUsableProductName(retailRow.productName) && !isExampleOrTestRow(retailRow.barcode, retailRow.productName, retailRow.brand)) {
        appendDecodeOutcome({ settledBy: "retail-corpus", status: "suggested", reasons: [], sourceTier: null });
        return { kind: "computed", payload: retailPayload(retailRow, code, rawCodeSanitized, cleanCodeSanitized), cached: false, paidComputeCharged: false };
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
      return { kind: "computed", payload: learnedPayload(learned, rawCodeSanitized, cleanCodeSanitized), cached: false, paidComputeCharged: false };
    }

    // Sync Truth Task 4 (owner-approved 2026-07-22): MASTER CATALOG PEEK, immediately after the
    // learned-tier peek and still BEFORE the L2 persisted-decode cache / daily-cap gate below - the
    // exact slot the plan calls for ("after learned-tier/L2 cache, before goupc gate"; positioned here,
    // ahead of the L2 read, so a master-catalog hit is the LAST free rung this pipeline tries before the
    // persisted-cache peek and preserves "first settled rung stops, never pay when an earlier rung
    // already answered"). A "verified" outcome (owner-approved via the catalog-review page,
    // provenanceTier human_verified, OR a prior ladder_verified_strong append - masterLookup.ts's
    // classifyEntry now trusts that tier too) settles here and stops the ladder before any paid rung
    // ever runs. This rung NEVER calls chargeDailySlot (it is FREE, L12: never charge two paths of one
    // request) and NEVER throws (masterLookup.ts silently misses on missing credentials, a Firestore
    // error, or a read exceeding its internal timeout bound).
    //
    // FIX (rung self-poisoning, owner-approved): a "suggestion" outcome must NOT settle/stop the ladder.
    // Before this fix, ANY non-miss master hit unconditionally returned here - since classifyEntry only
    // ever returns "suggestion" for a verified-but-not-yet-trusted entry, that entry would replay
    // forever as a demoted suggestion and the rest of the ladder (L2 cache, paid rungs) would never run
    // to genuinely re-resolve it. Record the honest peek (settledBy: null mirrors the cap_blocked
    // non-settling pattern elsewhere in this function) and fall through - only "verified" settles.
    const masterHit = await lookupMasterCatalog(code);
    if (masterHit.kind === "verified") {
      appendDecodeOutcome({ settledBy: "master-catalog", status: masterHit.kind, reasons: [], sourceTier: null });
      return {
        kind: "computed",
        payload: masterCatalogPayload(masterHit.entry, masterHit.kind, code, rawCodeSanitized, cleanCodeSanitized),
        cached: false,
        paidComputeCharged: false,
      };
    }
    if (masterHit.kind === "suggestion") {
      appendDecodeOutcome({ settledBy: null, status: "master_catalog_suggestion_fallthrough", reasons: [], sourceTier: null });
    }
  }

  // L2 PERSISTENT DECODE CACHE (Task 4): consulted on an L1 miss, BEFORE the daily cap check below -
  // same guard window as the existing L1 peek, so a persisted "result" never burns a daily slot.
  // Never touched under E2E (tests/Playwright must never read/write the real store) and skipped
  // entirely when the caller asks for forceRetry (owner manual override; the fresh compute overwrites
  // the row - see the write-through at the withDecodeCache call site). Only "result" rows exist:
  // no-candidate receipts are abolished (owner 2026-08-20), a failed decode stores nothing.
  let persistedHit: PersistedDecode | null = null;
  if (!e2eMode() && !forceRetry && getDecodeCache(cacheKey) === undefined) {
    persistedHit = await getPersistedDecode(cacheKey);
    // Belt and braces on the abolition (owner 2026-08-20): the store already reads legacy
    // "no_result_receipt" rows back as null, but a row of any non-"result" kind that still reaches
    // this point (out-of-date store layer, hand-written data) is a plain MISS, never a replay.
    if (persistedHit && (persistedHit as { kind?: string }).kind !== "result") persistedHit = null;
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
  // verified/suggested decode. A corrupted stored payload degrades to a miss (recompute).
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
  // (null it) so control falls through to the honest recompute / rung-0 guards.
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

  // COOLDOWN + KNOWLEDGE VERSION (owner 2026-08-19, "a failed search is an event, not an identity";
  // amended by owner ruling 2026-08-20: NO-CANDIDATE ROWS ARE ABOLISHED - a failed decode stores
  // nothing, so only "result" rows exist here and every unresolved code re-runs the full ladder on
  // every scan). A stored result row is only as good as the knowledge that produced it:
  //   - a non-verified "result" (a guess, including a pay-once escalation marker) whose version moved
  //     is NOT replayed blindly: it is re-evaluated with the PAID rungs switched off for this pass
  //     (freeOnlyPass below), because what changed is the FREE knowledge, and the app already paid for
  //     this code once. Once the cooldown itself lapses, paying again is permitted.
  //     Either way the old guess is kept as the fallback: a best guess already shown must never
  //     regress to "Unidentified" (see the stale-row replay after the compute below).
  //   - a VERIFIED row replays regardless of version; forceRetry (above) remains its correction path.
  let staleRow: { row: PersistedDecode; payload: Record<string, unknown> } | null = null;
  let freeOnlyPass = false;
  if (persistedHit && parsedPayload) {
    const versionStale = readCacheStamp(parsedPayload).knowledgeVersion !== getDecodeKnowledgeVersion();
    const cooledDown = Date.now() - persistedHit.createdAt > decodeNegativeTtlMs();
    const cachedStatus = (parsedPayload.decision as { status?: string } | undefined)?.status;
    if (cachedStatus !== "verified" && (versionStale || cooledDown)) {
      staleRow = { row: persistedHit, payload: parsedPayload };
      freeOnlyPass = !cooledDown;
      persistedHit = null;
    }
  }

  // The one shape a persisted row replays as (used by the cache hit here and by the stale-row fallback
  // after a re-evaluation that found nothing better).
  const persistedReplay = (parsed: Record<string, unknown>, row: PersistedDecode, extraDebug?: Record<string, unknown>): DecodePipelineResult => ({
    kind: "persisted",
    body: {
      ...parsed,
      debug: { ...((parsed.debug as Record<string, unknown> | undefined) ?? {}), cached: true, persistedCacheHit: true, persistedKind: row.kind, persistedTier: row.tier, ...extraDebug },
    },
  });

  if (persistedHit) {
    if (parsedPayload) {
      const priorDebug = (parsedPayload.debug as Record<string, unknown> | undefined) ?? {};
      appendDecodeOutcome({
        settledBy: (priorDebug.ladderPath as string | undefined) ?? null,
        status: `cached:${(parsedPayload.decision as { status?: string } | undefined)?.status ?? "unknown"}`,
        reasons: (priorDebug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [],
        sourceTier: persistedHit.sourceTier ?? null,
      });
      return persistedReplay(parsedPayload, persistedHit);
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
    /** wave-3: the ladder rung's AbortSignal (RunLadderContext.signal), threaded all the way into
     *  gptFromScratch's fetch call so a ladder-level give-up also cancels the in-flight HTTP request
     *  server-side, instead of leaving it running unaborted after the ladder stopped waiting. */
    signal?: AbortSignal;
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
    const rung = await shouldRunGptRung({
      code,
      codeType,
      priorStatus: opts.priorStatus,
      e2e: false,
      apiKeyPresent: !!process.env.OPENAI_API_KEY,
      // LAZY (MINOR 3): checkGptLadderBudget() reads the durable storage-backed $-guard (B1).
      // shouldRunGptRung checks priorStatus/codeType/e2e/apiKeyPresent FIRST and only calls this
      // thunk once all of those pass, so a code that never had a chance to reach the ladder never
      // pays for that storage round-trip.
      // GOD ACCOUNT: the platform owner's GPT rung is never blocked by the daily $/day budget. The
      // rung still runs and recordGptLadderSpend still fires below, so god spend is recorded (cost-truth);
      // only the pre-call block is lifted.
      budget: async () => god ? { allowed: true, spentUsd: 0, capUsd: Infinity } : checkGptLadderBudget({ worstCaseUsd: GPT_LADDER_WORST_CASE_USD, storage: await ladderStorage() }),
    });
    if (!rung.run) return { payload: null, skipReason: rung.skipReason, surfaceSkip: true };
    // S5 EGRESS POINT: shouldRunGptRung above can decline on its OWN $/day budget (checkGptLadderBudget)
    // with zero network. Charging the daily slot here - after every gate, immediately before the only
    // billed call - means a budget-declined rung costs ZERO slots instead of one.
    try {
      await chargeOnEgress();
    } catch (e) {
      const detail = e instanceof Error ? e.message : "error";
      return { payload: null, skipReason: `charge_unavailable:${detail}`, surfaceSkip: true };
    }
    const r = await gptFromScratch(code, { apiKey: process.env.OPENAI_API_KEY!, signal: opts.signal });
    const gptLadderStore = await ladderStorage();
    // ALWAYS record both - success, error, or abort; never let one skip the other. recordGptLadderSpend
    // already fail-opens internally (aiSpendGuard.ts), but running them via Promise.allSettled is
    // belt-and-suspenders: if either somehow throws, the other still runs instead of the spend/call
    // counters silently diverging (Task 6: Settings spend panel + GET status "calls today" counter).
    await Promise.allSettled([
      recordGptLadderSpend(r.usdActual, { storage: gptLadderStore }),
      recordGptLadderCall({ storage: gptLadderStore }),
    ]);
    // TRANSIENT-FAILURE GUARD (found live 2026-07-06): an aborted/HTTP-failed/garbled rung call is
    // NOT genuine exhaustion - the model never actually answered. (Historically this once wrote a
    // permanent no_result_receipt and froze the code; receipts are gone, the skip-vs-probed
    // distinction still matters for provider status honesty.) Only a real answer with an
    // empty productName ("empty productName") counts as genuinely probed-and-empty; every other
    // "none" is surfaced as a skip (visible in providerStatuses) and stays retryable.
    if (r.tier === "none" && (r.aborted || (r.error && r.error !== "empty productName"))) {
      // Observability fix (2026-08-05): thread a sanitized classification of r.error (status code /
      // error class, never the raw message) into the skip reason so a real provider failure leaves a
      // diagnostic trace in ladderReasons/providerStatuses/Turso instead of collapsing to a bare,
      // undifferentiated "gpt_call_failed" - see classifyGptFailureDetail above.
      const skipReason = r.aborted ? "gpt_aborted_at_cap" : `gpt_call_failed:${classifyGptFailureDetail(r.error)}`;
      return { payload: null, skipReason, surfaceSkip: true };
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

  // NO-CANDIDATE RECEIPTS ARE ABOLISHED (owner ruling 2026-08-20): a genuinely exhausted ladder
  // persists nothing, so there is no receipt classification anymore. Every unresolved code re-runs
  // the full ladder on its next scan; the ladder's own cost gates still decide what each pass spends.
  // PAY-ONCE MARKER (owner 2026-08-19): set by the escalation branch when paid rungs genuinely ran on
  // top of a free suggestion and none of them beat it. Read at the write-through so the row records
  // "paying again buys nothing new" and the next instance replays the suggestion instead of re-buying
  // the same misses. Declared per-request (outside computeDecode) so it reflects THIS request only.
  let paidEscalationExhausted = false;

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
    // TOP of runDecodePipeline (ahead of the L2 persisted-decode peek) so a corpus hit always wins.
    // computeDecode is only ever reached on a corpus MISS now, so no corpus check
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
      // E1: REUSE the rung-0 retail peek's result instead of re-querying the identical code a second time.
      // The rung-0 peek is GTIN-gated on the EXACT same `!e2eMode() && isGtinShaped && !misread` predicate
      // as this block, and computeDecode is only ever reached on a rung-0 MISS - so when control gets here,
      // rung 0 has ALWAYS already performed this exact lookup (rung0RetailTried === true), and the
      // deterministic index would return the identical row. Only when rung 0 did NOT genuinely try the
      // exact-code lookup (rung0RetailTried false - a defensive case that this predicate makes unreachable
      // today, kept per finding rule (b)) do we fall back to our own query. This is the retail twin of the
      // D8 upcItemDbResult / upcItemDbExactTried thread-through.
      let rawRetailHit: { productName: string; brand: string; barcode: string } | null;
      if (rung0RetailTried) {
        rawRetailHit = rung0RetailRow;
        retailLookupStatus = rung0RetailStatus;
      } else {
        const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
        rawRetailHit = await lookupRetailBarcodeAsync(code);
        retailLookupStatus = getLastRetailLookupStatus();
      }
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

    // D8 (Task 2, Step 3b, P5 2026-07-20): the tracked rung-0 UPCitemdb outcome, captured in a closure
    // exactly like `retailHit` above. Plan D's `lookupBarcodeDb` dep (below, ~PLAN D EXECUTION) reuses
    // THIS value instead of re-fetching api.upcitemdb.com a second time for the same code - UPCitemdb is
    // GTIN-gated at rung 0 and Plan D only runs for `isPublicBarcode` (the same GTIN universe), so by
    // the time Plan D runs, rung 0 has ALWAYS already tried this exact lookup. `sourceUrl` is preserved
    // when the rung-0 item carries one so Plan D's `bestUrl` offer-link escalation is not lost (today's
    // rung-0 UpcItemDbItem shape has no sourceUrl field - see upcItemDbClient.ts - so this is currently
    // always ""; the passthrough is written generically so a future rung-0 enrichment with a sourceUrl
    // flows through for free). NOTE: rung-0 lacks barcodeDbProvider's zero-pad-variant retry, so on a
    // rung-0 MISS, Plan D's fallback still queries the pad variants (see upcItemDbExactTried below) -
    // that retry-robustness delta is accepted per the plan (Task 2 Step 3b #9).
    let upcItemDbResult: { name: string; brand: string; sourceUrl: string } | null = null;
    // D8 follow-up (P5, 2026-07-20): true ONLY when rung-0 actually completed a live lookup for the
    // EXACT code (hit OR a genuine "no match" miss from the client). False when rung-0 never truly
    // tried the exact code: e2eMode skip, GTIN-gate reject (client never called), local daily-cap
    // gate (client never called), or the rung never ran at all (freeRungs empty / non-GTIN / steered
    // off). In every false case, Plan D's fallback below must keep its full exact-code + pad-variant
    // behavior - only a genuinely-tried exact code may be skipped a second time.
    let upcItemDbExactTried = false;

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
        // D8: capture the hit for Plan D's lookupBarcodeDb dep to reuse - UPCitemdb is never queried
        // twice for the same request.
        const hitResult = r.results?.[0];
        upcItemDbResult = hitResult ? { name: hitResult.productName, brand: hitResult.brand, sourceUrl: (hitResult.sourceUrls ?? [])[0] ?? "" } : null;
        upcItemDbExactTried = true; // a live lookup for the exact code genuinely ran (and hit).
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
      // A GENUINE miss ("upcitemdb: no match") means the client DID fetch the exact code and got an
      // empty result - that exact-code attempt is done and must not be repeated by Plan D's fallback.
      // Every other miss/unavailable reason (GTIN-gate reject, local daily-cap gate, e2e skip - the
      // e2e path returns before reaching here at all) means the client was NEVER called for this code,
      // so the exact-code lookup genuinely still needs to happen and the flag stays false.
      if (r.path === "upcitemdb_miss" && r.reason === "upcitemdb: no match") upcItemDbExactTried = true;
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
    // DC-1 fix (2026-08-13, money-leak remediation): accepts the ladder's optional RunLadderContext,
    // same widened signature as runGpt, so `ctx.signal` threads into the shared GoUpcGate. Without this,
    // a call still queued behind the module-level, process-wide throttle when the ladder gave up on this
    // rung would fire unaborted once the throttle finally released it - charging nothing (the arm was
    // already disarmed) but still performing the real billed fetch. See goUpcThrottle.ts's `run()` doc
    // comment for the drop mechanism.
    const runGoUpc = async (ctx?: RunLadderContext): Promise<RungOutcome> => {
      // E2E MOCK MODE: live rungs are bypassed exactly like the legacy [mockProvider] path - E2E
      // resolves only via the GPT rung's zero-network mockGptLadder fixture (or falls to Needs Review).
      if (e2eMode()) return { settled: false, reason: "Go-UPC skipped (E2E mock mode)" };
      const ladderStore = await ladderStorage();
      const r = await goUpcRung(code, {
        apiKey: process.env.GO_UPC_API_KEY,
        // S5 EGRESS POINT: goUpcRung calls `client` ONLY after its own GTIN gate
        // cache, and monthly spend cap have all passed (GoUpcProvider.ts goUpcRung) - i.e. exactly when
        // a billed request is about to leave. Charging here instead of before the rung is what makes a
        // and spend gates, so a capped month costs ZERO daily slots. If the charge itself fails, the
        // lookup never happens (runLadder records the rung error) - fail closed, no unmetered spend.
        // DC-1: `deps.gate.run` (via goUpcRung's own `deps.signal` threading) drops this call BEFORE it
        // ever reaches here when ctx.signal is already aborted, so chargeOnEgress can never fire for an
        // abandoned rung's stale queued turn - and a call that DOES reach here is a genuine compute that
        // must still be charged in full, exactly as before.
        client: async (c, d) => {
          await chargeOnEgress();
          return goUpcLookup(c, { ...d, signal: ctx?.signal });
        },
        gate: goUpcGate,
        signal: ctx?.signal,
        // GOD ACCOUNT: unlimited Go-UPC monthly cap for the platform owner (record() still fires inside
        // the rung, so subscription usage is still tracked - only the cap gate is lifted).
        usage: god ? goUpcUsage(ladderStore, { limit: Infinity }) : goUpcUsage(ladderStore),
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
        // D6/Task 2 (P5 2026-07-20): honest evidence object - Go-UPC is a paid-DB API SELF-REPORT, not
        // an app-verified fetch. `verified: false` / `strength: "none"` mirrors GoUpcProvider.ts's own
        // demoted `r.decision` (status "suggested"); the reason names the provenance honestly instead
        // of fabricating a "fetched_source" claim the app never actually earned.
        return {
          settled: true,
          reason: r.reason,
          payload: {
            results: r.results ?? [],
            evidences: [{ verified: false, strength: "none", matchedCode: code, matchedSources: ["go-upc"], reason: "Go-UPC API self-report (not app page-verified)" }],
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
      // S5 EGRESS POINT: the fetchV2 engine is the paid work for this rung; charge immediately before it.
      try {
        await chargeOnEgress();
      } catch (e) {
        const detail = e instanceof Error ? e.message : "error";
        return { settled: false, reason: `Fetch V2 skipped: could not record paid usage (${detail})` };
      }
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
      const fw = await evalCombinedFirewall(code, result, [evidence]);
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
    const runGpt = async (ctx?: RunLadderContext): Promise<RungOutcome> => {
      const ladder = await maybeGptLadder({ priorStatus: "needs_review", timedOut: false, signal: ctx?.signal });
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

    // ===== ORDER v3 (owner-ratified 2026-07-14; EXTENDED 2026-07-20 owner-ratified, wave-3) ==========
    // retail peek (above, unchanged) -> FREE rungs -> Plan D -> cap gate -> paid ladder.
    // Free-before-paid now holds STRICTLY: Plan D's internal Firecrawl legs no longer run before the $0
    // UPCitemdb/OFF rungs. ESCALATION (2026-07-20 owner-ratified, wave-3): a free-rung SUGGESTION is a
    // fallback, not a stop - Go-UPC gets first crack at beating it (a cap-charged exact-verify may still
    // upgrade it), and when Go-UPC does NOT produce something better, Fetch V2 ALSO gets a shot, and if
    // that doesn't improve on the stash either, GPT gets the final shot. Each paid rung may REPLACE the
    // free suggestion only when its own outcome is a "verified" decision or a suggestion with STRICTLY
    // higher confidence than the free suggestion's own confidence - otherwise the free suggestion stands
    // and the paid rung's reason is still recorded for transparency (see the escalation block below for
    // the full mechanics, including realistic per-rung budgets and the money preflight time gate). A
    // total free MISS keeps today's exact behavior (Plan D -> cap gate -> full paid ladder: goupc ->
    // fetchv2 -> gpt), now also carrying the wave-3 realistic budgets + money preflight.
    //
    // A6 (owner-ratified 2026-07-15, AM-3 hardened): a code with a strong, >=8-digit tire-prefix hint
    // skips BOTH free rungs (UPCitemdb/OFF have never returned a tire). The steered path is otherwise
    // IDENTICAL to today's non-GTIN path (buildFreeLadderRungs already returns [] for non-GTINs), so no
    // downstream freeSuggestion/total-miss branch needed any change - see freeRungSteering.ts's doc
    // comment for the full blast-radius rationale (a false steer can cost a real paid cap slot).
    const steering = steerFreeRungs(code);
    const freeRungs = steering.skip ? [] : buildFreeLadderRungs(code, { runUpcItemDb, runOpenFoodFacts });
    const freeRun = await runLadder(code, freeRungs, { deadlineAt: ladderDeadlineAt, perRungTimeoutMs: intEnv(process.env.DECODE_LADDER_RUNG_MS, 8000) });
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
      // FREE-ONLY RE-EVALUATION (owner 2026-08-19): Plan D still RUNS on a free-only pass - re-reading
      // the free corpus/DB knowledge is the entire point of the pass - but only its FREE arms are
      // supplied. Its paid arms (Firecrawl /search, the Firecrawl scrape, page verification) spend real
      // money outside the daily cap, so on this pass they are simply not wired: the optional arms are
      // omitted and the required scrape arm is a no-op miss, which resolveUnknownFast already handles.
      // ENABLE_LIVE_AI_LOOKUP=false gates Plan D's PAID arms exactly like a free-only pass (deep-review
      // 2026-08-19 finding 1: the flag turned off the paid LADDER rungs but Plan D's Firecrawl /search,
      // cheap scrape and page-verify arms still spent real money outside the daily cap).
      const paidArms: Pick<ParallelResolveDeps, "firecrawlScrapeCheap" | "searchIdentify" | "verifyCodeOnPage"> = freeOnlyPass || !liveAiLookupEnabled()
        ? { firecrawlScrapeCheap: async () => null }
        : {
            verifyCodeOnPage: (urls, c) => verifyCodeOnPage(urls, c),
            firecrawlScrapeCheap: (u) => firecrawlScrapeCheap(u),
            searchIdentify: (c) => searchIdentifyByBarcode(c),
          };
      const fast = await resolveUnknownFast(code, {
        // D8 (Task 2, Step 3b, + 2-DB-consensus regression fix): REUSE rung-0's UPCitemdb result when it
        // produced one (the common hit path - no second fetch, pay-once holds). Rung-0 is NOT fully
        // equivalent to barcodeDbProvider though: it applies a stricter check-digit gate and lacks the
        // zero-pad-variant retry, so a code rung-0 rejected/missed can still be a genuine barcodeDbProvider
        // hit that Plan D's 2-DB verified consensus needs (master plan D8: "the valuable 2-DB agreement
        // path preserved"). Fall back to a real barcodeDbProvider lookup ONLY when rung-0 gave nothing -
        // this keeps once-per-request on the hit path while never dropping the verified 2-DB path.
        // D8 follow-up (P5, 2026-07-20): on the fallback path (rung-0 gave no hit), `skipExact` is set
        // to `upcItemDbExactTried` - when rung-0 genuinely already fetched the exact code and got a
        // clean miss, this fallback skips straight to the zero-pad variants instead of re-fetching the
        // identical exact-code URL a second time. When rung-0 never truly tried the exact code
        // (GTIN-gate reject, local daily-cap gate, e2e/steering skip, or the rung never ran), the flag
        // is false and this fallback keeps its full original behavior, exact code included.
        lookupBarcodeDb: async () => upcItemDbResult ?? (await lookupBarcodeDb(code, { skipExact: upcItemDbExactTried })),
        retailDb: async () => (retailHit ? { name: retailHit.productName, brand: retailHit.brand } : null),
        ...paidArms,
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
            debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled, pageFetched: false, cached: false, retailLookup: retailLookupStatus },
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
          debug: { providersAttempted: pdProviderNames, evidenceStrengths: pdEvidences.map((e) => e.strength), sourceCounts: pdResults.map((r) => (r.sourceUrls ?? []).length), corroborationPath: decision.corroborationPath ?? `parallel_${fast.source}`, aiCalled: fast.aiCalled, pageFetched: false, cached: false, retailLookup: retailLookupStatus },
          sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
        };
      }
    }

    // FREE-ONLY RE-EVALUATION SWITCH (owner 2026-08-19): when this pass exists only to re-check a
    // stale cached guess against NEW FREE knowledge, the paid half of the ladder is simply not built -
    // every branch below then sees an empty rung list and skips exactly as it does with no keys
    // configured (no charge, no provider call). Nothing else about the ladder changes.
    // ENABLE_LIVE_AI_LOOKUP=false (enforced server-side since 2026-08-19, see paidWorkPossible.ts): the
    // paid half is not built at all, exactly like a free-only re-evaluation. Free rungs still run.
    const paidRungs = (): LadderRung[] =>
      freeOnlyPass || !liveAiLookupEnabled() ? [] : buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt });

    // wave-3 (2026-07-20 owner-ratified): annotate the fetchv2/gpt rungs with their REALISTIC budgets
    // (see DECODE_LADDER_FETCHV2_MS / DECODE_LADDER_GPT_MS above) - goupc is untouched (keeps the
    // uniform DECODE_LADDER_RUNG_MS default via runLadder's opts.perRungTimeoutMs fallback). Applied
    // as a post-hoc annotation over buildPaidLadderRungs's output rather than threading a new param
    // through the builder - the builder only decides WHICH rungs exist and their order; per-rung
    // budget is a ladder-runtime concern layered on afterward, at the one call site that needs it.
    const withRealisticBudgets = (rungs: LadderRung[]): LadderRung[] =>
      rungs.map((r) => {
        if (r.name === "fetchv2") return { ...r, budgetMs: DECODE_LADDER_FETCHV2_MS };
        if (r.name === "gpt") return { ...r, budgetMs: DECODE_LADDER_GPT_MS };
        return r;
      });

    // wave-3 MONEY PREFLIGHT (2026-07-20 owner-ratified): filter OUT a paid rung whose realistic
    // minimum viable window no longer fits before the ladder's own total deadline - this runs ABOVE and
    // IN ADDITION to runLadder's own "any time left at all" deadline check (that check only asks "is
    // there time left", not "is there enough time for THIS specific rung's minimum viable window").
    // Every filtered-out rung still records an honest "skipped: insufficient time budget left" reason
    // so the needs_review response is never silent about why a paid rung never even started - this
    // mirrors the exact reasons/providerStatuses mechanism the ladder already uses for every other
    // skip (see runLadder's own "skipped: ladder deadline reached" wording).
    //
    // CRITICAL ordering for GPT (L12, never charge two paths of one request): this filter runs BEFORE
    // the ladder is ever invoked, which is BEFORE shouldRunGptRung's own budget-charging path
    // (checkGptLadderBudget) ever executes inside maybeGptLadder - a GPT rung skipped here for
    // insufficient time is filtered OUT of the rungs array entirely, so its run() closure (and
    // therefore shouldRunGptRung/gptFromScratch/chargeDailySlot) never executes at all. Zero bill.
    const preflightTimeGate = (rungs: LadderRung[], deadlineAt: number): { rungs: LadderRung[]; skippedReasons: Array<{ rung: string; reason: string }> } => {
      const skippedReasons: Array<{ rung: string; reason: string }> = [];
      const kept = rungs.filter((r) => {
        const remainingMs = deadlineAt - Date.now();
        if (r.name === "fetchv2" && remainingMs < FETCHV2_MIN_VIABLE_MS) {
          skippedReasons.push({ rung: r.name, reason: `skipped: insufficient time budget left (needed >=${FETCHV2_MIN_VIABLE_MS / 1000}s)` });
          return false;
        }
        if (r.name === "gpt" && remainingMs < GPT_MIN_VIABLE_MS) {
          skippedReasons.push({ rung: r.name, reason: `skipped: insufficient time budget left (needed >=${GPT_MIN_VIABLE_MS / 1000}s)` });
          return false;
        }
        return true;
      });
      return { rungs: kept, skippedReasons };
    };

    // ---- LAZY DAILY CAP GATE (Task 7; S5 split 2026-08-09) ------------------------------------------
    // The cap CHECK + charge ARMING for BOTH the escalation branch (per paid step) and the full-paid
    // branch (once for the whole ladder) now live in withPaidChargeArmed / assertPaidCapAvailable /
    // chargeOnEgress, declared at the top of runDecodePipeline (see their doc comment). The check still
    // runs at exactly these sites - a blown cap still throws DailyCapExceededError BEFORE any paid rung
    // starts - but the WRITE now happens at real provider egress, so a rung that short-circuits on its
    // own monthly cap / $-budget bills nothing. E2E is a no-op on both halves.

    let ladderRun: LadderResult;
    if (freeSuggestion) {
      // ===== ORDER v3 ESCALATION (owner-ratified 2026-07-20, wave-3 EXTENDED) ==========================
      // A free suggestion stands as a fallback. Go-UPC gets first crack at beating it (unchanged: a
      // cap-charged exact attempt may settle a stronger paid answer). NEW (2026-07-20): when Go-UPC
      // does NOT produce something better, Fetch V2 ALSO gets a shot, and if THAT doesn't improve on
      // the stash either, GPT gets the final shot - each with its own wave-3 realistic budget/preflight
      // (see withRealisticBudgets/preflightTimeGate above) and its own paid-capability + non-public-
      // code-type gating (goUpcCanPay/fetchV2CanPay/gptCanPay below mirror paidWorkPossible.ts's
      // per-provider checks). A paid rung's outcome REPLACES the stashed free suggestion ONLY when it is
      // itself a "verified" decision (only possible from goupc/fetchv2 - GPT never mints "verified", see
      // gptResultToDecodePayload) OR a suggestion whose confidence is STRICTLY HIGHER than the free
      // suggestion's own confidence; otherwise the free suggestion stands and the paid rung's reason is
      // still recorded in the reasons list for transparency.
      //
      // PAY-ONCE (L12): each paid rung charges its cap slot exactly once, immediately before it runs,
      // and ONLY when it is genuinely capable of paying (mirrors the pre-existing goUpcCanPay pattern
      // for goupc). A rung skipped by the preflight time gate or by shouldRunGptRung's own gating
      // (non_public_code_type, no key, etc) is NEVER charged - its run() closure never executes.
      const freeConfidence = (freeRun.outcome?.payload as LadderPayload | undefined)?.decision.confidence ?? 0;
      let winningOutcome: RungOutcome | undefined = freeRun.outcome;
      let winningSettledBy: string | undefined = freeRun.settledBy;
      let beatFree = false; // true once a paid rung's outcome has replaced the free stash
      let paidRungRan = false; // true once a paid rung genuinely ran (pay-once marker, owner 2026-08-19)
      const reasonsAcc: Array<{ rung: string; reason: string }> = [...freeRun.reasons];

      // CAP DENIAL KEEPS THE FREE SUGGESTION (consolidation 2026-08-19): a blown daily cap used to throw
      // out of this branch, and the outer catch answered `cap_blocked` - discarding the free suggestion
      // already in hand. That contradicted "free resolution always completes first and is NEVER
      // blocked" (ORDER v3, above) and "always attach the best available identity". The cap decides
      // only whether a PAID upgrade may be attempted; it never hides a free identity. On a denial the
      // free suggestion stands, the skip is recorded per rung, nothing is charged, and the pay-once
      // marker is NOT set (no paid rung ran, so the next uncapped scan may still escalate). Sticky for
      // the rest of this branch: once the cap said no, later paid steps are skipped without re-asking.
      let capDenied: DailyCapExceededError | null = null;
      const paidStep = async (rung: string, rungs: LadderRung[]): Promise<LadderResult | null> => {
        if (capDenied) {
          reasonsAcc.push({ rung, reason: capSkipReason(capDenied.message) });
          return null;
        }
        try {
          const result = await withPaidChargeArmed(() =>
            runLadder(code, rungs, { deadlineAt: ladderDeadlineAt, perRungTimeoutMs: intEnv(process.env.DECODE_LADDER_RUNG_MS, 8000) })
          );
          paidRungRan = true;
          return result;
        } catch (e) {
          if (e instanceof DailyCapExceededError) {
            capDenied = e;
            reasonsAcc.push({ rung, reason: capSkipReason(e.message) });
            return null;
          }
          throw e;
        }
      };

      // A win is "better" than the free stash when it is itself verified, or a suggestion with
      // STRICTLY higher confidence than the free suggestion's own confidence (never GPT-verified - that
      // is structurally impossible per gptResultToDecodePayload, so this check is honest for all three).
      const isBetterThanFree = (outcome: RungOutcome | undefined): boolean => {
        const payload = outcome?.payload as LadderPayload | undefined;
        if (!payload) return false;
        if (payload.decision.status === "verified") return true;
        return payload.decision.confidence > freeConfidence;
      };

      // ---- Step 1: Go-UPC only (unchanged behavior) ---------------------------------------------------
      const goUpcRungOnly = paidRungs().filter((r) => r.name === "goupc");
      const goUpcCanPay = goUpcRungOnly.length > 0 && !!process.env.GO_UPC_API_KEY;
      const goRun = goUpcCanPay ? await paidStep("goupc", goUpcRungOnly) : null;
      if (goRun) {
        reasonsAcc.push(...goRun.reasons);
        // D6/Task 2 Step 3c (demotion ripple, CRITICAL): Go-UPC is now honestly labeled "suggested"
        // (never "verified" - see GoUpcProvider.ts), so this win-selection can no longer gate on the
        // literal status "verified" - that would DISCARD every genuinely settled paid Go-UPC answer in
        // favor of the weaker free-rung stash, silently wasting the just-charged paid slot. Gate on
        // whether Go-UPC SETTLED at all (goRun.outcome is only set when the rung actually answered,
        // verified OR suggested) so a cleanly-resolved paid Go-UPC hit still WINS over the free
        // suggestion, exactly as before the honesty relabel - only the label changed, not who wins.
        if (goRun.outcome) {
          winningOutcome = goRun.outcome;
          winningSettledBy = goRun.settledBy;
          beatFree = true;
        }
      }

      // ---- Step 2: Fetch V2, only when nothing has beaten the free suggestion yet --------------------
      if (!beatFree) {
        // wave-3 fix (found while testing): paidWorkPossible(code) is an OR across ALL three providers
        // (goupc/fetchv2/gpt) - using it here would charge a cap slot for fetchv2 even when ONLY goupc
        // or gpt has a key configured and fetchv2 itself has zero discovery keys (it would only ever
        // run its free keyless pattern-URL door, never genuinely paid work). fetchV2CanPay here mirrors
        // paidWorkPossible.ts's OWN internal fetchV2 check (Brave or any Firecrawl key) in isolation.
        const fetchV2CanPay = !!process.env.BRAVE_SEARCH_API_KEY || firecrawlKeysFromEnv().length > 0;
        const fetchV2RungOnly = withRealisticBudgets(paidRungs().filter((r) => r.name === "fetchv2"));
        const gated = preflightTimeGate(fetchV2RungOnly, ladderDeadlineAt);
        reasonsAcc.push(...gated.skippedReasons);
        const fv2Run = fetchV2CanPay && gated.rungs.length > 0 ? await paidStep("fetchv2", gated.rungs) : null;
        if (fv2Run) {
          reasonsAcc.push(...fv2Run.reasons);
          if (isBetterThanFree(fv2Run.outcome)) {
            winningOutcome = fv2Run.outcome;
            winningSettledBy = fv2Run.settledBy;
            beatFree = true;
          }
        }
      }

      // ---- Step 3: GPT, only when nothing has beaten the free suggestion yet -------------------------
      if (!beatFree) {
        const gptRungOnly = withRealisticBudgets(paidRungs().filter((r) => r.name === "gpt"));
        const gated = preflightTimeGate(gptRungOnly, ladderDeadlineAt);
        reasonsAcc.push(...gated.skippedReasons);
        // shouldRunGptRung (inside maybeGptLadder/runGpt) still applies its own gates - non_public_code_type,
        // api key, e2e, and its own daily-$-budget check - exactly as the normal full-paid-ladder path
        // does. Nothing here duplicates or bypasses those checks; the preflight time gate is STRICTLY
        // additional (it fires before shouldRunGptRung ever runs, so a time-skipped GPT rung never even
        // reaches shouldRunGptRung's own budget-charging path - see preflightTimeGate's doc comment).
        const gptRun = gated.rungs.length > 0 && !!process.env.OPENAI_API_KEY ? await paidStep("gpt", gated.rungs) : null;
        if (gptRun) {
          reasonsAcc.push(...gptRun.reasons);
          if (isBetterThanFree(gptRun.outcome)) {
            winningOutcome = gptRun.outcome;
            winningSettledBy = gptRun.settledBy;
          }
        }
      }

      // PAY-ONCE MARKER: paid rungs ran on top of this free suggestion and the stash still stands.
      // The write-through records that on the row so another instance replays the suggestion instead
      // of re-buying the same misses (until the cooldown or a knowledge-version change reopens it).
      // Deep-review 2026-08-19 finding 2: a cap denial mid-escalation must NOT mint the marker - the
      // denied rungs never ran, so "exhausted" would be a lie that blocks the paid retry after reset.
      paidEscalationExhausted = paidRungRan && !capDenied && winningOutcome === freeRun.outcome;

      ladderRun = { settledBy: winningSettledBy, outcome: winningOutcome, reasons: reasonsAcc };
    } else if (!freeRun.outcome) {
      // TOTAL FREE MISS: cap gate then the FULL paid ladder (goupc -> fetchv2 -> gpt) - BUT (L6, Task
      // 12c) only charge the cap slot when paid work is genuinely POSSIBLE for this code. With zero
      // provider keys configured, this branch degrades entirely to the AM-7 keyless pattern-URL scrape
      // and honest per-rung skips - never a slot for work that was never actually paid. Escalation
      // above already applies the equivalent gate (goUpcCanPay) for its own paid attempt.
      // wave-3: fetchv2/gpt get their realistic budgets (withRealisticBudgets), and the money preflight
      // filters out either one whose minimum viable window no longer fits the remaining ladder deadline
      // BEFORE it is ever started (preflightTimeGate) - goupc is unaffected (kept at its existing
      // DECODE_LADDER_RUNG_MS default via runLadder's own opts.perRungTimeoutMs fallback).
      const preGated = preflightTimeGate(withRealisticBudgets(paidRungs()), ladderDeadlineAt);
      const runFullPaidLadder = () =>
        runLadder(code, preGated.rungs, { deadlineAt: ladderDeadlineAt, perRungTimeoutMs: intEnv(process.env.DECODE_LADDER_RUNG_MS, 8000) });
      // S5: ONE charge armed for the WHOLE paid ladder (unchanged from the single pre-ladder charge this
      // branch always did) - but it is now only spent if some rung genuinely reaches a provider. A
      // keyless/budget-declined run down this branch now bills zero instead of one.
      let paidRun: LadderResult;
      try {
        // preGated.rungs.length guard (deep-review 2026-08-19 finding 3): a free-only pass builds ZERO
        // paid rungs, and arming for an empty ladder can never charge but CAN throw the cap error -
        // turning a $0 re-evaluation into a cap_blocked replay. No rungs, no arm.
        paidRun = paidWorkPossible(code) && preGated.rungs.length > 0
          ? await withPaidChargeArmed(runFullPaidLadder)
          : await runFullPaidLadder();
      } catch (e) {
        // CAP DENIAL KEEPS THE PLAN D STASH (consolidation 2026-08-19, same rule as the escalation
        // branch above): a free floor/suggestion Plan D already found must not be thrown away because
        // the PAID ladder may not run. Only when nothing free exists does the denial propagate and the
        // request settle as an honest cap_blocked (with the $0 prefix floor, see the outer catch).
        // A bare prefix FLOOR ("<Brand> / product unconfirmed", source "floor") is a naming convenience,
        // not an identity: that case still settles as cap_blocked (the outer catch carries the floor).
        const stashHasIdentity =
          !!planDStash &&
          !planDStash.providerNames.includes("parallel:floor") &&
          isUsableProductName(planDStash.results[0]?.productName ?? "");
        if (!(e instanceof DailyCapExceededError) || !stashHasIdentity) throw e;
        paidRun = { settledBy: undefined, outcome: undefined, reasons: [{ rung: "paid-ladder", reason: capSkipReason(e.message) }] };
      }
      // Concatenate reasons free-phase-then-paid-phase so an unresolved response still lists every rung
      // that actually ran, honestly, in the order it ran (including any preflight-skipped rung).
      ladderRun = { settledBy: paidRun.settledBy, outcome: paidRun.outcome, reasons: [...freeRun.reasons, ...preGated.skippedReasons, ...paidRun.reasons] };
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
    //
    // D6/Task 2 Step 3c (demotion ripple, intentional side effect): this guard still gates strictly on
    // the literal status "verified", so a demoted Go-UPC "suggested" hit no longer reaches it at all.
    // That is ACCEPTABLE (not a regression) - a suggestion is already review-first/lower-trust than a
    // verify, so it doesn't need this specific downgrade-to-conflict guard; only a genuine app-verified
    // "verified" claim (corpus/retail/Fetch-V2/GPT-evidence-corroborated, per decideDecode) still needs
    // the contradiction check against the retail corpus.
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
    // BUG #14 (QA hardening 2026-07-16) + goupc-cap-rootcause fix (2026-07-20): allMissReason names
    // every rung by its internal name and joins each rung's raw miss reason (provider names, internal
    // skip-reason codes like "gpt_call_failed") - it ALWAYS trips sanitizeCustomerReason's denylist, so
    // passing it straight through collapsed every all-miss decode (cap, rate-limit, timeout, outage,
    // genuine not-found alike) to the same generic boilerplate, hiding the honest reason from the
    // customer. Fix: classify the per-rung reasons into a specific missReasonCode BEFORE sanitizing
    // (allMissReasonCode) and use its hand-written, token-free honest text (MISS_REASON_TEXT) as the
    // input to sanitizeCustomerReason instead - it passes on its own merits (no denylisted token), so
    // the customer now sees WHY (cap / rate-limited / timed out / provider down / not found) without
    // any vendor/model name leaking. The RAW per-rung reasons stay in debug.ladderReasons (below,
    // platform-only, structured - richer than the old joined string) for diagnosis; missReasonCode is
    // also attached to debug so the UI/tests can key off it without parsing prose.
    const missReasonCode = allMissReasonCode(ladderRun.reasons);
    const honestAllMissReason = MISS_REASON_TEXT[missReasonCode] ?? MISS_REASON_TEXT.product_not_found;
    const cleanAllMissReason = sanitizeCustomerReason(honestAllMissReason);
    if (planDStash) {
      const cleanMergedReasonText = sanitizeCustomerReason(honestAllMissReason, { status: planDStash.decision.status });
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
          missReasonCode,
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
        missReasonCode,
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
      // A re-evaluation that the cap blocked still has the old guess in hand: replay it rather than
      // regressing an identity the shop has already been shown to "Unidentified" (owner 2026-08-19).
      // The stored row is left exactly as it is - nothing was recomputed, so there is nothing to
      // refresh, and its unchanged stamp means the next uncapped scan re-evaluates it properly.
      if (staleRow) return persistedReplay(staleRow.payload, staleRow.row, { cacheReevaluated: "cap_blocked" });
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
  // D6/Task 2 Step 3c AUDIT (demotion ripple): a demoted Go-UPC clean-exact hit now settles at status
  // "suggested" (was "verified") - CONFIRMED this is still covered by the `status === "suggested"`
  // branch immediately below, combined with classifySourceTier recognizing "go-upc" in providerNames as
  // "paid_rung". So a settled Go-UPC suggestion persists to L2 exactly as a verified one used to - the
  // honesty relabel does NOT reopen a pay-twice hole. See pipeline.test.ts's "a demoted Go-UPC
  // 'suggested' settle STILL persists to L2..." regression test (Task 2).
  //
  // A genuinely exhausted ladder persists NOTHING (owner 2026-08-20; receipts abolished). Anything
  // else (needs_review from a transient skip, or a
  // conflict, with no paid-rung identity) is left untouched - it stays retryable exactly like today's
  // short-TTL L1 miss cache. forceRetry's fresh compute overwrites whatever was there (persistDecode is
  // an upsert by code).
  //
  // Two additions (owner 2026-08-19): a free suggestion the PAID rungs already failed to beat persists
  // with the pay-once marker (paidEscalationExhausted), and a re-evaluated stale row that came back
  // VERIFIED overwrites itself even from a free rung - correcting a row that already exists is not the
  // same as minting a new free-rung row, so the "free wins never persist" rule still holds elsewhere.
  // Every row written here carries the knowledge stamp (withCacheStamp).
  const freshUsable = payload.results.some((r) => isUsableProductName(r.productName));
  // WHICH ANSWER OWNS THE ROW when a stale row was re-evaluated. A fresh usable answer takes it only
  // when it is VERIFIED, when it is itself PAID work, or when the stored row was never paid for. A bare
  // free title must not overwrite an identity the app already bought - that is a downgrade, not a
  // correction. In every other case the stored row is KEPT and the fallback below replays it.
  const freshSourceTier = classifySourceTier(payload.reasonCode, payload.providerNames);
  const keepsStaleRow =
    !!staleRow && !(freshUsable && (payload.decision.status === "verified" || !!freshSourceTier || !staleRow.row.sourceTier));
  if (!e2eMode() && !cached) {
    const status = payload.decision.status;
    const sourceTier = freshSourceTier;
    const hasUsableIdentity = freshUsable;
    // A stale row being re-evaluated is REPLACED by a fresh answer that outranks it (see keepsStaleRow
    // above; the fresh stamp records the knowledge it was computed under). A FREE-only pass keeps the
    // stored row's createdAt - only genuinely paid compute restarts the cooldown clock - and inherits
    // its sourceTier when the fresh outcome has none, so paid provenance is never quietly dropped.
    const replacesStaleRow = !!staleRow && !keepsStaleRow;
    const persistResult = (extra?: { paidEscalationExhausted?: true }) =>
      persistDecode({
        code: cacheKey, kind: "result", payload: withCacheStamp(payload, extra), tier: status,
        sourceTier: sourceTier ?? (replacesStaleRow ? staleRow!.row.sourceTier : undefined),
        createdAt: freeOnlyPass && staleRow ? staleRow.row.createdAt : Date.now(),
      });
    if (keepsStaleRow) {
      // The stored row won this pass; the STALE-ROW FALLBACK below re-persists it. Writing anything
      // here would clobber the very row we are keeping.
    } else if ((status === "verified" || status === "suggested") && (sourceTier || replacesStaleRow)) {
      await persistResult();
    } else if (sourceTier === "paid_rung" && hasUsableIdentity) {
      // A paid_rung suggestion that never reached "verified"/"suggested" status (e.g. goupc_inferred
      // stays "needs_review") - still paid work, still persists, tier records the true status.
      await persistResult();
    } else if (paidEscalationExhausted && hasUsableIdentity) {
      // The marker's whole effect is written HERE: it makes a FREE suggestion persist as a row, so the
      // next scan of this code is served by the ordinary replay above and never re-buys the paid misses
      // this pass already paid for. Nothing reads the marker back in the staleness decision - it is
      // carried forward on refresh so the row keeps saying it already exhausted its paid rungs.
      await persistResult({ paidEscalationExhausted: true });
    }
    // A genuinely exhausted ladder persists NOTHING (owner ruling 2026-08-20: no-candidate rows are
    // abolished; the next scan of this code re-runs the full ladder). Never reintroduce a
    // "no_result_receipt", cooldown, or any other negative-result memory here.
  }

  // STALE-ROW FALLBACK (owner 2026-08-19): the re-evaluation above ran because a cached guess had gone
  // stale. A fresh answer only takes the row when it outranks the stored one (keepsStaleRow above); it
  // was persisted just above. Otherwise the cached guess replays, with its stamp refreshed but its
  // ORIGINAL createdAt kept, so the row is re-checked after the next knowledge change and its cooldown
  // still lapses on schedule: a best guess already shown never regresses to "Unidentified", and a
  // frequently rebuilt corpus never postpones the row's one honest paid retry forever. The L1 entry is
  // overwritten with the replayed guess too - otherwise the free pass's short-TTL miss would serve
  // "Unidentified" for the rest of that window - but with the ordinary MISS TTL, so a long-lived
  // process re-evaluates the row again later instead of pinning the guess in memory forever.
  // E2E never reaches here: staleRow is only ever set by the L2 read, skipped under e2eMode().
  if (staleRow && (!freshUsable || keepsStaleRow)) {
    // The pay-once marker survives the refresh (a row that already exhausted paid rungs still has).
    const marker = readCacheStamp(staleRow.payload).paidEscalationExhausted ? ({ paidEscalationExhausted: true } as const) : undefined;
    await persistDecode({
      code: cacheKey, kind: "result", payload: withCacheStamp(staleRow.payload, marker),
      tier: staleRow.row.tier, sourceTier: staleRow.row.sourceTier, createdAt: staleRow.row.createdAt,
    });
    setDecodeCache(cacheKey, staleRow.payload, Number(process.env.DECODE_MISS_TTL_MS || 600_000));
    return persistedReplay(staleRow.payload, staleRow.row, { cacheReevaluated: freeOnlyPass ? "free_rungs_only" : "full" });
  }

  // TASK 21 (owner-ratified 2026-07-15): LEARNED-PRODUCTS WRITE. Fire-and-forget, best-effort - a
  // learned-tier write failure must never affect the scan response (same posture as the A4 outcome
  // ledger). Only on a genuinely FRESH compute (never a cache replay, never a joined in-flight
  // request, never under E2E) and only when the full shouldLearnDecode gate passes: verified status +
  // app-verified exact code + fetched_source strength + a trusted product host + the barcode's own
  // GS1 prefix POSITIVELY CORROBORATING the decoded brand (never merely "no conflict") + (for tires)
  // the required tire specs. A joined in-flight waiter never writes here - the winning caller's own
  // pass through this same code path already would have (winner-only, same rule as the ledger above).
  //
  // D6/Task 2 Step 3c AUDIT: a demoted Go-UPC hit (now "suggested") no longer reaches this branch at
  // all. This is correct and was ALREADY true before the relabel - Go-UPC never carried
  // evidenceStrength "fetched_source" honestly (that field is now "none"), so `winningSourceUrl` would
  // have been "" and the gate below would have skipped it regardless of status. No behavior change.
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

  return { kind: "computed", payload, cached, paidComputeCharged };
}
