import "server-only";

import type { AiLookupResult, DecodeDecision, EvidenceResult } from "@/types";
import { emptyResult } from "@/decoding/provider";
import type { ProviderStatus } from "@/decoding/decodeProviderStatus";
import { decideDecode, isExampleOrTestRow, isUsableProductName } from "@/decoding/decode";
import { getDecodeCache, withDecodeCache } from "@/decoding/decodeCache";
import { sanitizeCustomerReason } from "@/decoding/decodeFallback";
import {
  GPT_DECODE_WORST_CASE_USD,
  decodeWithGpt,
  type GptDecodeResult,
} from "@/decoding/gptDecodeClient";
import { mapGptDecodeResult, shouldRunGptDecode } from "@/decoding/gptDecodePolicy";
import { prefixFloorNameFull as prefixFloorName } from "@/server/catalog/prefixIndexServer";
import { lookupMasterCatalog } from "@/server/catalog/masterLookup";
import { getDecodeKnowledgeVersion } from "@/decoding/server/pipeline/knowledgeVersion";
import { getPersistedDecode, persistDecode, type PersistedDecode } from "@/decoding/server/cache/decodeCacheStore";
import { getLearnedProduct, type LearnedProductRow } from "@/decoding/server/cache/learnedProducts";
import {
  lookupRetailBarcodeAsync,
  getLastRetailLookupStatus,
  type RetailLookupResult,
} from "@/decoding/server/knowledge/retail/retailKnowledgeIndex";
import {
  resolveExactBarcode,
  resolveExactPartNumber,
  type CorpusDecodeResult,
} from "@/decoding/server/knowledge/tire/TireKnowledgeProvider";
import { decodeStorage } from "@/decoding/server/pipeline/storage";
import {
  chargeDailySlot,
  chargeDailySlotConditional,
  chargeDailySlotForAccount,
  chargeDailySlotForAccountConditional,
  checkGptDecodeBudget,
  intEnv,
  recordGptDecodeCall,
  recordGptDecodeSpend,
  refundDailySlot,
} from "@/decoding/limits/aiSpendGuard";
import { canonicalGtin, isGtinShaped } from "@/products/barcodes/gtin";
import { isLikelyMisreadGtin } from "@/products/barcodes/misread";

const GPT_PROVIDER = "gpt-5.4-mini";
const GPT_MIN_VIABLE_MS = 20_000;
const DEFAULT_DECODE_BUDGET_MS = 45_000;

export class DailyCapExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly scope: "global" | "account" = "global",
  ) {
    super(`${scope === "account" ? "Account" : "Daily AI lookup"} cap reached (${used}/${limit}). No paid call made.`);
    this.name = "DailyCapExceededError";
  }
}

/**
 * One immutable paid authorization shared by every caller in a decode attempt. The first caller
 * starts settlement; concurrent callers await that same promise. A failed settlement remains failed,
 * so no later provider egress can slip through after a counter or quota write rejected.
 */
export function createPaidEgressCoordinator(settle: () => Promise<void>): { authorize: () => Promise<void> } {
  let settlement: Promise<void> | null = null;
  return {
    authorize() {
      settlement ??= Promise.resolve().then(settle);
      return settlement;
    },
  };
}

export function e2eMode(): boolean {
  return process.env.IS_E2E === "1";
}

export interface DecodePipelineRequest {
  code: string;
  codeType: ReturnType<typeof import("@/products/match/codeTypeDetector").detectCodeType>;
  rawCodeSanitized: string;
  cleanCodeSanitized: string;
  threshold: number;
  allowNonPublicAutoCount: boolean;
  forceRetry: boolean;
  scanContext?: "any" | "tire";
  mockGptDecode?: Partial<GptDecodeResult>;
  budgetMs?: number;
  capContext?: { authedBusinessId?: string; accountLimit?: number };
  god?: boolean;
}

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

