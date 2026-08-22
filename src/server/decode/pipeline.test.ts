import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", () => ({
  resolveExactBarcode: vi.fn(),
  resolveExactPartNumber: vi.fn(),
}));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  lookupRetailBarcodeAsync: vi.fn(),
  getLastRetailLookupStatus: vi.fn(() => "turso_miss"),
}));
vi.mock("@/server/learnedProducts", () => ({ getLearnedProduct: vi.fn() }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: vi.fn() }));
vi.mock("@/server/catalog/prefixIndexServer", () => ({ prefixFloorNameFull: vi.fn(() => null) }));
vi.mock("@/server/decodeCacheStore", () => ({
  getPersistedDecode: vi.fn(),
  persistDecode: vi.fn(),
}));
vi.mock("@/server/decode/storage", () => ({ decodeStorage: vi.fn() }));
vi.mock("@/services/ai/gptDecodeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/gptDecodeClient")>();
  return { ...actual, decodeWithGpt: vi.fn() };
});
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...actual,
    chargeDailySlot: vi.fn(),
    chargeDailySlotConditional: vi.fn(),
    chargeDailySlotForAccount: vi.fn(),
    chargeDailySlotForAccountConditional: vi.fn(),
    checkGptDecodeBudget: vi.fn(),
    recordGptDecodeCall: vi.fn(),
    recordGptDecodeSpend: vi.fn(),
    refundDailySlot: vi.fn(),
  };
});

import { emptyResult } from "@/services/ai/provider";
import { clearDecodeCache, __clearInFlightForTest } from "@/services/ai/decodeCache";
import { detectCodeType } from "@/services/codeTypeDetector";
import { decodeWithGpt, GPT_DECODE_WORST_CASE_USD, type GptDecodeResult } from "@/services/ai/gptDecodeClient";
import {
  chargeDailySlotConditional,
  chargeDailySlotForAccountConditional,
  checkGptDecodeBudget,
  recordGptDecodeCall,
  recordGptDecodeSpend,
  refundDailySlot,
} from "@/services/security/aiSpendGuard";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { lookupRetailBarcodeAsync } from "@/server/retail-knowledge/retailKnowledgeIndex";
import { getLearnedProduct } from "@/server/learnedProducts";
import { lookupMasterCatalog } from "@/server/catalog/masterLookup";
import { prefixFloorNameFull } from "@/server/catalog/prefixIndexServer";
import { getPersistedDecode, persistDecode } from "@/server/decodeCacheStore";
import { decodeStorage } from "@/server/decode/storage";
import {
  classifyGptFailureDetail,
  classifySourceTier,
  createPaidEgressCoordinator,
  runDecodePipeline,
  type DecodePayload,
  type DecodePipelineRequest,
} from "@/server/decode/pipeline";

const CODE = "049000006346";

const storage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
  increment: vi.fn(async () => 1),
  incrementBy: vi.fn(async () => 0),
  incrementIfBelow: vi.fn(async () => ({ value: 1, granted: true })),
  readUsage: vi.fn(async () => ({ month: "2026-08", used: 0 })),
  writeUsage: vi.fn(async () => undefined),
  incrementUsage: vi.fn(async () => 1),
  appendArchive: vi.fn(async () => undefined),
  appendOutcome: vi.fn(async () => undefined),
};

function request(code = CODE): DecodePipelineRequest {
  return {
    code,
    codeType: detectCodeType(code),
    rawCodeSanitized: code,
    cleanCodeSanitized: code,
    threshold: 0.8,
    allowNonPublicAutoCount: false,
    forceRetry: false,
    scanContext: "any",
  };
}

function gpt(overrides: Partial<GptDecodeResult> = {}): GptDecodeResult {
  return {
    tier: "suggested",
    brand: "Acme",
    productName: "Acme Product",
    category: "Retail",
    specs: "",
    gtin: CODE,
    confidence: 0.78,
    exactCodeFound: true,
    basis: "Found on a product page",
    sourceUrls: ["https://example.com/product"],
    searches: 1,
    usdComputedFloor: 0.02,
    usdWorstCase: GPT_DECODE_WORST_CASE_USD,
    aborted: false,
    ...overrides,
  };
}

