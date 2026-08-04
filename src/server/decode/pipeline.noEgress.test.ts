// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This is deliberately a pre-import fail-closed harness.  A trusted exact result must return before
// every mocked seam below; each mock increments then throws, so an unexpected path cannot silently
// become a declarative zero counter.
const harness = vi.hoisted(() => {
  const counts: Record<string, number> = {};
  const trap = (name: string) => () => {
    counts[name] = (counts[name] ?? 0) + 1;
    throw new Error(`no-egress seam invoked: ${name}`);
  };
  const reset = () => Object.keys(counts).forEach((key) => delete counts[key]);
  return { counts, trap, reset, resolveTrustedExactBarcodeDecision: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", () => ({
  resolveTrustedExactBarcodeDecision: (...args: unknown[]) => harness.resolveTrustedExactBarcodeDecision(...args),
  resolveExactBarcode: harness.trap("sqlite_exact_barcode"),
  resolveExactPartNumber: harness.trap("sqlite_part_number"),
}));
vi.mock("@/server/retail-knowledge/barcodeDbProvider", () => ({ lookupRetailBarcodeAsync: harness.trap("retail_sqlite") }));
vi.mock("@/server/learnedProducts", () => ({
  getLearnedProduct: harness.trap("learned_lookup"), upsertLearnedProduct: harness.trap("learned_write"),
  shouldLearnDecode: harness.trap("learned_policy"), prefixCheckNote: harness.trap("learned_prefix"), siblingPrefixConflict: harness.trap("learned_sibling"),
}));
vi.mock("@/services/ai/decodeCache", () => ({ withDecodeCache: harness.trap("memory_decode_cache"), getDecodeCache: harness.trap("memory_decode_cache_read") }));
vi.mock("@/server/decodeCacheStore", () => ({ getPersistedDecode: harness.trap("persistent_decode_cache_read"), persistDecode: harness.trap("persistent_decode_cache_write") }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: harness.trap("ladder_storage") }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: harness.trap("master_catalog") }));
vi.mock("@/server/catalog/prefixIndexServer", () => ({
  lookupPrefixFull: harness.trap("prefix_lookup"), candidateKnownPrefixesFull: harness.trap("prefix_candidates"), prefixFloorNameFull: harness.trap("prefix_floor"),
}));
vi.mock("@/services/ai/firecrawlProvider", () => ({ firecrawlScrapeCheap: harness.trap("firecrawl_scrape"), searchIdentifyByBarcode: harness.trap("firecrawl_search"), firecrawlKeysFromEnv: harness.trap("firecrawl_keys") }));
vi.mock("@/services/ai/flashLiteGrounding", () => ({ groundIdentify: harness.trap("ground"), getLastGroundingStatus: harness.trap("ground_status") }));
vi.mock("@/services/ai/verifyCodeOnPage", () => ({ verifyCodeOnPage: harness.trap("verify_page") }));
vi.mock("@/services/ai/parallelResolve", () => ({ resolveUnknownFast: harness.trap("parallel_resolve") }));
vi.mock("@/services/upc/goUpcClient", () => ({ goUpcLookup: harness.trap("goupc_client") }));
vi.mock("@/server/upc/GoUpcProvider", () => ({ goUpcRung: harness.trap("goupc_rung"), makeDefaultPrefixLookup: () => () => null }));
vi.mock("@/server/upc/upcItemDbUsage", () => ({ upcItemDbUsage: { canSpend: harness.trap("upcitemdb_usage") } }));
vi.mock("@/server/upc/UpcItemDbProvider", () => ({ upcItemDbRung: harness.trap("upcitemdb_rung") }));
vi.mock("@/services/upc/upcItemDbClient", () => ({ upcItemDbLookup: harness.trap("upcitemdb_client") }));
vi.mock("@/server/upc/openFoodFactsUsage", () => ({ openFoodFactsUsage: { canSpend: harness.trap("openfoodfacts_usage") } }));
vi.mock("@/server/upc/OpenFoodFactsProvider", () => ({ openFoodFactsRung: harness.trap("openfoodfacts_rung") }));
vi.mock("@/services/upc/openFoodFactsClient", () => ({ openFoodFactsLookup: harness.trap("openfoodfacts_client") }));
vi.mock("@/services/fetchV2/index", () => ({ fetchV2: harness.trap("fetchv2") }));
vi.mock("@/services/fetchV2/cache", () => ({ FetchV2Cache: class {} }));
vi.mock("@/services/fetchV2/sources/discovery", () => ({ braveProvider: harness.trap("brave_search"), firecrawlSearchProvider: harness.trap("fetchv2_firecrawl_search") }));
vi.mock("@/services/fetchV2/sources/brocade", () => ({ brocadeLookup: harness.trap("brocade") }));
vi.mock("@/server/upc/ladder", () => ({ runLadder: harness.trap("ladder"), buildFreeLadderRungs: harness.trap("free_ladder"), buildPaidLadderRungs: harness.trap("paid_ladder") }));

import { createTrustedExactAccessForTest, runDecodePipeline, tryTrustedExactDecode } from "./pipeline";