export type DecodePipelineResult =
  | { kind: "persisted"; body: Record<string, unknown> }
  | {
      kind: "cap_blocked";
      message: string;
      reasonCode: "daily_cap" | "account_daily_cap";
      floor?: import("@/products/catalog/prefixFloor").PrefixFloorResult;
    }
  | { kind: "computed"; payload: DecodePayload; cached: boolean; paidComputeCharged: boolean };

function status(provider: string, code: ProviderStatus["status"], detail?: Partial<ProviderStatus>): ProviderStatus {
  return {
    provider,
    status: code,
    latencyMs: 0,
    sourceUrlsReturned: 0,
    exactCodeFound: false,
    identityFound: false,
    ...detail,
  };
}

function corpusPayload(
  corpus: CorpusDecodeResult,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  return {
    mode: "decode",
    providerNames: corpus.providerNames,
    results: corpus.results,
    evidences: corpus.evidences,
    providerStatuses: [status("tire-corpus", "ok", { exactCodeFound: true, identityFound: true })],
    decision: corpus.decision,
    reasonCode: "ok",
    reasonText: "",
    timedOut: false,
    debug: {
      providersAttempted: corpus.providerNames,
      evidenceStrengths: corpus.evidences.map((evidence) => evidence.strength),
      sourceCounts: [0],
      corroborationPath: corpus.path,
      aiCalled: false,
      pageFetched: false,
      cached: false,
    },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

function learnedPayload(
  row: LearnedProductRow,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  let source = row.sourceUrl;
  try {
    source = new URL(row.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    // Preserve the stored source label if it is not a URL.
  }
  const learnedDate = (row.createdAt || "").slice(0, 10) || "unknown date";
  const reason = `Suggested from previously learned product evidence (${source}, ${learnedDate}). Review before confirming.`;
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
    matchedSources: result.sourceUrls,
    reason: "Previously learned evidence was replayed and was not independently re-verified for this scan.",
  };
  const decision: DecodeDecision = {
    status: "suggested",
    confidence: row.confidence,
    reason,
    evidenceStrength: row.evidenceStrength,
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: row.confidence,
      reason: "Previously learned product evidence.",
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
  return {
    mode: "decode",
    providerNames: ["learned-products"],
    results: [result],
    evidences: [evidence],
    providerStatuses: [status("learned-products", "ok", { sourceUrlsReturned: result.sourceUrls.length, identityFound: true })],
    decision,
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["learned-products"], aiCalled: false, cached: false, learnedTier: true },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

function retailPayload(
  row: RetailLookupResult,
  code: string,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  const confidence = 0.85;
  const reason = "Matched the shared retail corpus by exact barcode. No paid lookup was needed.";
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: row.productName,
    brand: row.brand,
    category: row.category,
    confidence,
    needsHumanReview: true,
    verifiedFacts: [`Retail corpus exact barcode: ${code}`],
  };
  const decision: DecodeDecision = {
    status: "suggested",
    confidence,
    reason,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence,
      reason: "Retail corpus exact barcode.",
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
  return {
    mode: "decode",
    providerNames: ["retail-corpus"],
    results: [result],
    evidences: [],
    providerStatuses: [status("retail-corpus", "ok", { exactCodeFound: true, identityFound: true })],
    decision,
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["retail-corpus"], aiCalled: false, cached: false, retailLookup: getLastRetailLookupStatus() },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

function masterCatalogPayload(
  entry: { name?: string; brand?: string; category?: string },
  code: string,
  rawCodeSanitized: string,
  cleanCodeSanitized: string,
): DecodePayload {
  const reason = "Matched an owner-approved shared catalog entry by exact barcode. No paid lookup was needed.";
  const result: AiLookupResult = {
    ...emptyResult(),
    productName: entry.name ?? "",
    brand: entry.brand ?? "",
    category: entry.category ?? "",
    confidence: 1,
    needsHumanReview: false,
    verifiedFacts: [`Owner-approved catalog exact barcode: ${code}`],
  };
  const evidence: EvidenceResult = {
    verified: true,
    strength: "fetched_source",
    matchedCode: code,
    matchedSources: [],
    reason: "Owner-approved shared catalog replay.",
  };
  const decision: DecodeDecision = {
    status: "verified",
    confidence: 1,
    reason,
    evidenceStrength: evidence.strength,
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: {
      decision: "single_provider",
      confidence: 1,
      reason: "Owner-approved shared catalog exact barcode.",
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
  return {
    mode: "decode",
    providerNames: ["master-catalog"],
    results: [result],
    evidences: [evidence],
    providerStatuses: [status("master-catalog", "ok", { exactCodeFound: true, identityFound: true })],
    decision,
    reasonCode: "ok",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["master-catalog"], aiCalled: false, cached: false },
    sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
  };
}

function normalizeMockGpt(raw: Partial<GptDecodeResult> | undefined): GptDecodeResult | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    tier: raw.tier ?? "none",
    brand: raw.brand ?? "",
    productName: raw.productName ?? "",
    category: raw.category ?? "",
    specs: raw.specs ?? "",
    gtin: raw.gtin ?? "",
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    exactCodeFound: raw.exactCodeFound === true,
    basis: raw.basis ?? "",
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [],
    searches: typeof raw.searches === "number" ? raw.searches : 0,
    usdComputedFloor: 0,
    usdWorstCase: GPT_DECODE_WORST_CASE_USD,
    aborted: false,
  };
}

export function classifyGptFailureDetail(rawError: string | undefined): string {
  if (!rawError) return "other";
  const httpMatch = /^HTTP (\d{3})$/.exec(rawError);
  if (httpMatch) {
    const statusCode = Number(httpMatch[1]);
    if (statusCode === 429) return "429";
    if (statusCode >= 500) return "5xx";
    return String(statusCode);
  }
  if (rawError.startsWith("openai_auth_failed")) return "401";
  if (rawError === "model returned non-JSON") return "bad_json";
  if (rawError === "empty productName") return "no_match";
  if (/abort/i.test(rawError)) return "timeout";
  return "network";
}

export function classifySourceTier(reasonCode: string, providerNames: string[]): "gpt_5_4_mini" | null {
  return reasonCode === "gpt_decode" && providerNames.includes(GPT_PROVIDER) ? "gpt_5_4_mini" : null;
}

function cachePayload(payload: DecodePayload): string {
  return JSON.stringify({
    ...payload,
    debug: {
      ...payload.debug,
      cache: { knowledgeVersion: getDecodeKnowledgeVersion() },
    },
  });
}

function parsePersisted(row: PersistedDecode): DecodePayload | null {
  try {
    const payload = JSON.parse(row.payload) as DecodePayload;
    if (payload.mode !== "decode" || !Array.isArray(payload.results)) return null;
    if (payload.reasonCode === "no_result") return null;
    const result = payload.results.find((candidate) => isUsableProductName(candidate.productName));
    if (!result) return null;
    if (isExampleOrTestRow(row.code, result.productName, result.brand)) return null;
    if (isLikelyMisreadGtin(row.code)) return null;
    return payload;
  } catch {
    return null;
  }
}

function persistedBody(payload: DecodePayload, row: PersistedDecode): Record<string, unknown> {
  return {
    ...payload,
    debug: {
      ...payload.debug,
      cached: true,
      persistentCache: true,
      persistentCacheCreatedAt: row.createdAt,
      aiCalled: false,
    },
  };
}

function noResultPayload(req: DecodePipelineRequest, providerStatuses: ProviderStatus[], reason: string): DecodePayload {
  const floor = prefixFloorName(req.code, req.codeType);
  const results: AiLookupResult[] = floor
    ? [{ ...emptyResult(), productName: floor.name, brand: floor.brand, confidence: 0.3, needsHumanReview: true }]
    : [];
  const decision = decideDecode({
    codeType: req.codeType,
    results: [],
    evidences: [],
    confidenceThreshold: req.threshold,
    code: req.code,
    scanContext: req.scanContext,
    brandPrefixConflict: false,
    allowNonPublicAutoCount: req.allowNonPublicAutoCount,
  });
  const customerReason = sanitizeCustomerReason(reason, { status: decision.status });
  return {
    mode: "decode",
    providerNames: providerStatuses.map((provider) => provider.provider),
    results,
    evidences: [],
    providerStatuses,
    decision: { ...decision, reason: customerReason },
    reasonCode: "no_result",
    reasonText: customerReason,
    timedOut: providerStatuses.some((provider) => provider.status === "timeout"),
    debug: {
      providersAttempted: providerStatuses.map((provider) => provider.provider),
      decodePath: "no-match",
      aiCalled: providerStatuses.some((provider) => provider.provider === GPT_PROVIDER && provider.status !== "skipped"),
      cached: false,
      retailLookup: getLastRetailLookupStatus(),
    },
    sanitizedInput: { rawCodeSanitized: req.rawCodeSanitized, cleanCodeSanitized: req.cleanCodeSanitized },
  };
}

async function settlePaidAuthorization(
  req: DecodePipelineRequest,
  onCharged: () => void,
): Promise<void> {
  if (e2eMode()) return;
  const storage = await decodeStorage();
  const dailyLimit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
  const globalLimit = req.capContext?.authedBusinessId
    ? intEnv(process.env.AI_LOOKUP_GLOBAL_BACKSTOP, dailyLimit * 10)
    : dailyLimit;

  if (req.god) {
    await chargeDailySlot(storage, { limit: globalLimit });
  } else {
    const global = await chargeDailySlotConditional(storage, { limit: globalLimit });
    if (!global.granted) throw new DailyCapExceededError(global.used, global.limit, "global");
  }

  if (req.capContext?.authedBusinessId) {
    const businessId = req.capContext.authedBusinessId;
    if (req.god) {
      try {
        await chargeDailySlotForAccount(storage, businessId);
      } catch (error) {
        console.error(JSON.stringify({
          src: "scanbin",
          route: "decode/pipeline",
          event: "charge_pair_incomplete",
          businessId,
          error: error instanceof Error ? error.message : String(error),
          ts: new Date().toISOString(),
        }));
      }
    } else {
      const accountLimit = req.capContext.accountLimit ?? intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, dailyLimit);
      let account: { used: number; granted: boolean };
      try {
        account = await chargeDailySlotForAccountConditional(storage, businessId, accountLimit);
      } catch (error) {
        console.error(JSON.stringify({
          src: "scanbin",
          route: "decode/pipeline",
          event: "charge_pair_incomplete",
          businessId,
          error: error instanceof Error ? error.message : String(error),
          ts: new Date().toISOString(),
        }));
        account = { used: 0, granted: true };
      }
      if (!account.granted) {
        try {
          await refundDailySlot(storage);
        } catch {
          // Conservative over-count is safer than an unmetered call.
        }
        throw new DailyCapExceededError(account.used, accountLimit, "account");
      }
    }
  }

  onCharged();
}

async function appendOutcome(
  req: DecodePipelineRequest,
  startedAt: number,
  payload: DecodePayload | null,
  statusText: string,
  sourceTier: string | null,
): Promise<void> {
  if (e2eMode()) return;
  try {
    const storage = await decodeStorage();
    await storage.appendOutcome({
      code: req.code,
      canonicalGtin: canonicalGtin(req.code) ?? req.code,
      settledBy: payload?.providerNames[0] ?? null,
      status: statusText,
      reasons: [],
      durationMs: Date.now() - startedAt,
      sourceTier,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Observability must never block a scan.
  }
}

export async function runDecodePipeline(req: DecodePipelineRequest): Promise<DecodePipelineResult> {
  const startedAt = Date.now();
  const cacheKey = canonicalGtin(req.code) ?? req.code;
  let paidComputeCharged = false;

  const deterministic = async (): Promise<DecodePayload | null> => {
    const tire = isGtinShaped(req.code)
      ? await resolveExactBarcode(req.code)
      : await resolveExactPartNumber(req.code);
    if (tire) return corpusPayload(tire, req.rawCodeSanitized, req.cleanCodeSanitized);

    if (isGtinShaped(req.code) && !isLikelyMisreadGtin(req.code)) {
      const retail = await lookupRetailBarcodeAsync(req.code);
      if (retail) return retailPayload(retail, req.code, req.rawCodeSanitized, req.cleanCodeSanitized);
    }

    const learned = await getLearnedProduct(cacheKey);
    if (learned) return learnedPayload(learned, req.rawCodeSanitized, req.cleanCodeSanitized);

    const master = await lookupMasterCatalog(req.code);
    if (master.kind === "verified") {
      return masterCatalogPayload(master.entry, req.code, req.rawCodeSanitized, req.cleanCodeSanitized);
    }
    return null;
  };

  const free = await deterministic();
  if (free) {
    void appendOutcome(req, startedAt, free, free.decision.status, null);
    return { kind: "computed", payload: free, cached: false, paidComputeCharged: false };
  }

  if (!e2eMode() && !req.forceRetry && getDecodeCache(cacheKey) === undefined) {
    const persisted = await getPersistedDecode(cacheKey);
    if (persisted) {
      const payload = parsePersisted(persisted);
      if (payload) {
        void appendOutcome(req, startedAt, payload, `cached:${payload.decision.status}`, persisted.sourceTier ?? null);
        return { kind: "persisted", body: persistedBody(payload, persisted) };
      }
    }
  }

  const compute = async (): Promise<DecodePayload> => {
    if (isExampleOrTestRow(req.code, "")) {
      return noResultPayload(req, [], "This example or test code is intentionally excluded from live lookup.");
    }
    if (isLikelyMisreadGtin(req.code)) {
      return noResultPayload(req, [], "This barcode may be misread or may use a non-standard check digit. Review it manually.");
    }

    const mock = e2eMode() ? normalizeMockGpt(req.mockGptDecode) : null;
    if (e2eMode() && !mock) {
      return noResultPayload(req, [status(GPT_PROVIDER, "skipped", { errorCode: "e2e_mode" })], "Live lookup is disabled in test mode.");
    }

    const deadlineAt = startedAt + Math.max(DEFAULT_DECODE_BUDGET_MS, req.budgetMs ?? 0);
    const remainingMs = deadlineAt - Date.now();
    if (!mock && remainingMs < GPT_MIN_VIABLE_MS) {
      return noResultPayload(req, [status(GPT_PROVIDER, "skipped", { errorCode: "insufficient_time" })], "The lookup ran out of time before a paid call could safely start.");
    }

    const storage = e2eMode() ? undefined : await decodeStorage();
    const gate = mock
      ? { run: true, skipReason: "" }
      : await shouldRunGptDecode({
          code: req.code,
          codeType: req.codeType,
          apiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
          budget: req.god
            ? async () => ({ allowed: true, spentUsd: 0, capUsd: Number.POSITIVE_INFINITY })
            : async () => checkGptDecodeBudget({ storage, worstCaseUsd: GPT_DECODE_WORST_CASE_USD }),
        });
    if (!gate.run) {
      return noResultPayload(req, [status(GPT_PROVIDER, "skipped", { errorCode: gate.skipReason })], "Live lookup is unavailable right now.");
    }

    if (!mock) {
      const coordinator = createPaidEgressCoordinator(() => settlePaidAuthorization(req, () => { paidComputeCharged = true; }));
      try {
        await coordinator.authorize();
      } catch (error) {
        if (error instanceof DailyCapExceededError) throw error;
        return noResultPayload(
          req,
          [status(GPT_PROVIDER, "skipped", { errorCode: "charge_unavailable" })],
          "Live lookup is unavailable right now.",
        );
      }
    }

    const gptStartedAt = Date.now();
    const gpt = mock ?? await decodeWithGpt(req.code, {
      apiKey: process.env.OPENAI_API_KEY ?? "",
      timeoutMs: Math.min(35_000, Math.max(1, deadlineAt - Date.now())),
    });

    if (!mock && storage) {
      const chargedSpend = gpt.aborted ? GPT_DECODE_WORST_CASE_USD : gpt.usdComputedFloor;
      await Promise.allSettled([
        recordGptDecodeSpend(chargedSpend, { storage }),
        recordGptDecodeCall({ storage }),
      ]);
    }

    const mapped = mapGptDecodeResult(gpt, req.code);
    if (!mapped) {
      const detail = classifyGptFailureDetail(gpt.error);
      const providerCode: ProviderStatus["status"] = detail === "429"
        ? "rate_limited"
        : detail === "timeout"
          ? "timeout"
          : detail === "no_match"
            ? "no_match"
            : "error";
      return noResultPayload(
        req,
        [status(GPT_PROVIDER, providerCode, { latencyMs: Date.now() - gptStartedAt, errorCode: detail })],
        detail === "no_match" ? "No match was found in the available corpus or web evidence." : "Live lookup could not confirm this item.",
      );
    }

    return {
      mode: "decode",
      providerNames: [GPT_PROVIDER],
      results: [mapped.result],
      evidences: [],
      providerStatuses: [status(GPT_PROVIDER, "ok", {
        latencyMs: Date.now() - gptStartedAt,
        sourceUrlsReturned: mapped.result.sourceUrls.length,
        exactCodeFound: gpt.exactCodeFound,
        identityFound: true,
      })],
      decision: mapped.decision,
      reasonCode: "gpt_decode",
      reasonText: mapped.reasonText,
      timedOut: false,
      debug: {
        providersAttempted: [GPT_PROVIDER],
        decodePath: GPT_PROVIDER,
        aiCalled: !mock,
        searches: gpt.searches,
        cached: false,
      },
      sanitizedInput: { rawCodeSanitized: req.rawCodeSanitized, cleanCodeSanitized: req.cleanCodeSanitized },
    };
  };

  let payload: DecodePayload;
  let cached = false;
  let joined = false;
  try {
    const outcome = e2eMode()
      ? { value: await compute(), cached: false }
      : await withDecodeCache(
          cacheKey,
          (value) => value.reasonCode === "gpt_decode" && value.results.some((result) => isUsableProductName(result.productName)),
          compute,
          { forceRefresh: req.forceRetry },
        );
    payload = outcome.value;
    cached = outcome.cached;
    joined = Boolean((outcome as { joined?: true }).joined);
  } catch (error) {
    if (!(error instanceof DailyCapExceededError)) throw error;
    const floor = prefixFloorName(req.code, req.codeType) ?? undefined;
    void appendOutcome(req, startedAt, null, "cap_blocked", null);
    return {
      kind: "cap_blocked",
      message: error.message,
      reasonCode: error.scope === "account" ? "account_daily_cap" : "daily_cap",
      floor,
    };
  }

  const sourceTier = classifySourceTier(payload.reasonCode, payload.providerNames);
  if (!e2eMode() && !cached && sourceTier && payload.results.some((result) => isUsableProductName(result.productName))) {
    await persistDecode({
      code: cacheKey,
      kind: "result",
      payload: cachePayload(payload),
      tier: payload.decision.status,
      sourceTier,
      createdAt: Date.now(),
    });
  }

  if (!joined) {
    void appendOutcome(req, startedAt, payload, cached ? `cached:${payload.decision.status}` : payload.decision.status, sourceTier);
  }
  return { kind: "computed", payload, cached, paidComputeCharged };
}