function cachedPayload(name = "Cached Product"): DecodePayload {
  const result = { ...emptyResult(), productName: name, brand: "Cached", confidence: 0.75, needsHumanReview: true };
  return {
    mode: "decode",
    providerNames: ["gpt-5.4-mini"],
    results: [result],
    evidences: [],
    providerStatuses: [],
    decision: {
      status: "suggested",
      confidence: 0.75,
      reason: "Cached suggestion",
      evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0.75, reason: "cached", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
    reasonCode: "gpt_decode",
    reasonText: "Cached suggestion",
    timedOut: false,
    debug: {},
    sanitizedInput: { rawCodeSanitized: CODE, cleanCodeSanitized: CODE },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearDecodeCache();
  __clearInFlightForTest();
  process.env.IS_E2E = "0";
  process.env.OPENAI_API_KEY = "test-only";
  process.env.AI_LOOKUP_DAILY_LIMIT = "10";
  process.env.AI_LOOKUP_GLOBAL_BACKSTOP = "100";
  vi.mocked(resolveExactBarcode).mockResolvedValue(null);
  vi.mocked(resolveExactPartNumber).mockResolvedValue(null);
  vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue(null);
  vi.mocked(getLearnedProduct).mockResolvedValue(null);
  vi.mocked(lookupMasterCatalog).mockResolvedValue({ kind: "miss" });
  vi.mocked(prefixFloorNameFull).mockReset().mockReturnValue(null);
  vi.mocked(getPersistedDecode).mockReset().mockResolvedValue(null);
  vi.mocked(decodeStorage).mockReset().mockResolvedValue(storage);
  vi.mocked(checkGptDecodeBudget).mockReset().mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 3 });
  vi.mocked(chargeDailySlotConditional).mockReset().mockResolvedValue({ used: 1, limit: 10, granted: true });
  vi.mocked(chargeDailySlotForAccountConditional).mockReset().mockResolvedValue({ used: 1, granted: true });
  vi.mocked(decodeWithGpt).mockReset().mockResolvedValue(gpt());
});