const code = "012345678905";
const spellings = [code, `0${code}`, `00${code}`];
const noEgressNames = [
  "sqlite_exact_barcode", "sqlite_part_number", "retail_sqlite", "learned_lookup", "learned_write", "memory_decode_cache", "memory_decode_cache_read", "persistent_decode_cache_read", "persistent_decode_cache_write", "ladder_storage", "master_catalog", "prefix_lookup", "prefix_candidates", "prefix_floor", "firecrawl_scrape", "firecrawl_search", "firecrawl_keys", "ground", "ground_status", "verify_page", "parallel_resolve", "goupc_client", "goupc_rung", "upcitemdb_usage", "upcitemdb_rung", "upcitemdb_client", "openfoodfacts_usage", "openfoodfacts_rung", "openfoodfacts_client", "fetchv2", "brave_search", "fetchv2_firecrawl_search", "brocade", "ladder",
];

function exactHit(scannedCode: string) {
  return {
    kind: "hit" as const,
    sourceScope: "authenticated_boss_corpus" as const,
    result: {
      providerNames: ["tire-corpus"], path: "corpus_exact_barcode",
      results: [{ productName: "Boss Roadmaster 235/60R18", brand: "Boss", specsShort: "235/60R18", confidence: 1 }],
      evidences: [{ verified: true, strength: "fetched_source", matchedCode: scannedCode, matchedSources: ["trusted"], reason: "exact" }],
      decision: { status: "verified", confidence: 1, reason: "exact", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, corroborationPath: "corpus_exact_barcode", trustedExactCanonicalProductId: "trusted-exact:00012345678905", crossCheck: { decision: "single_provider", confidence: 1, reason: "exact", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] } },
    },
  };
}

function req(scannedCode: string) {
  return { code: scannedCode, rawCodeSanitized: scannedCode, cleanCodeSanitized: scannedCode };
}

beforeEach(() => {
  harness.reset();
  harness.resolveTrustedExactBarcodeDecision.mockReset();
  vi.stubGlobal("fetch", harness.trap("global_fetch"));
});
afterEach(() => vi.unstubAllGlobals());

describe("trusted exact decode observable no-egress boundary", () => {
  it.each(spellings)("returns a verified Boss exact hit for valid zero spelling %s with zero forbidden calls", async (scannedCode) => {
    harness.resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(exactHit(scannedCode));
    const result = await tryTrustedExactDecode(req(scannedCode), createTrustedExactAccessForTest());
    expect(result).toMatchObject({ kind: "computed", cached: false, paidComputeCharged: false, payload: { providerNames: ["tire-corpus"], decision: { status: "verified", corroborationPath: "boss_trusted_exact_barcode", exactCodeEvidenceVerifiedByApp: true, trustedExactCanonicalProductId: "trusted-exact:00012345678905" }, debug: { corroborationPath: "boss_trusted_exact_barcode", aiCalled: false, pageFetched: false } } });
    expect(harness.resolveTrustedExactBarcodeDecision).toHaveBeenCalledWith(scannedCode, { authenticatedBossCorpus: true });
    expect(harness.counts).toEqual({});
  });

  it.each(["blocked_package", "exact_index_unavailable"])("fails closed on %s before every forbidden seam", async (kind) => {
    harness.resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(kind === "blocked_package" ? { kind, canonicalKey: "0030029885620210" } : { kind });
    const result = await tryTrustedExactDecode(req("30029885620210"));
    expect(result).toMatchObject({ kind: "computed", paidComputeCharged: false, payload: { reasonCode: kind, decision: { status: "needs_review" } } });
    expect(harness.counts).toEqual({});
  });

  it("keeps an exact miss deterministic-only and unprivileged when given plain-object, JSON, env, and production-mode spoofs", async () => {
    harness.resolveTrustedExactBarcodeDecision.mockResolvedValue({ kind: "miss" });
    const plain = { authenticatedBossCorpus: true } as never;
    const json = JSON.parse('{"authenticatedBossCorpus":true}') as never;
    process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(runDecodePipeline({ ...req(code), codeType: "upc_a", threshold: 0.8, allowNonPublicAutoCount: true, forceRetry: false, deterministicOnly: true, trustedExactAccess: plain })).resolves.toMatchObject({ kind: "computed", payload: { reasonCode: "no_result" } });
      await tryTrustedExactDecode(req(code), json);
      expect(() => createTrustedExactAccessForTest()).toThrow("not available in production");
    } finally {
      delete process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS;
      vi.unstubAllEnvs();
    }
    expect(harness.resolveTrustedExactBarcodeDecision).toHaveBeenNthCalledWith(1, code, { authenticatedBossCorpus: false });
    expect(harness.resolveTrustedExactBarcodeDecision).toHaveBeenNthCalledWith(2, code, { authenticatedBossCorpus: false });
    expect(harness.counts).toEqual({});
  });

  it("negative controls prove every injected forbidden seam increments and throws", () => {
    for (const name of noEgressNames) expect(() => harness.trap(name)()).toThrow(`no-egress seam invoked: ${name}`);
    expect(() => globalThis.fetch("https://example.invalid")).toThrow("no-egress seam invoked: global_fetch");
    for (const name of [...noEgressNames, "global_fetch"]) expect(harness.counts[name]).toBe(1);
  });
});