describe("runDecodePipeline", () => {
  it("settles a tire-corpus hit before cache or paid work", async () => {
    const result = { ...emptyResult(), productName: "Corpus Tire", brand: "Acme", confidence: 1, needsHumanReview: false };
    vi.mocked(resolveExactBarcode).mockResolvedValue({
      providerNames: ["tire-corpus"],
      results: [result],
      evidences: [{ verified: true, strength: "fetched_source", matchedCode: CODE, matchedSources: [], reason: "corpus" }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "corpus",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheck: { decision: "single_provider", confidence: 1, reason: "corpus", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
        corroborationPath: "corpus_exact_barcode",
      },
      path: "corpus_exact_barcode",
    });

    const out = await runDecodePipeline(request());

    expect(out.kind).toBe("computed");
    if (out.kind !== "computed") throw new Error("unreachable");
    expect(out.payload.results[0].productName).toBe("Corpus Tire");
    expect(out.paidComputeCharged).toBe(false);
    expect(getPersistedDecode).not.toHaveBeenCalled();
    expect(decodeWithGpt).not.toHaveBeenCalled();
  });

  it("uses the retail corpus, learned products, and approved master catalog in that order", async () => {
    vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({ productName: "Retail Product", brand: "Retail", category: "Food", barcode: CODE });
    const retail = await runDecodePipeline(request());
    expect(retail.kind === "computed" && retail.payload.providerNames).toEqual(["retail-corpus"]);

    clearDecodeCache();
    vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue(null);
    vi.mocked(getLearnedProduct).mockResolvedValue({
      code: CODE,
      name: "Learned Product",
      brand: "Learned",
      category: "Retail",
      specsShort: "",
      specsFull: "",
      confidence: 0.8,
      sourceUrl: "https://example.com/product",
      evidenceStrength: "snippet",
      prefixCheck: "match",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const learned = await runDecodePipeline(request());
    expect(learned.kind === "computed" && learned.payload.providerNames).toEqual(["learned-products"]);
    expect(lookupMasterCatalog).not.toHaveBeenCalled();

    clearDecodeCache();
    vi.mocked(getLearnedProduct).mockResolvedValue(null);
    vi.mocked(lookupMasterCatalog).mockResolvedValue({
      kind: "verified",
      entry: { name: "Approved Product", brand: "Approved", category: "Retail" } as never,
    });
    const master = await runDecodePipeline(request());
    expect(master.kind === "computed" && master.payload.providerNames).toEqual(["master-catalog"]);
    expect(master.kind === "computed" && master.payload.decision.status).toBe("verified");
    expect(decodeWithGpt).not.toHaveBeenCalled();
  });

  it("replays a positive persistent cache without authorizing paid work", async () => {
    const payload = cachedPayload();
    vi.mocked(getPersistedDecode).mockResolvedValue({
      code: CODE,
      kind: "result",
      payload: JSON.stringify(payload),
      tier: "suggested",
      sourceTier: "gpt_5_4_mini",
      createdAt: 1,
    });

    const out = await runDecodePipeline(request());

    expect(out.kind).toBe("persisted");
    const results = out.kind === "persisted" ? out.body.results as Array<{ productName: string }> : [];
    expect(results[0]).toMatchObject({ productName: "Cached Product" });
    expect(chargeDailySlotConditional).not.toHaveBeenCalled();
    expect(decodeWithGpt).not.toHaveBeenCalled();
  });

  it("makes GPT-5.4 mini the only paid provider and never treats its self-report as verified", async () => {
    vi.mocked(decodeWithGpt).mockResolvedValue(gpt({ tier: "verified", confidence: 0.99 }));

    const out = await runDecodePipeline(request());

    expect(out.kind).toBe("computed");
    if (out.kind !== "computed") throw new Error("unreachable");
    expect(out.payload.providerNames).toEqual(["gpt-5.4-mini"]);
    expect(out.payload.providerStatuses.every((provider) => provider.provider === "gpt-5.4-mini")).toBe(true);
    expect(out.payload.decision.status).toBe("suggested");
    expect(out.payload.debug.ladderPath).toBeUndefined();
    expect(out.paidComputeCharged).toBe(true);
    expect(chargeDailySlotConditional).toHaveBeenCalledOnce();
    expect(recordGptDecodeSpend).toHaveBeenCalledWith(0.02, { storage });
    expect(recordGptDecodeCall).toHaveBeenCalledWith({ storage });
    expect(persistDecode).toHaveBeenCalledOnce();
  });

  it("does not charge or persist when GPT is unavailable or finds no product", async () => {
    delete process.env.OPENAI_API_KEY;
    const unavailable = await runDecodePipeline(request());
    expect(unavailable.kind === "computed" && unavailable.payload.reasonCode).toBe("no_result");
    expect(chargeDailySlotConditional).not.toHaveBeenCalled();
    expect(persistDecode).not.toHaveBeenCalled();

    clearDecodeCache();
    process.env.OPENAI_API_KEY = "test-only";
    vi.mocked(decodeWithGpt).mockResolvedValue(gpt({ tier: "none", productName: "", error: "empty productName", usdComputedFloor: 0.01 }));
    const miss = await runDecodePipeline(request());
    expect(miss.kind === "computed" && miss.payload.reasonCode).toBe("no_result");
    expect(persistDecode).not.toHaveBeenCalled();
  });

  it("does not cache a prefix-floor placeholder when GPT finds no product", async () => {
    vi.mocked(prefixFloorNameFull).mockReturnValue({
      name: "Coca-Cola / product unconfirmed",
      brand: "Coca-Cola",
    });
    vi.mocked(decodeWithGpt).mockResolvedValue(gpt({
      tier: "none",
      productName: "",
      error: "empty productName",
      usdComputedFloor: 0.01,
    }));

    const first = await runDecodePipeline(request());
    const second = await runDecodePipeline(request());

    expect(first).toMatchObject({
      kind: "computed",
      cached: false,
      payload: {
        reasonCode: "no_result",
        results: [{ productName: "Coca-Cola / product unconfirmed" }],
      },
    });
    expect(second).toMatchObject({ kind: "computed", cached: false, payload: { reasonCode: "no_result" } });
    expect(decodeWithGpt).toHaveBeenCalledTimes(2);
    expect(persistDecode).not.toHaveBeenCalled();
  });

  it("ignores an already-persisted prefix-floor no-result and retries GPT", async () => {
    const poisoned = {
      ...cachedPayload("Coca-Cola / product unconfirmed"),
      reasonCode: "no_result",
    };
    vi.mocked(getPersistedDecode).mockResolvedValue({
      code: CODE,
      kind: "result",
      payload: JSON.stringify(poisoned),
      tier: "suggested",
      sourceTier: "gpt_5_4_mini",
      createdAt: 1,
    });

    const out = await runDecodePipeline(request());

    expect(out).toMatchObject({ kind: "computed", cached: false, payload: { reasonCode: "gpt_decode" } });
    expect(decodeWithGpt).toHaveBeenCalledOnce();
  });

  it("skips paid decode without caching when the usage meter cannot write, then retries later", async () => {
    vi.mocked(prefixFloorNameFull).mockReturnValue({
      name: "Coca-Cola / product unconfirmed",
      brand: "Coca-Cola",
    });
    vi.mocked(chargeDailySlotConditional)
      .mockRejectedValueOnce(new Error("EROFS: read-only file system"))
      .mockResolvedValueOnce({ used: 1, limit: 10, granted: true });

    const unavailable = await runDecodePipeline(request());

    expect(unavailable).toMatchObject({
      kind: "computed",
      cached: false,
      paidComputeCharged: false,
      payload: {
        reasonCode: "no_result",
        results: [{ productName: "Coca-Cola / product unconfirmed" }],
      },
    });
    expect(decodeWithGpt).not.toHaveBeenCalled();
    expect(persistDecode).not.toHaveBeenCalled();

    const recovered = await runDecodePipeline(request());
    expect(recovered).toMatchObject({ kind: "computed", cached: false, payload: { reasonCode: "gpt_decode" } });
    expect(decodeWithGpt).toHaveBeenCalledOnce();
  });

  it("leaves example and likely-misread codes free and reviewable", async () => {
    const example = await runDecodePipeline(request("4006381333931"));
    expect(example.kind === "computed" && example.payload.reasonCode).toBe("no_result");
    expect(decodeWithGpt).not.toHaveBeenCalled();
    expect(chargeDailySlotConditional).not.toHaveBeenCalled();

    clearDecodeCache();
    const misread = await runDecodePipeline(request("049000006347"));
    expect(misread.kind === "computed" && misread.payload.reasonCode).toBe("no_result");
    expect(decodeWithGpt).not.toHaveBeenCalled();
  });

  it("defers account and global caps until paid egress and reports the exact scope", async () => {
    vi.mocked(chargeDailySlotConditional).mockResolvedValueOnce({ used: 10, limit: 10, granted: false });
    const global = await runDecodePipeline(request());
    expect(global).toMatchObject({ kind: "cap_blocked", reasonCode: "daily_cap" });
    expect(decodeWithGpt).not.toHaveBeenCalled();

    clearDecodeCache();
    vi.mocked(chargeDailySlotConditional).mockResolvedValueOnce({ used: 1, limit: 100, granted: true });
    vi.mocked(chargeDailySlotForAccountConditional).mockResolvedValueOnce({ used: 3, granted: false });
    const account = await runDecodePipeline({ ...request(), capContext: { authedBusinessId: "tenant-1", accountLimit: 3 } });
    expect(account).toMatchObject({ kind: "cap_blocked", reasonCode: "account_daily_cap" });
    expect(refundDailySlot).toHaveBeenCalledWith(storage);
    expect(decodeWithGpt).not.toHaveBeenCalled();
  });

  it("coalesces concurrent paid decode for the same canonical code", async () => {
    let release!: (value: GptDecodeResult) => void;
    vi.mocked(decodeWithGpt).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const first = runDecodePipeline(request());
    const second = runDecodePipeline(request("0049000006346"));
    await vi.waitFor(() => expect(decodeWithGpt).toHaveBeenCalledOnce());
    release(gpt());
    const [a, b] = await Promise.all([first, second]);

    expect(a.kind).toBe("computed");
    expect(b.kind).toBe("computed");
    expect(decodeWithGpt).toHaveBeenCalledOnce();
    expect(chargeDailySlotConditional).toHaveBeenCalledOnce();
  });

  it("uses only an E2E fixture in test mode", async () => {
    process.env.IS_E2E = "1";
    const out = await runDecodePipeline({ ...request(), mockGptDecode: gpt() });

    expect(out.kind === "computed" && out.payload.providerNames).toEqual(["gpt-5.4-mini"]);
    expect(out.kind === "computed" && out.paidComputeCharged).toBe(false);
    expect(decodeWithGpt).not.toHaveBeenCalled();
    expect(decodeStorage).not.toHaveBeenCalled();
  });
});

describe("paid authorization and diagnostics", () => {
  it("shares one immutable settlement and blocks egress until it settles", async () => {
    let release!: () => void;
    const settlement = new Promise<void>((resolve) => { release = resolve; });
    const settle = vi.fn(() => settlement);
    const coordinator = createPaidEgressCoordinator(settle);
    let egresses = 0;
    const egress = async () => {
      await coordinator.authorize();
      egresses += 1;
    };

    const first = egress();
    const second = egress();
    await Promise.resolve();
    expect(egresses).toBe(0);
    expect(settle).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(egresses).toBe(2);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("keeps a failed settlement sticky", async () => {
    const coordinator = createPaidEgressCoordinator(async () => { throw new Error("meter unavailable"); });
    await expect(coordinator.authorize()).rejects.toThrow("meter unavailable");
    await expect(coordinator.authorize()).rejects.toThrow("meter unavailable");
  });

  it("classifies only the retained paid source and sanitizes provider failures", () => {
    expect(classifySourceTier("gpt_decode", ["gpt-5.4-mini"])).toBe("gpt_5_4_mini");
    expect(classifySourceTier("no_result", ["gpt-5.4-mini"])).toBeNull();
    expect(classifySourceTier("ok", ["tire-corpus"])).toBeNull();
    expect(classifyGptFailureDetail("HTTP 429")).toBe("429");
    expect(classifyGptFailureDetail("HTTP 503")).toBe("5xx");
    expect(classifyGptFailureDetail("openai_auth_failed (check key)")).toBe("401");
    expect(classifyGptFailureDetail("model returned non-JSON")).toBe("bad_json");
  });
});
