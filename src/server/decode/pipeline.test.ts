// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The pipeline imports `server-only` (and server-only modules). Stub the marker so it loads in vitest.
vi.mock("server-only", () => ({}));

// Task 6: the corpus exact peek and the L2 persisted-decode peek are the two stages the reorder
// swaps. Mock BOTH so a test can assert "a fresh corpus hit beats a stale no_result_receipt" without a
// real tire DB or a real L2 store. Real implementations pass through by default (importOriginal); each
// test overrides the specific call it cares about with mockResolvedValueOnce.
// Hoisted holder for the real (pass-through) implementations so beforeEach can restore them after a
// per-test mockResolvedValueOnce override. vi.hoisted runs before the vi.mock factories, which the
// factories then populate; the holder itself is safe to reference inside the hoisted factories.
const realImpls = vi.hoisted(() => ({
  resolveExactBarcode: undefined as unknown as typeof import("@/server/tire-knowledge/TireKnowledgeProvider").resolveExactBarcode,
  resolveExactPartNumber: undefined as unknown as typeof import("@/server/tire-knowledge/TireKnowledgeProvider").resolveExactPartNumber,
  getPersistedDecode: undefined as unknown as typeof import("@/server/decodeCacheStore").getPersistedDecode,
}));
vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tire-knowledge/TireKnowledgeProvider")>();
  realImpls.resolveExactBarcode = actual.resolveExactBarcode;
  realImpls.resolveExactPartNumber = actual.resolveExactPartNumber;
  return { ...actual, resolveExactBarcode: vi.fn(actual.resolveExactBarcode), resolveExactPartNumber: vi.fn(actual.resolveExactPartNumber) };
});
vi.mock("@/server/decodeCacheStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/decodeCacheStore")>();
  realImpls.getPersistedDecode = actual.getPersistedDecode;
  return { ...actual, getPersistedDecode: vi.fn(actual.getPersistedDecode) };
});

// Task 21 (owner-ratified 2026-07-15): mock the learned-products tier's read/write so a test can drive
// a synthetic learned hit (or assert a fresh write) without touching a real store. Real implementations
// pass through by default; individual tests override with mockResolvedValueOnce / assert on the mock.
const realLearned = vi.hoisted(() => ({
  getLearnedProduct: undefined as unknown as typeof import("@/server/learnedProducts").getLearnedProduct,
  upsertLearnedProduct: undefined as unknown as typeof import("@/server/learnedProducts").upsertLearnedProduct,
  siblingPrefixConflict: undefined as unknown as typeof import("@/server/learnedProducts").siblingPrefixConflict,
}));
vi.mock("@/server/learnedProducts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/learnedProducts")>();
  realLearned.getLearnedProduct = actual.getLearnedProduct;
  realLearned.upsertLearnedProduct = actual.upsertLearnedProduct;
  realLearned.siblingPrefixConflict = actual.siblingPrefixConflict;
  return {
    ...actual,
    getLearnedProduct: vi.fn(actual.getLearnedProduct),
    upsertLearnedProduct: vi.fn(actual.upsertLearnedProduct),
    siblingPrefixConflict: vi.fn(actual.siblingPrefixConflict),
  };
});

// Task 21 write-gate tests: mock the top-level fetchV2 engine call directly so a test can hand back a
// controlled "verified" FetchV2Result (fetched_source-equivalent: exactCodeFound true, a chosen
// winningSourceUrl) without driving the full discovery/association/scoring pipeline through a synthetic
// page fixture. Real implementation passes through by default; the write-gate tests override it.
const realFetchV2 = vi.hoisted(() => ({
  fetchV2: undefined as unknown as typeof import("@/services/fetchV2/index").fetchV2,
}));
vi.mock("@/services/fetchV2/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/fetchV2/index")>();
  realFetchV2.fetchV2 = actual.fetchV2;
  return { ...actual, fetchV2: vi.fn(actual.fetchV2) };
});

// Task 8 (P1): the plain all-miss needs_review arm is only reachable for a PUBLIC code when Plan D's
// resolveUnknownFast throws (its result is .catch(() => null)'d in the pipeline). Mock it so a P1 test
// can drive a public, prefix-floored code into that arm and assert the floor-named result appears.
// Real implementation passes through by default; only the P1 test overrides it with mockRejectedValueOnce.
const realParallel = vi.hoisted(() => ({
  resolveUnknownFast: undefined as unknown as typeof import("@/services/ai/parallelResolve").resolveUnknownFast,
}));
vi.mock("@/services/ai/parallelResolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/parallelResolve")>();
  realParallel.resolveUnknownFast = actual.resolveUnknownFast;
  return { ...actual, resolveUnknownFast: vi.fn(actual.resolveUnknownFast) };
});

// RETAIL-RUNG FIX: mock the retail knowledge index (pipeline.ts reaches it via a dynamic
// `await import(...)`, so vi.mock intercepts that dynamic import exactly like a static one). Real
// implementation passes through by default (importOriginal); a test drives a synthetic retail-corpus
// row with mockResolvedValueOnce without touching a real SQLite file or a live Turso connection.
const realRetail = vi.hoisted(() => ({
  lookupRetailBarcodeAsync: undefined as unknown as typeof import("@/server/retail-knowledge/retailKnowledgeIndex").lookupRetailBarcodeAsync,
}));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/retail-knowledge/retailKnowledgeIndex")>();
  realRetail.lookupRetailBarcodeAsync = actual.lookupRetailBarcodeAsync;
  return { ...actual, lookupRetailBarcodeAsync: vi.fn(actual.lookupRetailBarcodeAsync) };
});

// Sync Truth Task 4: mock the master-catalog rung so EVERY test in this file (not just the dedicated
// describe block below) gets a safe, instant "miss" by default - the real implementation would call
// getAdminDb() and attempt live Firebase Admin credential resolution, which must never happen inside a
// unit test. Individual tests override with mockResolvedValueOnce for a "verified"/"suggestion" hit.
const realMasterLookup = vi.hoisted(() => ({
  lookupMasterCatalog: undefined as unknown as typeof import("@/server/catalog/masterLookup").lookupMasterCatalog,
}));
vi.mock("@/server/catalog/masterLookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/catalog/masterLookup")>();
  realMasterLookup.lookupMasterCatalog = actual.lookupMasterCatalog;
  return { ...actual, lookupMasterCatalog: vi.fn(async () => ({ kind: "miss" as const })) };
});

// Redirect ladderStorage() at a per-process tmp dir so the daily-cap / Go-UPC usage counters never
// pollute the real repo working tree (identical to the route test's mock).
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

// Gemini Pro review fix 2: recordGptLadderSpend / recordGptLadderCall must BOTH always run after a
// live GPT rung call, even if one throws (they used to run sequentially, so a spend-record throw
// silently skipped the call-count record). Spy on both while passing through to the real
// implementations by default; the dedicated test below overrides recordGptLadderSpend to reject and
// asserts recordGptLadderCall still fires.
const realSpendGuard = vi.hoisted(() => ({
  recordGptLadderSpend: undefined as unknown as typeof import("@/services/security/aiSpendGuard").recordGptLadderSpend,
  recordGptLadderCall: undefined as unknown as typeof import("@/services/security/aiSpendGuard").recordGptLadderCall,
}));
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  realSpendGuard.recordGptLadderSpend = actual.recordGptLadderSpend;
  realSpendGuard.recordGptLadderCall = actual.recordGptLadderCall;
  return {
    ...actual,
    recordGptLadderSpend: vi.fn(actual.recordGptLadderSpend),
    recordGptLadderCall: vi.fn(actual.recordGptLadderCall),
  };
});

import { runDecodePipeline, DailyCapExceededError, classifySourceTier } from "@/server/decode/pipeline";
import { detectCodeType } from "@/services/codeTypeDetector";
import { __resetForTest, readDailyUsed, recordGptLadderSpend, recordGptLadderCall } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import * as decodeCacheModule from "@/services/ai/decodeCache";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest, getPersistedDecode, type PersistedDecode } from "@/server/decodeCacheStore";
import { resolveExactBarcode, resolveExactPartNumber, type CorpusDecodeResult } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { resolveUnknownFast } from "@/services/ai/parallelResolve";
import { getLearnedProduct, upsertLearnedProduct, siblingPrefixConflict, __resetLearnedProductsForTest, type LearnedProductRow } from "@/server/learnedProducts";
import { fetchV2 } from "@/services/fetchV2/index";
import { makeResult } from "@/services/fetchV2/types";
import { lookupRetailBarcodeAsync, __resetRetailKnowledgeCacheForTests } from "@/server/retail-knowledge/retailKnowledgeIndex";
import { lookupMasterCatalog, __resetMasterLookupMemoForTests } from "@/server/catalog/masterLookup";

// Thin unit tests for the extracted decode pipeline (Task 2.4). They run with NO API keys and a fully
// STUBBED global.fetch, so NO live provider call and NO real network can occur - every rung either
// skips (no key) or misses. These prove the two invariants the route relied on and that must survive
// the extraction: (1) an all-miss ladder returns an unresolved payload whose reason chain names every
// rung that came back empty (owner: never silent); (2) a cap-exhausted request is blocked from the
// paid ladder with an honest cap reason.

// PAID/live provider endpoints only. Go-UPC is pinned to its paid API PATH ("go-upc.com/api", the
// key-gated GET /api/v1/code endpoint) because since AM-7 the FREE fetchv2 pattern-URL door fetches
// the go-upc.com/search PAGE ($0 scrape, no key) even with zero discovery providers configured -
// that free page fetch is intended keyless behavior, not a paid provider call.
const AI_PROVIDER_HOSTS = ["generativelanguage.googleapis.com", "api.openai.com", "go-upc.com/api", "firecrawl.dev"];

function makeReq(code: string) {
  return {
    code,
    codeType: detectCodeType(code),
    rawCodeSanitized: code,
    cleanCodeSanitized: code,
    threshold: 0.8,
    allowNonPublicAutoCount: true,
    forceRetry: false,
  } as const;
}

const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`, ".ladder-kv.json");
// Isolated per-process L2 decode-cache file so persistDecode/getPersistedDecode in these tests never
// read or write the real repo-root .decode-cache.json, and never leak a "result" from one test's
// PAY-ONCE persistence assertions into the next test's (previously-passing tests never exercised L2
// persistence, so this gap was latent until the PAY-ONCE suggestion-persist tests below).
const decodeCacheTestFile = () => path.join(os.tmpdir(), `decode-cache-pipeline-test-${process.pid}.json`);
// Task 21: isolate the learned-products file store the same way, so a test that exercises a REAL
// (unmocked) upsertLearnedProduct write never touches the real repo-root .learned-products.json.
const learnedProductsTestFile = () => path.join(os.tmpdir(), `learned-products-pipeline-test-${process.pid}.json`);

describe("runDecodePipeline (extracted decode pipeline; no live AI)", () => {
  const saved: Record<string, string | undefined> = {};
  // wave-3: DECODE_LADDER_TOTAL_MS added so a test that overrides it (the wave-3 preflight/budget
  // suite) never leaks into a later test in the same file (test-isolation fix, found live while
  // writing the wave-3 non_public_code_type test below).
  const keys = ["IS_E2E", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "GO_UPC_API_KEY", "BRAVE_SEARCH_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE", "LEARNED_PRODUCTS_FILE", "DECODE_LADDER_TOTAL_MS"];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Task 6: restore the pass-through implementations so each test starts from real behavior; a test
    // that wants a synthetic corpus hit / persisted receipt uses mockResolvedValueOnce explicitly.
    vi.mocked(resolveExactBarcode).mockReset().mockImplementation(realImpls.resolveExactBarcode);
    vi.mocked(resolveExactPartNumber).mockReset().mockImplementation(realImpls.resolveExactPartNumber);
    vi.mocked(getPersistedDecode).mockReset().mockImplementation(realImpls.getPersistedDecode);
    vi.mocked(resolveUnknownFast).mockReset().mockImplementation(realParallel.resolveUnknownFast);
    vi.mocked(getLearnedProduct).mockReset().mockImplementation(realLearned.getLearnedProduct);
    vi.mocked(upsertLearnedProduct).mockReset().mockImplementation(realLearned.upsertLearnedProduct);
    vi.mocked(fetchV2).mockReset().mockImplementation(realFetchV2.fetchV2);
    vi.mocked(lookupRetailBarcodeAsync).mockReset().mockImplementation(realRetail.lookupRetailBarcodeAsync);
    vi.mocked(recordGptLadderSpend).mockReset().mockImplementation(realSpendGuard.recordGptLadderSpend);
    vi.mocked(recordGptLadderCall).mockReset().mockImplementation(realSpendGuard.recordGptLadderCall);
    // Sync Truth Task 4: default every test to a safe instant miss; the dedicated describe block below
    // overrides with mockResolvedValueOnce for a verified/suggestion hit.
    vi.mocked(lookupMasterCatalog).mockReset().mockResolvedValue({ kind: "miss" });
    __resetRetailKnowledgeCacheForTests();
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    __resetLearnedProductsForTest();
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    try { fs.unlinkSync(decodeCacheTestFile()); } catch {}
    try { fs.unlinkSync(learnedProductsTestFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
    // Guards ACTIVE (not E2E) + NO provider keys (so every rung skips or misses; no real network).
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GO_UPC_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.DECODE_CACHE_FILE = decodeCacheTestFile();
    process.env.LEARNED_PRODUCTS_FILE = learnedProductsTestFile();
    // Any stray outbound fetch resolves to a benign 404 - proves no live provider is required.
    fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { fs.unlinkSync(decodeCacheTestFile()); } catch {}
    try { fs.unlinkSync(learnedProductsTestFile()); } catch {}
    vi.unstubAllGlobals();
  });

  const hitAnAiProvider = () => fetchSpy.mock.calls.some(([u]) => AI_PROVIDER_HOSTS.some((h) => String(u).includes(h)));

  it("all-miss ladder returns an unresolved payload whose reason chain names every rung that came back empty", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the miss, not the block
    const outcome = await runDecodePipeline(makeReq("111000222333"));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    // Nothing resolved: the decision is NOT verified and no product auto-counts.
    expect(outcome.payload.decision.status).not.toBe("verified");
    // The reason chain surfaces every rung's miss (owner: never a silent needs_review).
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect(Array.isArray(reasons)).toBe(true);
    const rungsSeen = (reasons ?? []).map((r) => r.rung);
    expect(rungsSeen).toContain("fetchv2");
    expect(rungsSeen).toContain("gpt");
    // No live AI/paid provider was contacted (all keys absent).
    expect(hitAnAiProvider()).toBe(false);
    // AM-7: with ZERO discovery providers (no Brave/Firecrawl keys) the FREE pattern-URL door still
    // runs - the stubbed fetch sees the $0 go-upc.com/search PAGE scrape (it 404s = clean miss),
    // and the paid Go-UPC API (/api/v1/code, key-gated) is never touched.
    const goUpcCalls = fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("go-upc.com"));
    expect(goUpcCalls.length).toBeGreaterThan(0);
    expect(goUpcCalls.every((u) => !u.includes("go-upc.com/api"))).toBe(true);
  }, 30000);

  it("cap-blocked: an exhausted daily cap blocks the paid ladder with an honest cap reason and zero paid calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
    // L6 (Task 12c): the cap gate only fires when paid work is genuinely possible for this code
    // (paidWorkPossible). A Brave key makes Fetch V2's paid discovery door capable, regardless of
    // code shape, so this proves the cap still genuinely blocks paid work when it CAN run.
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    const outcome = await runDecodePipeline(makeReq("111000222333"));

    expect(outcome.kind).toBe("cap_blocked");
    if (outcome.kind !== "cap_blocked") throw new Error("unreachable");
    // Honest cap reason (the string the route turns into a 429 daily_cap response).
    expect(outcome.message).toMatch(/cap/i);
    // The DailyCapExceededError type is exported for the route's catch site.
    expect(DailyCapExceededError).toBeTypeOf("function");
    // The counter was NOT charged on a blocked request (read-only gate, then throw before charge).
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    // No paid provider was contacted once the cap is exhausted.
    expect(hitAnAiProvider()).toBe(false);
  });

  it("L6: a fully KEYLESS total-miss run NEVER charges the cap, even with AI_LOOKUP_DAILY_LIMIT=0 (no paid rung could run anyway)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap - but irrelevant with zero keys
    // beforeEach already deletes every provider key - paidWorkPossible("111000222333") is false, so the
    // total-miss branch must skip chargePaidSlot() entirely and fall through to a normal computed
    // all-miss response instead of a cap_blocked 429 for work that could never have cost anything.
    const outcome = await runDecodePipeline(makeReq("111000222333"));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    expect(outcome.payload.decision.status).not.toBe("verified");
    // The counter genuinely never moved - no charge attempt, blocked or otherwise.
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    expect(hitAnAiProvider()).toBe(false);
  });

  // Task 8 (P1/P2): the owner "never fully unknown" rule - a scan must never surface as a bare
  // "Unidentified item" when the GS1 company prefix knows the company. FLOORED_GTIN's prefix 5603344
  // has a REAL prefixIndex dominant ("general", a Continental-family member), so prefixFloorName names
  // it "General (Continental family) / product unconfirmed". It is deliberately absent from every free
  // corpus/DB fixture, so it reaches the paid ladder (P2) or the all-miss return (P1).
  // QA round-2: uses a VALID GS1 check digit - the SEAM 3 misread guard now suppresses the floor for
  // bad-check-digit GTINs, and a real scanned code from this prefix would carry a valid check digit.
  const FLOORED_GTIN = "5603344000016";

  it("P2: a cap-blocked decode still carries the prefix floor (never a fully-unknown 429)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted -> paid ladder is blocked
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: paid work must be genuinely possible to block
    const outcome = await runDecodePipeline(makeReq(FLOORED_GTIN));

    expect(outcome.kind).toBe("cap_blocked");
    if (outcome.kind !== "cap_blocked") throw new Error("unreachable");
    // Honest cap message is unchanged...
    expect(outcome.message).toMatch(/cap/i);
    // ...AND the $0 prefix floor survives the block so the client can name the row.
    expect(outcome.floor).toBeTruthy();
    expect(outcome.floor?.brand).toBe("General");
    expect(outcome.floor?.name).toBe("General (Continental family) / product unconfirmed");
    expect(outcome.floor?.name).toMatch(/product unconfirmed/);
    // No paid provider was contacted once the cap is exhausted.
    expect(hitAnAiProvider()).toBe(false);
  });

  it("P2: a cap block WITHOUT a known prefix carries no floor (today's behavior, unchanged)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: paid work must be genuinely possible to block
    // "111000222333" has no prefixIndex dominant -> prefixFloorName returns null.
    const outcome = await runDecodePipeline(makeReq("111000222333"));
    expect(outcome.kind).toBe("cap_blocked");
    if (outcome.kind !== "cap_blocked") throw new Error("unreachable");
    expect(outcome.message).toMatch(/cap/i);
    expect(outcome.floor).toBeUndefined();
  });

  it("P1: the plain all-miss arm names a public prefix-floored code (Plan D unavailable)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the all-miss floor
    // Force the plain (!planDStash) arm for a PUBLIC code: Plan D's resolveUnknownFast throws, so the
    // pipeline's `.catch(() => null)` leaves planDStash null and the ladder then all-misses.
    vi.mocked(resolveUnknownFast).mockRejectedValueOnce(new Error("plan D unavailable"));

    const outcome = await runDecodePipeline(makeReq(FLOORED_GTIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    // Decision stays needs_review (never verified). BUG #14 (QA hardening 2026-07-16): the raw
    // "No rung resolved the code. fetchv2: ...; gpt: ..." chain used to leak straight into customer-
    // facing reasonText - it is now sanitized to an honest, token-free string; the raw chain still
    // survives in debug.ladderReasons (asserted separately in the BUG #14 describe block below).
    expect(outcome.payload.decision.status).not.toBe("verified");
    expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
    expect(outcome.payload.reasonText).not.toMatch(/fetchv2|gpt-5\.5|goupc|upcitemdb/i);
    // The floor names the row: one result, confidence 0.3, needs review, empty sourceUrls.
    const floorResult = outcome.payload.results.find((r) => /product unconfirmed/.test(r.productName));
    expect(floorResult).toBeTruthy();
    expect(floorResult?.productName).toBe("General (Continental family) / product unconfirmed");
    expect(floorResult?.confidence).toBe(0.3);
    expect(floorResult?.needsHumanReview).toBe(true);
    expect(floorResult?.sourceUrls ?? []).toHaveLength(0);
  });

  // Task 6 factories: a synthetic corpus hit and a stale L2 no_result_receipt for the reorder test.
  function makeCorpusHit(): CorpusDecodeResult {
    return {
      decision: {
        status: "verified",
        confidence: 0.97,
        reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheck: { decision: "single_provider", confidence: 0.97, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
        corroborationPath: "corpus_exact_barcode",
      },
      results: [{ productName: "Michelin Defender T+H 235/60R18", brand: "Michelin", category: "Tire", specsShort: "235/60R18", confidence: 0.97, needsHumanReview: false, sourceUrls: [], verifiedFacts: [], primaryBarcode: "848983006257" } as unknown as CorpusDecodeResult["results"][number]],
      evidences: [{ verified: true, strength: "fetched_source", matchedCode: "848983006257", matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." }],
      providerNames: ["tire-corpus"],
      path: "corpus_exact_barcode",
    };
  }
  function makeReceipt(): PersistedDecode {
    // A prior run exhausted the ladder and wrote a PERMANENT no_result_receipt (unresolved shape).
    const unresolvedBody = { mode: "decode", providerNames: ["gpt"], results: [], evidences: [], decision: { status: "needs_review", confidence: 0, reason: "No rung resolved the code." }, reasonCode: "no_result", reasonText: "No rung resolved the code.", debug: {} };
    return { code: "00848983006257", kind: "no_result_receipt", payload: JSON.stringify(unresolvedBody), tier: "gpt_none", createdAt: Date.now() - 86_400_000 };
  }

  it("L1 fix: a code with a stale no_result_receipt resolves from the corpus (corpus heals receipts)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    vi.mocked(resolveExactBarcode).mockResolvedValueOnce(makeCorpusHit()); // corpus NOW knows it
    vi.mocked(getPersistedDecode).mockResolvedValueOnce(makeReceipt()); // old receipt exists

    const out = await runDecodePipeline(makeReq("848983006257"));

    // Corpus peek runs FIRST: the fresh corpus win beats the stale receipt (which would have
    // short-circuited "persisted"/unresolved before this fix).
    expect(out.kind).toBe("computed");
    if (out.kind !== "computed") throw new Error("unreachable");
    expect(out.payload.providerNames).toContain("tire-corpus");
    expect(out.payload.decision.status).toBe("verified");
    // F2: a free corpus (rung-0) settle never charges paid compute.
    expect(out.paidComputeCharged).toBe(false);
  });

  // QA ROUND-2 SEAM 1 (live-proven bypass, 2026-07-16): the persisted-cache short-circuit replayed a
  // stored "result" VERBATIM - a poisoned cache entry (a textbook GS1 EXAMPLE barcode or a scanner-
  // MISREAD GTIN that had earlier been cached as a confident "verified" identity) short-circuited BEFORE
  // any misread/example re-check, so it kept fabricating an identity even after the round-1 rung-0 seam
  // guards. FIX: re-validate a "result" cache hit; if the code is a misread OR the cached identity is an
  // example/test row, treat it as a cache MISS (recompute honestly). A LEGIT cached verified code must
  // still replay verified at zero cost (cache speed preserved).
  function makeCachedResult(code: string, productName: string, brand: string, status = "verified"): PersistedDecode {
    const body = {
      mode: "decode",
      providerNames: ["go-upc"],
      results: [{ productName, brand, category: "", confidence: 0.97, needsHumanReview: false, sourceUrls: [], verifiedFacts: [], primaryBarcode: code }],
      evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["cache"], reason: "cached" }],
      decision: { status, confidence: 0.97, reason: "cached prior decode", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true },
      reasonCode: "verified",
      reasonText: "cached prior decode",
      debug: { ladderPath: "goupc" },
    };
    return { code, kind: "result", payload: JSON.stringify(body), tier: status, sourceTier: "paid_rung", createdAt: Date.now() - 3600_000 };
  }

  it("SEAM 1: a poisoned EXAMPLE code cached as 'verified' is NOT replayed verified (falls through honestly)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // 4006381333931 is a textbook GS1 EXAMPLE barcode ("Test Shopidoo") on the blocklist. A prior run
    // wrongly cached it as a confident "verified" identity - it must NOT be served verified now.
    vi.mocked(getPersistedDecode).mockResolvedValueOnce(makeCachedResult("4006381333931", "Test Shopidoo", "Shopidoo"));

    const out = await runDecodePipeline(makeReq("4006381333931"));
    expect(out.kind).not.toBe("persisted"); // the poisoned cache hit was rejected, not replayed
    if (out.kind === "computed") {
      expect(out.payload.decision.status).not.toBe("verified");
      expect(JSON.stringify(out.payload.results)).not.toMatch(/Shopidoo/i);
    }
  }, 30000);

  it("SEAM 1: a MISREAD code cached as 'verified' is NOT replayed verified (bad check digit)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // 012345678900 is UPC-A-shaped but its GS1 check digit FAILS -> a likely scanner misread. Even a
    // cached "verified" identity for it must not be served.
    vi.mocked(getPersistedDecode).mockResolvedValueOnce(makeCachedResult("012345678900", "Fabricated Product", "Healthyholics"));

    const out = await runDecodePipeline(makeReq("012345678900"));
    expect(out.kind).not.toBe("persisted");
    if (out.kind === "computed") {
      expect(out.payload.decision.status).not.toBe("verified");
      expect(JSON.stringify(out.payload.results)).not.toMatch(/Healthyholics/i);
    }
  }, 30000);

  it("SEAM 1 REGRESSION: a LEGIT cached verified code STILL replays verified at zero cost (cache speed preserved)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // A real, non-example, valid-check-digit code cached as verified must replay from the cache verbatim.
    vi.mocked(getPersistedDecode).mockResolvedValueOnce(makeCachedResult("00900000000003", "Falken Wildpeak A/T3W 265/70R17", "Falken"));

    const out = await runDecodePipeline(makeReq("900000000003"));
    expect(out.kind).toBe("persisted"); // replayed from cache, no recompute
    if (out.kind === "persisted") {
      expect((out.body.decision as { status?: string }).status).toBe("verified");
      expect(JSON.stringify(out.body.results)).toMatch(/Falken/i);
    }
    // No paid provider was contacted - the cache replay is free.
    expect(hitAnAiProvider()).toBe(false);
  });

  // FREE-RUNGS-OUTSIDE-THE-PAID-CAP (bug fix, 2026-07-12 review): UPCitemdb / Open Food Facts must
  // never charge the paid daily AI-lookup cap, and an already-exhausted paid cap must never block
  // them from running and resolving a code for $0. VALID_GTIN has a real GS1 check digit, so it is
  // GTIN-gated into the free half of the ladder (buildFreeLadderRungs); the earlier cap tests above
  // use "111000222333", which has a BAD check digit and so never reaches the free rungs at all -
  // these tests need a code that genuinely exercises the free half.
  // Synthetic 12-digit code with a valid GS1 check digit but NOT a real product - deliberately
  // absent from the tire corpus / retail knowledge index / barcodeDb fixtures, so it reaches the
  // ladder rungs themselves instead of short-circuiting on a free corpus hit above them.
  const VALID_GTIN = "900000000003";
  const UPCITEMDB_HOST = "api.upcitemdb.com";
  const OFF_HOST = "world.openfoodfacts.org";

  function stubFreeRungFetch(opts: { upcHit?: boolean } = {}) {
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(UPCITEMDB_HOST)) {
        if (opts.upcHit) {
          return new Response(
            JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 }); // genuine miss
      }
      if (url.includes(OFF_HOST)) {
        return new Response(JSON.stringify({ status: 0 }), { status: 200 }); // genuine miss
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
  }

  it("free rung settles (UPCitemdb hit) -> paid daily counter UNCHANGED, even when the cap is ALREADY exhausted going in (no DailyCapExceededError)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted before this request even starts
    stubFreeRungFetch({ upcHit: true });

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    // The free rung answered -> a normal "computed" result, NOT cap_blocked. Proves an exhausted
    // paid cap never blocks a free-rung resolution, and no DailyCapExceededError was thrown.
    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    expect(outcome.payload.providerNames).toContain("upcitemdb");
    expect(outcome.payload.decision.status).toBe("needs_review"); // UPCitemdb hit is always a suggestion
    // The PAID daily-cap counter's actual stored value must be exactly unchanged (still 0) - not
    // merely "no throw". A free-rung resolution must never touch the paid charge function at all.
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    // Only the free-rung host was ever contacted - never an AI/paid provider host.
    expect(hitAnAiProvider()).toBe(false);
  });

  // D8 (Task 2, Step 3b): UPCitemdb must be queried AT MOST ONCE per request. Before this fix, Plan D's
  // `lookupBarcodeDb` dep re-fetched the SAME api.upcitemdb.com endpoint that rung-0 (runUpcItemDb) had
  // already just called for this exact code - a second, untracked, wasted network round-trip. VALID_GTIN
  // is a public barcode (UPC-A) so it reaches Plan D; rung-0 suggests (never a terminal win on its own),
  // so the pipeline continues past the free ladder into Plan D, which is exactly the path that used to
  // double-fetch.
  it("D8: UPCitemdb (api.upcitemdb.com) is fetched AT MOST ONCE per request - Plan D reuses rung-0's tracked result, never a second fetch", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    stubFreeRungFetch({ upcHit: true }); // rung-0 UPCitemdb hit -> a suggestion, not a terminal verified win

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    expect(outcome.kind).toBe("computed");
    const upcCalls = fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => String(u).includes(UPCITEMDB_HOST));
    expect(upcCalls.length).toBeLessThanOrEqual(1);
  });

  // D8 follow-up (P5, 2026-07-20): the test above only covers the HIT path, where `upcItemDbResult` is
  // non-null and the `??` short-circuit means the fallback fetch function is never even called. The
  // real gap is the CLEAN-MISS path: rung-0 completes a real lookup for the exact code, gets items:[],
  // and `upcItemDbResult` stays null - so Plan D's `?? (await lookupBarcodeDb(code))` fallback DOES run
  // and (before this fix) re-fetches the IDENTICAL exact code that rung-0 had already just tried, a
  // provably wasted duplicate HTTP call against the keyless ~90-100/day trial budget. Pad variants ARE
  // legitimate new value (rung-0 lacks the zero-pad retry) and must still be allowed.
  it("D8b: on a clean rung-0 MISS, Plan D's fallback must not re-fetch the exact code a second time (pad variants still allowed)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    stubFreeRungFetch({ upcHit: false }); // rung-0 completes a genuine miss (items: [])

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));
    expect(outcome.kind).toBe("computed");

    const upcUrls = fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => String(u).includes(UPCITEMDB_HOST));
    const exactUrls = upcUrls.filter((u) => u.includes(`upc=${VALID_GTIN}`));
    // The exact code must be fetched AT MOST ONCE across the whole request (rung-0's own attempt).
    expect(exactUrls.length).toBeLessThanOrEqual(1);
  });

  // E1 (efficiency audit, 2026-07-20): the retail knowledge index (lookupRetailBarcodeAsync) was queried
  // TWICE per request on a rung-0-retail-miss decode path - once by the outer rung-0 retail peek and AGAIN
  // by computeDecode's own consensus/contradiction retail peek, for the IDENTICAL code that just missed.
  // Both hit the same Turso/SQLite index; the second is a provably wasted DB round-trip on every miss path
  // (the ONLY way computeDecode is reached). This mirrors the D8/D8b UPCitemdb thread-through: rung-0's
  // retail result is now threaded into computeDecode, which reuses it instead of re-querying. Behavior is
  // IDENTICAL (the deterministic index returns the same row for the same code either way) - just one fewer
  // query. On a genuine rung-0 retail MISS a GTIN-shaped code must call lookupRetailBarcodeAsync AT MOST
  // ONCE across the whole request. Pre-fix this was 2.
  it("E1: on a rung-0 retail MISS, lookupRetailBarcodeAsync is called AT MOST ONCE per request (no duplicate consensus re-query)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // ensure the paid ladder / Plan D genuinely runs
    vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null); // trusted tire corpus misses first
    vi.mocked(getLearnedProduct).mockResolvedValueOnce(null); // learned tier misses too
    // Retail index MISSES (null) - so the ladder + Plan D consensus run; the second (now-removed) peek
    // would previously have re-queried the identical code here.
    vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue(null);
    stubFreeRungFetch({ upcHit: false }); // both free rungs miss so the pipeline reaches Plan D + paid phase

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    expect(outcome.kind).toBe("computed");
    // The retail index (deterministic per code) is queried AT MOST ONCE for the whole request.
    expect(vi.mocked(lookupRetailBarcodeAsync).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("cap available + free rungs MISS -> paid charge happens EXACTLY ONCE, paid rungs run, and reasons chain is free-phase-then-paid-phase", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap
    // L6 (Task 12c): the total-miss cap charge now only fires when paidWorkPossible() is true. A Brave
    // key makes Fetch V2's paid discovery door capable (code-shape-agnostic), so this stays genuinely
    // paid-capable WITHOUT touching Go-UPC's own 30-day negative-miss cache (a GO_UPC_API_KEY here
    // would make goupc actually query go-upc.com and write a real negative-cache entry for VALID_GTIN
    // into the shared per-file ladder-storage tmp dir, which would then leak into the PAY-ONCE
    // describe block's later "genuine Go-UPC miss"/"goupc_inferred" tests on the same code - see the
    // ORDER v3 describe block's own beforeEach below, which has to explicitly clean up that exact file
    // for the same reason). goupc itself still has no key, so it still just records its own "no key"
    // skip reason - the rung order is unchanged from before L6.
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    stubFreeRungFetch({ upcHit: false }); // both free rungs genuinely miss

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect(Array.isArray(reasons)).toBe(true);
    const rungOrder = (reasons ?? []).map((r) => r.rung);
    // Free phase first (both GTIN-gated free rungs ran and missed), then the paid phase in order.
    // goupc is GTIN-gated in (VALID_GTIN qualifies); no live Go-UPC key means it still misses too.
    expect(rungOrder).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
    // The paid daily-cap counter was charged EXACTLY ONCE for this request (free rungs missed, so the
    // paid phase ran; the cap started at 0 and must now read exactly 1 - not 0, not 2+).
    expect(await readDailyUsed(await ladderStorage())).toBe(1);
    // F2: the outcome's paidComputeCharged flag mirrors the cap charge - genuine paid compute happened.
    expect(outcome.paidComputeCharged).toBe(true);
  });

  it("L6: total-miss with free rungs MISS but NO keys at all -> cap counter stays at 0 (paid work was never possible)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap - the point is the charge gate, not a block
    stubFreeRungFetch({ upcHit: false }); // both free rungs genuinely miss; no provider keys configured

    // A code DISTINCT from VALID_GTIN (own module-level FetchV2Cache/GoUpcGate singleton residue must
    // never leak into the other VALID_GTIN-keyed tests in this file that expect a FRESH ladder run).
    const KEYLESS_MISS_GTIN = "900000000102"; // valid GS1 check digit, absent from every fixture
    const outcome = await runDecodePipeline(makeReq(KEYLESS_MISS_GTIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    // The paid phase still RUNS (goupc/fetchv2/gpt each record their own skip/miss reason - L6 only
    // gates the CAP CHARGE, never the rungs themselves), but nothing was genuinely payable.
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    const rungOrder = (reasons ?? []).map((r) => r.rung);
    expect(rungOrder).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    // F2: no paid compute was possible (no keys), so the outcome flag is false, mirroring the 0 counter.
    expect(outcome.paidComputeCharged).toBe(false);
  });

  it("Z3: two encodings of one product share one cache identity (canonical GTIN cache key)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the shared key, not the block
    // RETAIL RUNG-0 FIX: this fixture code happens to be a REAL hit in the local dev retail SQLite DB
    // ("peanut butter creamy") - the new rung-0 retail settle would otherwise short-circuit BEFORE
    // withDecodeCache is ever reached, and this test's spy would never see it. Force a retail miss so
    // this test stays isolated to its actual concern (the cache-key identity), same as it already
    // isolates itself from the tire corpus below.
    vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue(null);
    const seen: string[] = [];
    const withDecodeCacheSpy = vi.spyOn(decodeCacheModule, "withDecodeCache");
    withDecodeCacheSpy.mockImplementation(async (key, _isSuccess, compute) => {
      seen.push(key);
      return { value: await compute(), cached: false };
    });

    // Same product, two zero-padding encodings: EAN-13 "0036000291452" and its UPC-A form
    // "036000291452" both canonicalize to "00036000291452" (canonicalGtin pads to 14).
    await runDecodePipeline(makeReq("0036000291452"));
    await runDecodePipeline(makeReq("036000291452"));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]); // one shared cache identity, not two
    expect(seen[0]).toBe("00036000291452");

    withDecodeCacheSpy.mockRestore();
  });

  // PAY-ONCE RULE (owner ratified 2026-07-14): a Go-UPC or Fetch V2 win is PAID WORK - it must persist
  // to the durable L2 store so no other serverless instance ever pays for the same code twice. Free
  // rungs (tire-corpus, retail, upcitemdb, openfoodfacts, parallel:* i.e. Plan D) must still NEVER
  // persist - a wrong free guess must stay correctable by a future corpus update.
  describe("classifySourceTier (PAY-ONCE persistence classification)", () => {
    it("PAY-ONCE: a Go-UPC verified win persists to L2", () => {
      expect(classifySourceTier("ok", ["go-upc"])).toBe("paid_rung");
    });

    it("PAY-ONCE: a Fetch V2 win persists even when Plan D stash prepended its provider name", () => {
      expect(classifySourceTier("ok", ["parallel:barcodeDb", "fetchv2"])).toBe("paid_rung");
    });

    it("gpt_ladder reasonCode still classifies as gpt_ladder (unchanged, checked before paid_rung)", () => {
      expect(classifySourceTier("gpt_ladder", ["gpt"])).toBe("gpt_ladder");
    });

    it("legacy paid AI provider markers still classify as paid_ai (unchanged, checked before paid_rung)", () => {
      expect(classifySourceTier("ok", ["gemini"])).toBe("paid_ai");
      expect(classifySourceTier("ok", ["openai"])).toBe("paid_ai");
    });

    it("free rungs still never persist", () => {
      expect(classifySourceTier("ok", ["tire-corpus"])).toBeNull();
      expect(classifySourceTier("needs_review", ["upcitemdb"])).toBeNull();
      expect(classifySourceTier("needs_review", ["openfoodfacts"])).toBeNull();
      expect(classifySourceTier("ok", ["parallel:groundIdentify"])).toBeNull();
    });
  });

  describe("PAY-ONCE L2 write-through: paid-rung suggestions persist too", () => {
    const GOUPC_HOST = "go-upc.com";

    function stubGoUpcInferredHit() {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(GOUPC_HOST)) {
          return new Response(
            JSON.stringify({
              inferred: true,
              product: { name: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire", specs: [] },
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    function stubGoUpcGenuineMiss() {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(GOUPC_HOST)) return new Response("not found", { status: 404 }); // genuine miss
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    it("a goupc_inferred SUGGESTION (needs_review) is paid work and persists to L2", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubGoUpcInferredHit();

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.providerNames).toContain("go-upc");
      expect(outcome.payload.decision.status).toBe("needs_review"); // inferred hit is a suggestion, not verified

      const persisted = await getPersistedDecode("00" + VALID_GTIN);
      expect(persisted).not.toBeNull();
      expect(persisted?.kind).toBe("result");
      expect(persisted?.sourceTier).toBe("paid_rung");
    });

    it("a genuine Go-UPC miss (no usable identity) does NOT persist a result to L2", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubGoUpcGenuineMiss();

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).not.toBe("verified");

      const persisted = await getPersistedDecode("00" + VALID_GTIN);
      // Either nothing was persisted, or (if the exhausted ladder earned a receipt) it is a receipt,
      // never a "result" - a miss must never fabricate a permanent paid_rung result.
      if (persisted) {
        expect(persisted.kind).not.toBe("result");
      }
    });

    // Task 2 Step 3c (:1572 concern): demoting Go-UPC to "suggested" must NOT stop it from being
    // cached - the L2 write-through gate at pipeline.ts (`status === "verified" || status === "suggested"`,
    // combined with classifySourceTier's paid_rung classification for "go-upc") already covers a
    // demoted, settled Go-UPC suggestion. Prove it end-to-end: a clean exact Go-UPC hit persists, and a
    // SECOND scan of the same code replays from the L2 cache without re-invoking the paid Go-UPC API -
    // the pay-once rule must hold even after the honesty relabel.
    function stubGoUpcCleanExactHit() {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(GOUPC_HOST)) {
          return new Response(
            JSON.stringify({
              inferred: false,
              product: { name: "Continental TrueContact Tour 235/60R18", brand: "Continental", category: "Tire", specs: [] },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    it("a demoted Go-UPC 'suggested' settle STILL persists to L2, and a repeat scan does NOT re-invoke the paid Go-UPC API (pay-once holds post-demotion)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      // A fixture code DISTINCT from VALID_GTIN: the preceding test in this same describe block
      // ("a genuine Go-UPC miss...") writes a real 30-day negative-miss-cache entry for VALID_GTIN in
      // the shared per-pid ladder-storage tmp dir, which would otherwise short-circuit this test's
      // fresh 200 hit into a stale "miss" (own FetchV2Cache/GoUpcGate module-singleton residue avoided
      // too, same isolation reasoning used throughout this file).
      const CLEAN_HIT_GTIN = "900000000201";
      stubGoUpcCleanExactHit();

      const first = await runDecodePipeline(makeReq(CLEAN_HIT_GTIN));
      expect(first.kind).toBe("computed");
      if (first.kind !== "computed") throw new Error("unreachable");
      expect(first.payload.decision.status).toBe("suggested");
      expect(first.payload.providerNames).toContain("go-upc");

      const persisted = await getPersistedDecode("00" + CLEAN_HIT_GTIN);
      expect(persisted).not.toBeNull();
      expect(persisted?.kind).toBe("result");
      expect(persisted?.sourceTier).toBe("paid_rung");

      // Clear the L1 in-memory cache (but NOT the L2 persisted store) so the second call is forced to
      // consult L2 exactly like a fresh serverless instance would - otherwise the in-process L1 hit
      // would mask whether L2 persistence actually happened.
      clearDecodeCache();

      // Second scan of the SAME code: swap in a fetch stub that would THROW if the paid Go-UPC API were
      // ever called again, proving the second request replays from L2 instead of re-paying.
      const secondFetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("go-upc.com/api")) throw new Error("go-upc must NOT be re-invoked on a repeat scan of a cached code");
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", secondFetchSpy);

      const second = await runDecodePipeline(makeReq(CLEAN_HIT_GTIN));
      expect(second.kind).toBe("persisted");
      if (second.kind !== "persisted") throw new Error("unreachable");
      expect((second.body.decision as { status?: string }).status).toBe("suggested");
      expect(secondFetchSpy.mock.calls.some(([u]) => String(u).includes("go-upc.com/api"))).toBe(false);
    });
  });

  // ORDER v3 + ESCALATE-PAST-SUGGESTION (owner ratified 2026-07-14, Task 7). New computeDecode order:
  // retail peek -> FREE ladder rungs -> Plan D -> cap gate -> paid ladder. A free-rung SUGGESTION
  // (UPCitemdb / Open Food Facts always suggest, never verify) no longer STOPS the pipeline: it is
  // stashed as a fallback, the pipeline continues to Plan D and then a cap-charged GO-UPC-ONLY phase.
  // Go-UPC verified exact -> Go-UPC wins; otherwise the free suggestion is the final answer, and
  // fetchv2/gpt NEVER run past it. A total free MISS keeps today's full paid ladder.
  describe("ORDER v3 escalate-past-suggestion", () => {
    const GOUPC_HOST = "go-upc.com";

    // Isolation: the Go-UPC negative miss cache lives in the SHARED per-pid ladder-storage tmp dir and
    // is NOT cleared by the outer beforeEach (only the daily-cap KV is). An earlier PAY-ONCE "genuine
    // Go-UPC miss" test writes a 30-day negative-cache entry for VALID_GTIN; without clearing it, this
    // suite's Go-UPC escalation would short-circuit on the stale miss instead of the fresh 200 hit.
    beforeEach(() => {
      try { fs.unlinkSync(path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`, ".go-upc-miss-cache.json")); } catch {}
    });

    // Drive UPCitemdb -> a suggestion hit; Go-UPC -> verified exact (200, inferred:false); everything
    // else 404. Open Food Facts misses (status 0). A verified exact Go-UPC hit needs a code whose GS1
    // prefix isn't a known single-brand owner - VALID_GTIN "900000000003" (prefix 9000000) qualifies.
    function stubUpcSuggestionThenGoupc(opts: { goupcVerified: boolean }) {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) {
          return new Response(
            JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
            { status: 200 }
          );
        }
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes(GOUPC_HOST)) {
          if (opts.goupcVerified) {
            return new Response(
              JSON.stringify({ inferred: false, product: { name: "Continental TrueContact Tour 235/60R18", brand: "Continental", category: "Tire", specs: [] } }),
              { status: 200 }
            );
          }
          return new Response("not found", { status: 404 }); // Go-UPC genuine miss
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    const ladderRungsOf = (out: Awaited<ReturnType<typeof runDecodePipeline>>): string[] => {
      if (out.kind !== "computed") return [];
      const reasons = out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
      return (reasons ?? []).map((r) => r.rung);
    };

    it("free rungs run BEFORE the paid Go-UPC phase (no paid spend charged before the free UPCitemdb suggestion)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: true });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      // The free UPCitemdb suggestion is observed FIRST in the reasons chain, ahead of goupc.
      const rungs = ladderRungsOf(out);
      expect(rungs.indexOf("upcitemdb")).toBeGreaterThanOrEqual(0);
      expect(rungs.indexOf("upcitemdb")).toBeLessThan(rungs.indexOf("goupc"));
    });

    it("ESCALATION: a free suggestion continues to Go-UPC; a cleanly-settled Go-UPC hit still WINS over the free-rung stash (Task 2 Step 3c demotion ripple)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: true });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      // D6: Go-UPC is now an honest "suggested" (never fabricated "verified"), but a cleanly-settled
      // paid Go-UPC hit must still WIN over the weaker free-rung (upcitemdb) stash - the paid answer is
      // never silently discarded just because it is no longer labeled "verified".
      expect(out.payload.decision.status).toBe("suggested");
      expect(out.payload.providerNames).toContain("go-upc");
      // Prove Go-UPC's identity (Continental), not the free rung's stashed identity (Falken), won.
      expect(out.payload.results[0]?.brand).toBe("Continental");
      // The escalation ran Go-UPC only; fetchv2/gpt were NEVER reached.
      const rungs = ladderRungsOf(out);
      expect(rungs).not.toContain("fetchv2");
      expect(rungs).not.toContain("gpt");
    });

    // wave-3 (2026-07-20 owner-ratified ORDER v3 EXTENSION): a Go-UPC miss no longer stops the
    // escalation - Fetch V2 now ALSO gets a shot at beating the free suggestion (this test's stub has
    // no discovery keys configured, so Fetch V2's paid doors can't run and it can only miss via the
    // free keyless pattern-URL door - see paidWorkPossible/fetchV2CanPay gating). GPT still never runs
    // here (no OPENAI_API_KEY configured), and the stashed free suggestion still stands as the final
    // answer because nothing produced a strictly-higher-confidence or verified result.
    it("ESCALATION: a Go-UPC miss falls back to the stashed free suggestion; fetchv2 gets a shot but can't beat it (no discovery keys); gpt never runs (no key)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: false });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      // The stashed free suggestion is the final answer (its provider name survives in the payload).
      expect(out.payload.providerNames).toContain("upcitemdb");
      // gpt must never run past a free suggestion when it has no key to pay with.
      const rungs = ladderRungsOf(out);
      expect(rungs).not.toContain("gpt");
    });

    it("cap slot IS charged for the escalation Go-UPC call (paid work is paid work)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: true });

      await runDecodePipeline(makeReq(VALID_GTIN));

      // Exactly one paid slot charged for the escalation Go-UPC phase.
      expect(await readDailyUsed(await ladderStorage())).toBe(1);
    });

    it("ESCALATION cap-blocked: an exhausted cap blocks the Go-UPC escalation, free suggestion still stands, zero charge", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: true });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      // The cap gate throws before the paid Go-UPC escalation runs -> route turns it into a cap block.
      expect(out.kind).toBe("cap_blocked");
      if (out.kind !== "cap_blocked") throw new Error("unreachable");
      expect(out.message).toMatch(/cap/i);
      expect(await readDailyUsed(await ladderStorage())).toBe(0);
    });

    it("free phase TOTAL MISS still runs the full paid ladder (goupc -> fetchv2 -> gpt) as before", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      // Free rungs both miss; Go-UPC misses too -> the full paid ladder runs in order.
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      const rungs = ladderRungsOf(out);
      // The full paid ladder ran after the free miss: goupc -> fetchv2 -> gpt all present.
      expect(rungs).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
    });
  });

  // AM-10 (Task 12 deferred pipeline hunk): an ASIN-shaped code's fetchv2 rung must fetch its
  // Amazon /dp/ pattern URL. ASIN is a vendor_label (non-GTIN) shape, so buildPaidLadderRungs only
  // includes ["fetchv2", "gpt"] - no goupc, no free rungs - which routes the code straight to the
  // fetchv2 rung under test with nothing else to interfere.
  it("AM-10: an ASIN code's fetchv2 rung fetches its /dp/ pattern URL", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the URL fetched, not a block
    const ASIN = "B08XYZ9ABC"; // fresh fixture, distinct from every GTIN code used elsewhere in this file
    const outcome = await runDecodePipeline(makeReq(ASIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    // The rung ran (it may still miss - the stubbed fetch 404s everything by default - the point is
    // that the /dp/ URL was actually requested, proving the pattern-URL hunk fires for an ASIN).
    const dpCalls = fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("amazon.com/dp/B08XYZ9ABC"));
    expect(dpCalls.length).toBeGreaterThan(0);
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect((reasons ?? []).map((r) => r.rung)).toContain("fetchv2");
    // ASIN is never a public barcode - decideDecode must never verify/auto-count it via this door.
    expect(outcome.payload.decision.status).not.toBe("verified");
  });

  // A6 (Task 9, AM-3 hardened gate): a code whose GTIN prefix carries a STRONG, >=8-digit tire hint
  // must skip BOTH free LADDER rungs entirely (neither "upcitemdb" nor "openfoodfacts" appears in the
  // ladder's own reasons chain) and record the steering reason instead. Prefix "04501135" (Aplus,
  // strong, 8 digits) is the same real fixture proven in freeRungSteering.test.ts; a distinct 12-digit
  // padding is used here so this test's ladder run shares no FetchV2Cache/GoUpcGate module-singleton
  // residue with that unit test. NOTE: this assertion is scoped to the LADDER's reasons chain (not raw
  // fetch call inspection) because the AM-7 keyless fetchv2 pattern-URL door (barcodeSources.ts's
  // "upcitemdb.com" web-page entry) can legitimately reach an upcitemdb-family host for an unrelated
  // reason - only the ladder's own reasons chain unambiguously proves whether the STEERED rungs
  // (upcitemdb/openfoodfacts) ran. (D8, Task 2: Plan D's `lookupBarcodeDb` dep no longer performs its
  // own fetch at all - it is now fed from the tracked rung-0 UPCitemdb result via a closure, so it can
  // never be a second, untracked fetch call to api.upcitemdb.com.)
  it("A6: a steered tire-prefix code skips upcitemdb/openfoodfacts and records the steering reason", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const STEERED_TIRE_CODE = "450113522222"; // GTIN-13 "0450113522222" -> prefix "04501135" (Aplus, strong, 8 digits)
    stubFreeRungFetch({ upcHit: false }); // if the free rungs WERE called (steering broken), they would 200 with a miss body - never called here

    const outcome = await runDecodePipeline(makeReq(STEERED_TIRE_CODE));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    const rungsSeen = (reasons ?? []).map((r) => r.rung);
    expect(rungsSeen).not.toContain("upcitemdb");
    expect(rungsSeen).not.toContain("openfoodfacts");
    expect(rungsSeen).toContain("free-steering");
    const steeringReason = (reasons ?? []).find((r) => r.rung === "free-steering")?.reason ?? "";
    expect(steeringReason).toContain("tire-prefix steering");
    expect(steeringReason).toContain("04501135");
  });

  // Task 21 (owner-ratified 2026-07-15): the learned-products tier peek runs right after the trusted
  // tire/retail corpus misses, and returns an honest SUGGESTION (never verified) at the row's stored
  // confidence. These tests mock resolveExactBarcode to miss (real corpus fixtures do not know this
  // synthetic code) and getLearnedProduct to hit, isolating the learned-tier peek from every other rung.
  describe("Task 21: learned-products tier peek", () => {
    const LEARNED_CODE = "086699998538"; // Michelin-family GS1 prefix (086699), matches learnedProducts.test.ts fixtures

    function makeLearnedRow(overrides: Partial<LearnedProductRow> = {}): LearnedProductRow {
      return {
        code: "0086699998538",
        name: "Michelin Defender LTX M/S",
        brand: "Michelin",
        category: "tire",
        specsShort: "275/60R20 115T",
        specsFull: "275/60R20 115T",
        confidence: 0.95,
        sourceUrl: "https://www.walmart.com/ip/michelin-defender/12345",
        evidenceStrength: "fetched_source",
        prefixCheck: "prefix-corroborated: catalog dominant brand for this prefix is \"michelin\"",
        createdAt: "2026-07-14T12:00:00.000Z",
        ...overrides,
      };
    }

    it("a learned hit returns 'suggested' (NEVER 'verified') at the row's stored confidence, with an honest reason naming the learned tier + source host + date", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null); // trusted corpus misses first
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(makeLearnedRow());

      const outcome = await runDecodePipeline(makeReq(LEARNED_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.decision.status).not.toBe("verified");
      expect(outcome.payload.decision.confidence).toBe(0.95);
      expect(outcome.payload.decision.reason).toContain("learned");
      expect(outcome.payload.decision.reason).toContain("walmart.com");
      expect(outcome.payload.decision.reason).toContain("2026-07-14");
      expect(outcome.payload.providerNames).toContain("learned-products");
      // No AI/paid provider was ever contacted for a learned-tier hit - it is a $0 replay.
      expect(hitAnAiProvider()).toBe(false);
    });

    it("a learned hit never marks exactCodeEvidenceVerifiedByApp true (it is a replay, not a fresh app verification)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(makeLearnedRow());

      const outcome = await runDecodePipeline(makeReq(LEARNED_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
    });

    it("the trusted tire corpus still wins when BOTH the corpus and a learned row exist for the same code (corpus is authoritative)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const corpusHit: CorpusDecodeResult = {
        decision: {
          status: "verified",
          confidence: 0.97,
          reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          crossCheck: { decision: "single_provider", confidence: 0.97, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
          corroborationPath: "corpus_exact_barcode",
        },
        results: [{ productName: "Michelin Defender LTX M/S 275/60R20 115T", brand: "Michelin", category: "Tire", specsShort: "275/60R20 115T", confidence: 0.97, needsHumanReview: false, sourceUrls: [], verifiedFacts: [], primaryBarcode: LEARNED_CODE } as unknown as CorpusDecodeResult["results"][number]],
        evidences: [{ verified: true, strength: "fetched_source", matchedCode: LEARNED_CODE, matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." }],
        providerNames: ["tire-corpus"],
        path: "corpus_exact_barcode",
      };
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(corpusHit);
      // A learned row also exists, but must never even be consulted - the corpus peek returns first.
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(makeLearnedRow());

      const outcome = await runDecodePipeline(makeReq(LEARNED_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.providerNames).toContain("tire-corpus");
      expect(outcome.payload.decision.status).toBe("verified");
      expect(vi.mocked(getLearnedProduct)).not.toHaveBeenCalled();
    });

    it("no learned row and no corpus hit falls through to the normal ladder (learned-tier peek is a pure pass-through miss)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.providerNames).not.toContain("learned-products");
    });
  });

  // Sync Truth Task 4 (owner-approved 2026-07-22): the master-catalog peek runs right after the
  // learned-products tier peek and still before the L2 persisted-decode cache / daily-cap gate, so a
  // hit NEVER reaches a paid rung ("first settled rung stops the ladder, never pay when an earlier
  // rung already answered"). lookupMasterCatalog itself is mocked module-wide (see the vi.mock block
  // near the top of this file) - these tests drive it directly rather than mocking Firestore, mirroring
  // how the learned-tier tests above drive getLearnedProduct directly instead of a real store.
  describe("Sync Truth Task 4: master-catalog free ladder rung", () => {
    const MASTER_CODE = "086699997654"; // GTIN-shaped, not on any real corpus/learned fixture

    it("human_verified hit settles as VERIFIED and stops the ladder before any paid rung runs", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      vi.mocked(lookupMasterCatalog).mockResolvedValueOnce({
        kind: "verified",
        entry: { id: "gtin_00086699997654", normalizedBarcode: MASTER_CODE, name: "Michelin Defender LTX M/S", brand: "Michelin", category: "tire", verificationStatus: "verified", provenanceTier: "human_verified" },
      });

      const outcome = await runDecodePipeline(makeReq(MASTER_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("verified");
      expect(outcome.payload.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
      expect(outcome.payload.providerNames).toContain("master-catalog");
      expect(outcome.payload.results[0].productName).toBe("Michelin Defender LTX M/S");
      // Never contacted a paid provider and never charged the daily cap (this rung is FREE, L12).
      expect(hitAnAiProvider()).toBe(false);
      expect(await readDailyUsed(await ladderStorage())).toBe(0);
    });

    it("verified-but-not-human_verified hit settles as a SUGGESTION (never auto-verified), also without reaching a paid rung", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      vi.mocked(lookupMasterCatalog).mockResolvedValueOnce({
        kind: "suggestion",
        entry: { id: "gtin_00086699997654", normalizedBarcode: MASTER_CODE, name: "Michelin Defender LTX M/S", brand: "Michelin", category: "tire", verificationStatus: "verified", provenanceTier: "ladder_verified_strong" },
      });

      const outcome = await runDecodePipeline(makeReq(MASTER_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.decision.status).not.toBe("verified");
      expect(outcome.payload.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
      expect(outcome.payload.providerNames).toContain("master-catalog");
      expect(hitAnAiProvider()).toBe(false);
      expect(await readDailyUsed(await ladderStorage())).toBe(0);
    });

    it("a miss (pending / rejected / not found) falls through to the rest of the ladder", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      vi.mocked(lookupMasterCatalog).mockResolvedValueOnce({ kind: "miss" });
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.providerNames).not.toContain("master-catalog");
      expect(vi.mocked(lookupMasterCatalog)).toHaveBeenCalled();
    });

    it("e2eMode() bypasses the rung entirely - lookupMasterCatalog is never called", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.IS_E2E = "1";
      vi.mocked(lookupMasterCatalog).mockResolvedValueOnce({
        kind: "verified",
        entry: { id: "gtin_00086699997654", normalizedBarcode: MASTER_CODE, name: "Should Never Be Used", verificationStatus: "verified", provenanceTier: "human_verified" },
      });

      await runDecodePipeline(makeReq(MASTER_CODE));

      expect(vi.mocked(lookupMasterCatalog)).not.toHaveBeenCalled();
    });
  });

  // Task 21: the learned-tier WRITE only fires when shouldLearnDecode's full gate passes on a FRESH
  // verified decode. These tests mock the top-level fetchV2 engine call directly to hand back a
  // controlled "verified" result (fetched_source-equivalent: exactCodeFound true, a chosen
  // winningSourceUrl) from either a trusted or untrusted host, and assert upsertLearnedProduct
  // is/is not called - proving the write gate reads the winning source host honestly.
  describe("Task 21: learned-products tier write gate", () => {
    // A code whose GS1 prefix is Michelin-family (086699), so a decode naming brand "Michelin" is
    // prefix-corroborated. Distinct 13-digit padding from the read-side fixture above so this test's
    // FetchV2Cache/GoUpcGate module-singleton residue never collides with it.
    const WRITE_TEST_CODE = "0086699912345";

    function mockFetchV2VerifiedWin(sourceUrl: string) {
      vi.mocked(fetchV2).mockResolvedValueOnce(
        makeResult({
          rawValue: WRITE_TEST_CODE,
          outcome: "verified",
          product: {
            brand: "Michelin",
            name: "Michelin Defender LTX M/S 275/60R20 115T",
            model: "Defender LTX M/S",
            partNumber: "",
            size: "275/60R20 115T",
            description: "",
            category: "tire",
            imageUrl: "",
          },
          evidence: {
            exactCodeFound: true,
            codeToProductProven: true,
            sourceQuality: "strong",
            sourceScore: 95,
            identityScore: 1,
            associationScore: 1,
            finalConfidence: 0.95,
            winningSourceUrl: sourceUrl,
            winningSourceType: "strong_commercial",
            codeLocation: "json_ld.gtin",
            proofSummary: "exact code in a structured product record",
          },
          sourcesChecked: [sourceUrl],
        }),
      );
    }

    it("a verified fetchv2 win from a TRUSTED host that is prefix-corroborated WRITES a learned row", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      const trustedUrl = "https://www.walmart.com/ip/michelin-defender-ltx/12345";
      mockFetchV2VerifiedWin(trustedUrl);

      const outcome = await runDecodePipeline(makeReq(WRITE_TEST_CODE));
      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("verified");

      // Allow the fire-and-forget write's microtask to settle before asserting.
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(upsertLearnedProduct)).toHaveBeenCalled();
      const written = vi.mocked(upsertLearnedProduct).mock.calls[0]?.[0];
      expect(written?.brand).toBe("Michelin");
      expect(written?.sourceUrl).toBe(trustedUrl);
    });

    it("the SAME verified fetchv2 win from an UNTRUSTED host does NOT write a learned row", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      const untrustedUrl = "https://randomtireblog.example.com/reviews/michelin-defender";
      mockFetchV2VerifiedWin(untrustedUrl);

      const outcome = await runDecodePipeline(makeReq("0086699954321")); // distinct code, own cache/module residue
      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("verified"); // still verifies - the floor/learn gates are independent of decideDecode's own verify

      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(upsertLearnedProduct)).not.toHaveBeenCalled();
    });

    it("a verified fetchv2 win from a trusted host WITHOUT prefix corroboration (unmapped prefix) does NOT write", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const UNMAPPED_PREFIX_CODE = "0000000012347"; // no GS1 prefix data at all
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      vi.mocked(fetchV2).mockResolvedValueOnce(
        makeResult({
          rawValue: UNMAPPED_PREFIX_CODE,
          outcome: "verified",
          product: { brand: "Michelin", name: "Michelin Defender LTX M/S 275/60R20 115T", model: "Defender LTX M/S", partNumber: "", size: "275/60R20 115T", description: "", category: "tire", imageUrl: "" },
          evidence: {
            exactCodeFound: true, codeToProductProven: true, sourceQuality: "strong", sourceScore: 95,
            identityScore: 1, associationScore: 1, finalConfidence: 0.95,
            winningSourceUrl: "https://www.walmart.com/ip/x", winningSourceType: "strong_commercial",
            codeLocation: "json_ld.gtin", proofSummary: "",
          },
          sourcesChecked: ["https://www.walmart.com/ip/x"],
        }),
      );

      await runDecodePipeline(makeReq(UNMAPPED_PREFIX_CODE));

      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(upsertLearnedProduct)).not.toHaveBeenCalled();
    });
  });

  // LANE C ITEM C4 (owner-reported live regression, 2026-07-20): the "721749* family" - 721749089643
  // learned as a Fortune tire; a sibling code sharing the same GS1 prefix (721749249238, the owner's
  // named example) decoded to an unrelated Lattafa perfume and was stored as a clean suggestion instead
  // of conflicting. siblingPrefixConflict (learnedProducts.ts) must demote this to needs_review with an
  // honest conflict reason - never suppress the row.
  describe("Item C4: same-prefix sibling contradiction guard (Fortune tire vs Lattafa perfume)", () => {
    const SIBLING_PREFIX_CODE = "7217492492380"; // GTIN-13 form of 721749249238, same 721749 GS1 block

    it("demotes an UNVERIFIED fetchv2 suggestion (no strong app-verified exact-code evidence for THIS scan) to needs_review when it contradicts an already-learned same-prefix sibling", async () => {
      // Mirrors the real live shape: the owner's stress batch shows Fortune-family codes settling as
      // FetchV2 "suggested" outcomes (unverified evidence), never "verified" - so this is the realistic
      // fixture for the guard actually firing. A fetchv2 "verified" outcome is BY DEFINITION built from
      // strong app-verified exact-code evidence for the scanned code itself, which the owner's own Plan
      // C override rule says must win over ANY prefix conflict (existing evidence-strength rule,
      // unchanged) - so this guard's bite is on suggestions/weaker evidence, exactly like the static
      // catalog-derived firewall it sits beside.
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      // A genuinely learned sibling exists on the SAME 721749 GS1 prefix: a Fortune tire.
      vi.mocked(siblingPrefixConflict).mockResolvedValueOnce({
        conflict: true,
        overriddenByEvidence: false,
        reason:
          'Barcode prefix 721749 already has a verified sibling product "Fortune Tormenta H/T FSR305 265/75R16 116T BSW" (brand "Fortune", category "tire"); candidate is a different brand + category ("Lattafa" / "perfume"). Demoted to Needs Review.',
        siblingCode: "00721749089643",
      });
      vi.mocked(fetchV2).mockResolvedValueOnce(
        makeResult({
          rawValue: SIBLING_PREFIX_CODE,
          outcome: "suggested",
          product: {
            brand: "Lattafa",
            name: "LATTAFA GIVE ME GOURMAND VANILLA FREAK/EDP",
            model: "",
            partNumber: "",
            size: "",
            description: "",
            category: "perfume",
            imageUrl: "",
          },
          evidence: {
            exactCodeFound: false, codeToProductProven: false, sourceQuality: "weak", sourceScore: 40,
            identityScore: 0.6, associationScore: 0.5, finalConfidence: 0.5,
            winningSourceUrl: "https://www.someperfumeshop.example.com/p/lattafa", winningSourceType: "weak_association",
            codeLocation: "text_mention", proofSummary: "",
          },
          sourcesChecked: ["https://www.someperfumeshop.example.com/p/lattafa"],
        }),
      );

      const outcome = await runDecodePipeline(makeReq(SIBLING_PREFIX_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // Demoted: never verified when it contradicts a genuinely verified same-prefix sibling.
      expect(outcome.payload.decision.status).not.toBe("verified");
      // The row still appears with its identity (never suppressed) - "every scan appears and counts".
      expect(outcome.payload.results[0]?.productName).toContain("LATTAFA");
      expect(vi.mocked(siblingPrefixConflict)).toHaveBeenCalled();
    });

    it("does NOT demote when siblingPrefixConflict reports no conflict (no learned sibling, or same-company)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      vi.mocked(siblingPrefixConflict).mockResolvedValueOnce({ conflict: false, overriddenByEvidence: false, reason: "" });
      const trustedUrl = "https://www.walmart.com/ip/fortune-tormenta/12345";
      vi.mocked(fetchV2).mockResolvedValueOnce(
        makeResult({
          rawValue: SIBLING_PREFIX_CODE,
          outcome: "verified",
          product: { brand: "Fortune", name: "Fortune Tormenta H/T FSR305 265/75R16 116T BSW", model: "Tormenta H/T FSR305", partNumber: "", size: "265/75R16 116T", description: "", category: "tire", imageUrl: "" },
          evidence: {
            exactCodeFound: true, codeToProductProven: true, sourceQuality: "strong", sourceScore: 95,
            identityScore: 1, associationScore: 1, finalConfidence: 0.95,
            winningSourceUrl: trustedUrl, winningSourceType: "strong_commercial",
            codeLocation: "json_ld.gtin", proofSummary: "",
          },
          sourcesChecked: [trustedUrl],
        }),
      );

      const outcome = await runDecodePipeline(makeReq(SIBLING_PREFIX_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("verified");
    });
  });

  // RC3 (pilot PN recall fix): the corpus part-number lookup used to only run for codeType
  // alpha_sku|vendor_label. Shop part numbers are frequently ALL-NUMERIC (numeric_sku, e.g.
  // "3415030603") or a messy vendor string ("275-30-20 ARROYO") and never got a PN lookup attempt at
  // all. This gate must now ALSO try resolveExactPartNumber for numeric_sku and messy shapes, while
  // NEVER trying it for a GTIN shape (upc_a/ean_13/gtin_14) - those are barcodes, not part numbers,
  // and resolveExactBarcode (not resolveExactPartNumber) is the correct rung for them.
  describe("RC3: PN-lookup gate reaches numeric_sku and messy shapes, never GTIN shapes", () => {
    it("a numeric_sku code reaches resolveExactPartNumber (gate-reaches-lookup, not corpus hit)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const NUMERIC_SKU_CODE = "3415030603"; // 10 digits: not 12/13/14, so detectCodeType -> numeric_sku
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(NUMERIC_SKU_CODE));

      expect(vi.mocked(resolveExactPartNumber)).toHaveBeenCalledWith(NUMERIC_SKU_CODE);
    });

    it("a messy vendor-string code reaches resolveExactPartNumber", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const MESSY_CODE = "275-30-20 ARROYO"; // has a space -> detectCodeType -> messy
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(MESSY_CODE));

      expect(vi.mocked(resolveExactPartNumber)).toHaveBeenCalledWith(MESSY_CODE);
    });

    it("an alpha_sku code still reaches resolveExactPartNumber (no regression on the existing gate)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const ALPHA_SKU_CODE = "KH2265992";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(ALPHA_SKU_CODE));

      expect(vi.mocked(resolveExactPartNumber)).toHaveBeenCalledWith(ALPHA_SKU_CODE);
    });

    it("a vendor_label code still reaches resolveExactPartNumber (no regression on the existing gate)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const VENDOR_LABEL_CODE = "X001234567"; // matches VENDOR_LABEL shape
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(VENDOR_LABEL_CODE));

      expect(vi.mocked(resolveExactPartNumber)).toHaveBeenCalledWith(VENDOR_LABEL_CODE);
    });

    it("a upc_a GTIN-shaped code NEVER reaches resolveExactPartNumber", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(VALID_GTIN)); // 12/13/14-digit fixture already used elsewhere in this file

      expect(vi.mocked(resolveExactPartNumber)).not.toHaveBeenCalled();
    });

    it("an ean_13 GTIN-shaped code NEVER reaches resolveExactPartNumber", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const EAN_13_CODE = "4006381333931";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(EAN_13_CODE));

      expect(vi.mocked(resolveExactPartNumber)).not.toHaveBeenCalled();
    });

    it("a gtin_14 GTIN-shaped code NEVER reaches resolveExactPartNumber", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const GTIN_14_CODE = "10036381333930";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(GTIN_14_CODE));

      expect(vi.mocked(resolveExactPartNumber)).not.toHaveBeenCalled();
    });

    // REVIEW FINDING (Important, EAN-8 hole): detectCodeType has no ean_8 bucket, so an 8-digit code
    // falls through the DIGITS_ONLY length checks straight to "numeric_sku" - the SAME codeType string
    // as a genuine numeric shop part number. The old gate (`codeType === "upc_a" || "ean_13" ||
    // "gtin_14"`) therefore let a real EAN-8 BARCODE through to resolveExactPartNumber, where it could
    // coincidentally match an unrelated 7-8 digit tire part number and produce a wrong-product
    // suggestion on a real barcode. isGtinShaped(code) (src/services/upc/gtin.ts) already treats
    // `^\d{8}$` as GTIN-shaped for exactly this reason; the gate must ask isGtinShaped, not the
    // codeType label, so EVERY GTIN-shaped code (8/12/13/14 digits) is excluded regardless of what
    // detectCodeType happens to call it.
    it("an 8-digit EAN-8-shaped code NEVER reaches resolveExactPartNumber (EAN-8 hole, review finding)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const EAN_8_CODE = "40054061"; // 8 digits: detectCodeType mislabels this "numeric_sku"
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(EAN_8_CODE));

      expect(vi.mocked(resolveExactPartNumber)).not.toHaveBeenCalled();
    });

    it("a genuine 10-digit numeric_sku code STILL reaches resolveExactPartNumber (regression: not GTIN-shaped)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const NUMERIC_SKU_CODE_10 = "3415030603"; // 10 digits: not 8/12/13/14, so not GTIN-shaped
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(NUMERIC_SKU_CODE_10));

      expect(vi.mocked(resolveExactPartNumber)).toHaveBeenCalledWith(NUMERIC_SKU_CODE_10);
    });

    it("a numeric_sku PN suggestion from the corpus is honored end-to-end (not just gate-reached)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const NUMERIC_SKU_CODE = "3415030603";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      const pnHit: CorpusDecodeResult = {
        decision: {
          status: "suggested",
          confidence: 0.85,
          reason: "Matched by part number in the tire knowledge base. Confirm before counting (part numbers are not unique like barcodes).",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: false,
          crossCheck: { decision: "single_provider", confidence: 0.85, reason: "Trusted corpus exact part number.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
        },
        results: [{ productName: "Some Tire 265/70R17", brand: "Some", category: "Tire", specsShort: "265/70R17", confidence: 0.85, needsHumanReview: false, sourceUrls: [], verifiedFacts: [], primarySku: NUMERIC_SKU_CODE } as unknown as CorpusDecodeResult["results"][number]],
        evidences: [{ verified: true, strength: "fetched_source", matchedCode: NUMERIC_SKU_CODE, matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." }],
        providerNames: ["tire-corpus"],
        path: "corpus_exact_part_number",
      };
      vi.mocked(resolveExactPartNumber).mockResolvedValueOnce(pnHit);

      const outcome = await runDecodePipeline(makeReq(NUMERIC_SKU_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.decision.status).not.toBe("verified");
      expect(outcome.payload.providerNames).toContain("tire-corpus");
      expect(hitAnAiProvider()).toBe(false);
    });
  });

  // RETAIL RUNG-0 FIX (live-proven bug): 19/20 retail barcodes that EXIST in the 4M-row retail Turso
  // corpus previously bypassed it entirely and fired a PAID Go-UPC call; one (EAN-8 "10000007", retail
  // corpus = "Saumon fume Ecossais tranche main") settled as a WRONG "Verified from Go-UPC" identity (a
  // beer). Root cause: the retail corpus was only ever peeked as a Plan D consensus VOTE (needs a
  // second agreeing source), gated to isPublicBarcode (upc_a/ean_13/gtin_14 - EAN-8 is NOT one of
  // those), so a lone retail-corpus hit could never settle by itself and an EAN-8 never even reached
  // the peek. The fix: a GTIN-shaped code (isGtinShaped, includes EAN-8) with a usable retail-corpus
  // name now settles at rung 0 (before the L2 cache, before the daily cap, before any paid rung) as a
  // "suggested" decode - free, honest, and never auto-counting beyond the existing suggestion gate.
  describe("RETAIL RUNG-0: retail corpus joins the free rung (incl. EAN-8) + paid-verified contradiction guard", () => {
    const EAN_8_CODE = "10000007"; // the live-proven salmon/beer regression code
    // QA HARDENING FIX #5: this fixture used to be "4006381333931" (a valid EAN-13 SHAPE) - but that
    // exact value is a classic GS1 textbook EXAMPLE barcode, now correctly rejected by the example/
    // test-row firewall regardless of the (real-looking) name/brand attached to it in this fixture.
    // Swapped to a genuinely ordinary EAN-13 (Nutella's real-world GTIN shape) so this test still
    // exercises "a normal EAN-13 settles at rung 0" without colliding with the new blocklist.
    const RETAIL_EAN_13 = "3017620422003"; // ordinary EAN-13 shape, not a GS1 example / not blocklisted

    function mockRetailHit(row: { productName: string; brand: string; category?: string }) {
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: row.productName,
        brand: row.brand,
        category: row.category ?? "",
        barcode: EAN_8_CODE,
      });
    }

    it("EAN-8 with a mocked retail row settles at the free rung as a suggestion, honest reason, goupc NEVER called", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key"; // configured but must never be spent
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      mockRetailHit({ productName: "Saumon fume Ecossais tranche main", brand: "Some Brand" });
      const goUpcSpy = fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("go-upc.com")) throw new Error("goupc must never be called for a retail-rung settle");
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", goUpcSpy);

      const outcome = await runDecodePipeline(makeReq(EAN_8_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.decision.status).not.toBe("verified");
      expect(outcome.payload.results[0]?.productName).toBe("Saumon fume Ecossais tranche main");
      expect(outcome.payload.reasonText || outcome.payload.decision.reason).toMatch(/retail product database/i);
      // Customer-safe wording: no internal rung/provider jargon leaked into the reason.
      expect(outcome.payload.decision.reason).not.toMatch(/turso|sqlite|rung/i);
      expect(goUpcSpy.mock.calls.some(([u]) => String(u).includes("go-upc.com"))).toBe(false);
      // Never charges the daily cap (a free rung-0 settle, like the tire corpus).
      expect(await readDailyUsed(await ladderStorage())).toBe(0);
    });

    it("EAN-13 in the retail corpus settles the same way (paid rungs never called)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Organic Whole Milk 1 Gallon",
        brand: "Some Dairy",
        category: "Dairy",
        barcode: RETAIL_EAN_13,
      });

      const outcome = await runDecodePipeline(makeReq(RETAIL_EAN_13));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.results[0]?.productName).toBe("Organic Whole Milk 1 Gallon");
      expect(outcome.payload.decision.reason).toMatch(/retail product database/i);
      expect(hitAnAiProvider()).toBe(false);
    });

    it("a retail row with a garbage name falls through (goupc reached), never settles garbage", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      // "Search For:10000007" is a barcode-site search-results title - isUsableProductName rejects it
      // (SITE_BLOCKLIST + code-echo check), exactly the garbage-name guard used everywhere else.
      mockRetailHit({ productName: "Search For:10000007", brand: "" });
      const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("go-upc.com")) return new Response("not found", { status: 404 }); // reached, genuine miss
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchStub);

      const outcome = await runDecodePipeline(makeReq(EAN_8_CODE));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // Never settled on the garbage retail name.
      expect(outcome.payload.results.some((r) => r.productName === "Search For:10000007")).toBe(false);
      // The ladder was actually reached (goupc rung ran, even though this EAN-8 has no valid GS1 check
      // digit so goupc itself is gated out by isValidCheckDigit - the point is the retail rung did NOT
      // short-circuit before the ladder).
      const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
      expect(Array.isArray(reasons)).toBe(true);
    });

    it("a non-GTIN code never calls the retail lookup at all", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const VENDOR_LABEL_CODE = "X001234567"; // vendor_label shape, not GTIN-shaped
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(getLearnedProduct).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(VENDOR_LABEL_CODE));

      expect(vi.mocked(lookupRetailBarcodeAsync)).not.toHaveBeenCalled();
    });

    // THE SALMON/BEER REGRESSION (live-proven): a paid rung self-reports "verified" for an identity
    // that CONTRADICTS a retail-corpus row for the exact same code. Previously nothing cross-checked a
    // paid "verified" against the retail corpus, so the wrong paid identity survived unchallenged all
    // the way to the customer. The contradiction guard must downgrade this to conflict/needs_review,
    // never verified.
    //
    // D6/Task 2 fixture update (2026-07-20): this suite originally used Go-UPC as its "paid-rung
    // verified" fixture. Go-UPC is now HONESTLY demoted to "suggested" (a raw paid-DB API self-report
    // can never be "verified" under the Resolver Trust Rules - see GoUpcProvider.ts), so it can no
    // longer produce the "verified" status this guard specifically gates on (pipeline.ts's contradiction
    // guard intentionally no longer sees Go-UPC at all - see the Step 3c audit comment at the guard
    // site). The guard itself is UNCHANGED and still must protect any paid rung that DOES genuinely
    // settle "verified" - Fetch V2 (app-verified exact-code evidence) is that rung today, so these tests
    // now mock `fetchV2` directly (the same pattern the "Task 21: learned-products tier write gate"
    // suite below already uses) instead of the Go-UPC HTTP fixture.
    describe("paid-verified contradiction guard", () => {
      const CONTRADICT_GTIN = "0900000012341"; // distinct fixture (valid EAN-13 check digit): own FetchV2Cache/GoUpcGate residue

      beforeEach(() => {
        // Clear the shared 30-day Go-UPC negative-miss cache (preserved from the pre-Task-2 version of
        // this suite). These tests no longer touch Go-UPC themselves (they mock fetchV2 instead), but
        // OTHER tests later in this file (e.g. "BUG #14"'s Go-UPC prefix-conflict settle, "QA round-3"'s
        // NORMAL-GTIN regression) reuse the shared VALID_GTIN fixture and depend on this file being
        // clean - the cache is keyed in a shared per-pid tmp dir, so leaving this cleanup in place (as
        // it was before) avoids reintroducing stale-miss cross-test pollution for those later suites.
        try { fs.unlinkSync(path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`, ".go-upc-miss-cache.json")); } catch {}
      });

      function stubFetchV2Verified(product: { name: string; brand: string }) {
        vi.mocked(fetchV2).mockResolvedValueOnce(
          makeResult({
            rawValue: CONTRADICT_GTIN,
            outcome: "verified",
            product: {
              brand: product.brand,
              name: product.name,
              model: "",
              partNumber: "",
              size: "",
              description: "",
              category: "",
              imageUrl: "",
            },
            evidence: {
              exactCodeFound: true,
              codeToProductProven: true,
              sourceQuality: "strong",
              sourceScore: 95,
              identityScore: 1,
              associationScore: 1,
              finalConfidence: 0.95,
              winningSourceUrl: "https://www.walmart.com/ip/contradiction-guard-fixture/1",
              winningSourceType: "strong_commercial",
              codeLocation: "json_ld.gtin",
              proofSummary: "exact code in a structured product record",
            },
            sourcesChecked: ["https://www.walmart.com/ip/contradiction-guard-fixture/1"],
          }),
        );
      }

      // E1 REFRAME (efficiency audit, 2026-07-20): under the single-retail-query model the salmon/beer
      // protection lands EARLIER and STRONGER than the downstream contradiction guard. The retail index is
      // deterministic: for one code it returns ONE row. If that row is a USABLE "Saumon fume" identity, the
      // rung-0 retail peek SETTLES it as a $0 "suggested" salmon and the paid ladder never runs at all - so
      // the wrong paid "Heineken verified" identity is never even produced, let alone shown to the customer.
      // (The old double-query test could only reach the contradiction guard by mocking rung-0 to MISS while
      // a SECOND call returned salmon - a scenario impossible against the real deterministic index, since
      // any row usable enough to trip the guard is also usable enough to settle rung 0. E1 removes that
      // second query; this test now asserts the real, stronger single-call protection.) The downstream
      // contradiction guard remains as defense-in-depth for the not-usable-row edge (asserted inert below).
      it("the salmon/beer regression is prevented at rung 0: a usable retail row settles as suggested, the paid 'verified' beer identity never runs", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
        // ONE deterministic retail row for this code (the SALMON identity), reused by both peeks via E1.
        vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
          productName: "Saumon fume Ecossais tranche main",
          brand: "Labeyrie",
          category: "Fish",
          barcode: CONTRADICT_GTIN,
        });
        // Fetch V2 (paid) WOULD self-report a contradicting beer if the ladder ran - it must NOT run.
        stubFetchV2Verified({ name: "Heineken Lager Beer 12-pack", brand: "Heineken" });
        stubFreeRungFetch({ upcHit: false });

        const outcome = await runDecodePipeline(makeReq(CONTRADICT_GTIN));

        expect(outcome.kind).toBe("computed");
        if (outcome.kind !== "computed") throw new Error("unreachable");
        // Never the wrong "Verified" beer - the retail row settled first as an honest suggestion.
        expect(outcome.payload.decision.status).not.toBe("verified");
        expect(outcome.payload.decision.status).toBe("suggested");
        expect(outcome.payload.results[0]?.productName).toBe("Saumon fume Ecossais tranche main");
        expect(outcome.payload.results.some((r) => /heineken/i.test(r.productName))).toBe(false);
        // The paid Fetch V2 mock was never consumed (rung-0 settled first).
        expect(vi.mocked(fetchV2)).not.toHaveBeenCalled();
        // Retail index queried exactly once (E1: no duplicate consensus re-query).
        expect(vi.mocked(lookupRetailBarcodeAsync).mock.calls.length).toBe(1);
      });

      it("a usable retail row settling at rung 0 is the SAME whether or not it agrees with any paid identity (paid ladder never runs)", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
        vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
          productName: "Continental TrueContact Tour 235/60R18",
          brand: "Continental",
          category: "Tire",
          barcode: CONTRADICT_GTIN,
        });
        stubFetchV2Verified({ name: "Continental TrueContact Tour 235/60R18", brand: "Continental" });
        stubFreeRungFetch({ upcHit: false });

        const outcome = await runDecodePipeline(makeReq(CONTRADICT_GTIN));

        expect(outcome.kind).toBe("computed");
        if (outcome.kind !== "computed") throw new Error("unreachable");
        // The usable retail row settles at rung 0 as a $0 suggestion; the paid ladder never runs.
        expect(outcome.payload.decision.status).toBe("suggested");
        expect(outcome.payload.results[0]?.productName).toBe("Continental TrueContact Tour 235/60R18");
        expect(vi.mocked(fetchV2)).not.toHaveBeenCalled();
        expect(vi.mocked(lookupRetailBarcodeAsync).mock.calls.length).toBe(1);
      });

      // REVIEW FINDING: the contradiction guard consumed `retailHit` WITHOUT the same isUsableProductName
      // gate the rung-0 settle (line ~528 above) already applies. A poisoned retail row can carry a
      // GARBAGE name (a barcode-site search-results title, a scrape error title, run-on junk over the
      // 120-char cap, etc.) alongside a plausible-but-wrong BRAND for the same GTIN. Reusing that garbage
      // name as `retailAsResult.productName` (unfiltered) can pass crossCheck's brand-mismatch check and
      // wrongly downgrade an otherwise-clean paid "verified" to needs_review/conflict - a recall-only risk,
      // but harmful in the tire-pilot core. The fix: the guard must ignore a retailHit whose productName
      // fails isUsableProductName, exactly like the rung-0 settle does.
      it("a paid-rung 'verified' is NOT downgraded when the retail row has a GARBAGE name (guard ignores it, isUsableProductName gate)", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
        // Run-on junk over isUsableProductName's 120-char cap, so it is rejected regardless of the
        // SITE_BLOCKLIST/PLACEHOLDER checks - a garbage name by length alone (fails isUsableProductName).
        const GARBAGE_NAME =
          "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkkkkkkk lllllllllll";
        // E1: ONE deterministic retail row. The GARBAGE name fails isUsableProductName, so the rung-0
        // retail peek does NOT settle it (the ladder runs, reaching the paid Fetch V2 verify), and the
        // SAME row is threaded to the contradiction guard, which must ALSO ignore it (isUsableProductName
        // gate) rather than let its plausible-but-wrong brand structurally downgrade a clean paid verify.
        vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
          // Plausible-but-WRONG brand for this GTIN (would structurally conflict with Continental if
          // the guard did not reject the garbage name first).
          productName: GARBAGE_NAME,
          brand: "Michelin",
          category: "Tire",
          barcode: CONTRADICT_GTIN,
        });
        stubFetchV2Verified({ name: "Continental TrueContact Tour 235/60R18", brand: "Continental" });
        stubFreeRungFetch({ upcHit: false });

        const outcome = await runDecodePipeline(makeReq(CONTRADICT_GTIN));

        expect(outcome.kind).toBe("computed");
        if (outcome.kind !== "computed") throw new Error("unreachable");
        // The guard must be INERT here: the paid verify passes through unchanged.
        expect(outcome.payload.decision.status).toBe("verified");
        expect(outcome.payload.results[0]?.productName).toBe("Continental TrueContact Tour 235/60R18");
      });
    });

    it("cap/billing: the retail rung-0 settle never calls checkAndIncrementDaily / charges the daily cap", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "1"; // tiny cap - would immediately reveal a charge
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      mockRetailHit({ productName: "Saumon fume Ecossais tranche main", brand: "Labeyrie" });

      const before = await readDailyUsed(await ladderStorage());
      const outcome = await runDecodePipeline(makeReq(EAN_8_CODE));
      const after = await readDailyUsed(await ladderStorage());

      expect(outcome.kind).toBe("computed");
      expect(after).toBe(before); // exactly unchanged - no charge on the free retail rung-0 path
    });
  });

  // QA HARDENING FIX #5 (live-proven bug): scanning textbook GS1 EXAMPLE barcodes returned a CONFIDENT
  // "Matched in the retail product database" for FAKE demo/test products ingested verbatim from the
  // crowdsourced Open Food Facts dump - 4006381333931 -> "Test Shopidoo", 0012345670121 -> brand
  // "Healthyholics". Wrong identity is a failure; Unidentified is acceptable. The retail rung-0 settle
  // (~line 528) must reject an example/test row and fall through to an honest no-match, while a NORMAL
  // retail row must still settle exactly as before (regression protection).
  describe("QA fix #5: retail rung-0 rejects example/test rows (wrong-identity firewall)", () => {
    const EXAMPLE_EAN_13 = "4006381333931"; // classic GS1 textbook example, live-proven "Test Shopidoo"
    const HEALTHYHOLICS_GTIN = "0012345670121"; // documented Healthyholics example GTIN
    const NORMAL_EAN_13 = "3017620422003"; // ordinary GTIN-shaped code, not on any blocklist

    it("an example-barcode retail row (4006381333931 / Test Shopidoo) does NOT settle at rung 0 as a match", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Test Shopidoo",
        brand: "",
        category: "",
        barcode: EXAMPLE_EAN_13,
      });
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(EXAMPLE_EAN_13));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // Never the fake identity, on ANY path (rung-0 settle or otherwise).
      expect(outcome.payload.results.some((r) => r.productName === "Test Shopidoo")).toBe(false);
      expect(outcome.payload.decision.reason).not.toMatch(/test shopidoo/i);
      // TOP-LEVEL LAW: the code still appears + counts as Unidentified - never silently dropped.
      expect(outcome.payload.decision.status).not.toBe("verified");
    });

    it("a Healthyholics example-GTIN retail row (0012345670121) does NOT settle at rung 0 as a match", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Multivitamin Gummies",
        brand: "Healthyholics",
        category: "Supplements",
        barcode: HEALTHYHOLICS_GTIN,
      });
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(HEALTHYHOLICS_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // The poisoned retail-corpus row must never settle as the RETAIL match (this task's actual scope:
      // isUsableProductName / rung-0 / retailKnowledgeIndex / build script). A SEPARATE mechanism
      // (prefixFloorName, driven by a different generated GS1-prefix->brand catalog, out of scope for
      // this fix) may still honestly label an unresolved scan "Healthyholics / product unconfirmed" -
      // that is explicitly documented as a naming aid that is NEVER marked verified, i.e. exactly the
      // acceptable "Unidentified" behavior the top-level law asks for. Assert the RETAIL claim never
      // fires and the result is never confidently verified - not that the brand string never appears.
      expect(outcome.payload.decision.reason).not.toMatch(/matched in the retail product database/i);
      expect(outcome.payload.results.some((r) => r.confidence >= 0.8 && r.brand === "Healthyholics")).toBe(false);
      expect(outcome.payload.decision.status).not.toBe("verified");
    });

    it("the rejected-example reason stays HONEST (never leaks the blocklist / 'test row' INTERNAL reasoning)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Test Shopidoo",
        brand: "",
        category: "",
        barcode: EXAMPLE_EAN_13,
      });
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(EXAMPLE_EAN_13));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // QA ROUND-3 #5 (owner-ratified reason): the example-gate now surfaces an explicit customer-safe
      // sentence ("This looks like an example or test barcode, not a real product. Enter the item
      // manually if needed.") - the plain words "example"/"test barcode" in a customer sentence are
      // honest, NOT a leak. The anti-leak gate here now forbids only the INTERNAL mechanism tokens
      // (blocklist, "test row", demo, the fake product name) - never the customer-facing phrasing.
      expect(outcome.payload.decision.reason).not.toMatch(/blocklist|test.?row|demo|test shopidoo/i);
    });

    it("REGRESSION: a NORMAL retail row (not example/test) still settles at rung 0 exactly as before", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Organic Whole Milk 1 Gallon",
        brand: "Some Dairy",
        category: "Dairy",
        barcode: NORMAL_EAN_13,
      });

      const outcome = await runDecodePipeline(makeReq(NORMAL_EAN_13));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.results[0]?.productName).toBe("Organic Whole Milk 1 Gallon");
      expect(outcome.payload.decision.reason).toMatch(/retail product database/i);
      expect(hitAnAiProvider()).toBe(false);
    });
  });

  // QA HARDENING FIX #6 (live-proven, 2026-07-16, companion to fix #5 above): a GTIN-shaped code whose
  // GS1 check digit FAILS is a likely scanner misread (src/services/upc/misread.ts). Both
  // resolveExactBarcode (tire corpus) and the retail rung-0 peek key off zero-pad barcode VARIANTS with
  // no check-digit awareness, so a bad-check-digit code can coincidentally string-match a seeded
  // corpus/retail row and settle a CONFIDENT wrong identity even when the row itself is a perfectly
  // normal, non-example product name (unlike fix #5, which targets a KNOWN example/test row by exact
  // value or name regardless of check digit). Wrong identity is failure; unknown is acceptable - a
  // misread code must fall through honestly to the rest of the pipeline, never settle rung-0.
  describe("QA fix #6: corpus/retail rungs skip misread (bad-check-digit) GTINs", () => {
    const MISREAD_GTIN = "012345678900"; // GTIN-shaped, GS1 check digit FAILS (live-proven root cause code)
    const VALID_GTIN = "3017620422003"; // ordinary GTIN-shaped code, valid check digit, not on any blocklist

    function makeMisreadCorpusHit(): CorpusDecodeResult {
      return {
        decision: {
          status: "verified",
          confidence: 0.97,
          reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          crossCheck: { decision: "single_provider", confidence: 0.97, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
          corroborationPath: "corpus_exact_barcode",
        },
        results: [{ productName: "Definitely Real Tire 235/60R18", brand: "RealBrand", category: "Tire", specsShort: "235/60R18", confidence: 0.97, needsHumanReview: false, sourceUrls: [], verifiedFacts: [], primaryBarcode: MISREAD_GTIN } as unknown as CorpusDecodeResult["results"][number]],
        evidences: [{ verified: true, strength: "fetched_source", matchedCode: MISREAD_GTIN, matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." }],
        providerNames: ["tire-corpus"],
        path: "corpus_exact_barcode",
      };
    }

    it("a misread GTIN with a seeded tire-corpus hit does NOT settle at the corpus rung - falls through honestly", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      // The corpus WOULD have a confident hit on this exact code (simulating a coincidental zero-pad-
      // variant collision) - the misread gate must prevent it from ever being consulted/settling.
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(makeMisreadCorpusHit());
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(MISREAD_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.results.some((r) => r.productName === "Definitely Real Tire 235/60R18")).toBe(false);
      expect(outcome.payload.decision.reason).not.toMatch(/definitely real tire/i);
      expect(outcome.payload.decision.status).not.toBe("verified");
      // resolveExactBarcode itself is never even called for a misread code (behavioral proof, not just
      // an outcome check) - the gate skips the call entirely rather than calling it and discarding.
      expect(resolveExactBarcode).not.toHaveBeenCalled();
    });

    it("a misread GTIN with a seeded retail-corpus hit does NOT settle at rung 0 - falls through honestly", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Definitely Real Grocery Item",
        brand: "RealBrand",
        category: "Grocery",
        barcode: MISREAD_GTIN,
      });
      stubFreeRungFetch({ upcHit: false });

      const outcome = await runDecodePipeline(makeReq(MISREAD_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.results.some((r) => r.productName === "Definitely Real Grocery Item")).toBe(false);
      expect(outcome.payload.decision.reason).not.toMatch(/matched in the retail product database/i);
      expect(outcome.payload.decision.status).not.toBe("verified");
      // lookupRetailBarcodeAsync itself is never even called for a misread code at rung 0.
      expect(lookupRetailBarcodeAsync).not.toHaveBeenCalled();
    });

    it("REGRESSION: a VALID GTIN with a seeded tire-corpus hit still settles verified exactly as before", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const validHit: CorpusDecodeResult = {
        ...makeMisreadCorpusHit(),
        results: [{ ...makeMisreadCorpusHit().results[0], productName: "Michelin Defender T+H 235/60R18", primaryBarcode: VALID_GTIN }] as unknown as CorpusDecodeResult["results"],
        evidences: [{ verified: true, strength: "fetched_source", matchedCode: VALID_GTIN, matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." }],
      };
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(validHit);

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("verified");
      expect(outcome.payload.results[0]?.productName).toBe("Michelin Defender T+H 235/60R18");
      expect(resolveExactBarcode).toHaveBeenCalledWith(VALID_GTIN);
    });

    it("REGRESSION: a VALID GTIN retail row still settles at rung 0 exactly as before (composes with fix #5)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(lookupRetailBarcodeAsync).mockResolvedValue({
        productName: "Organic Whole Milk 1 Gallon",
        brand: "Some Dairy",
        category: "Dairy",
        barcode: VALID_GTIN,
      });

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.decision.status).toBe("suggested");
      expect(outcome.payload.results[0]?.productName).toBe("Organic Whole Milk 1 Gallon");
      expect(lookupRetailBarcodeAsync).toHaveBeenCalledWith(VALID_GTIN);
    });

    it("REGRESSION: an alpha_sku code (never GTIN-shaped) still reaches resolveExactPartNumber - misread gate never touches it", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const ALPHA_SKU = "t432119"; // never GTIN-shaped -> isLikelyMisreadGtin is always false for it
      vi.mocked(resolveExactBarcode).mockResolvedValueOnce(null);
      vi.mocked(resolveExactPartNumber).mockResolvedValueOnce(null);
      stubFreeRungFetch({ upcHit: false });

      await runDecodePipeline(makeReq(ALPHA_SKU));

      expect(resolveExactPartNumber).toHaveBeenCalledWith(ALPHA_SKU);
    });
  });

  // BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): reasonText and decision.reason are
  // CUSTOMER-facing (they flow to needsReviewQueue[].reason / scanFeed[].reason and render verbatim on
  // the UI). They must never leak raw vendor/service/model names or internal skip-reason codes. Raw
  // values are allowed ONLY inside debug.* (platform-only, never rendered to a customer).
  describe("BUG #14: customer-facing reasonText/decision.reason never leak raw vendor/model names", () => {
    const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

    it("all-miss ladder: customer-facing reasonText and decision.reason are clean and non-empty (debug.ladderReasons keeps the raw chain)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const outcome = await runDecodePipeline(makeReq("111000222333"));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.reasonText)).toBe(false);
      expect(outcome.payload.decision.reason.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.decision.reason)).toBe(false);
      // debug.ladderReasons is platform-only and MUST still carry the raw per-rung chain for diagnosis.
      const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
      expect(Array.isArray(reasons)).toBe(true);
      expect((reasons ?? []).some((r) => r.rung === "fetchv2")).toBe(true);
    }, 30000);

    it("free-rung settle (UPCitemdb hit): the raw provider name in the rung's own reason never reaches customer-facing reasonText/decision.reason", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      stubFreeRungFetch({ upcHit: true });

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      expect(outcome.payload.providerNames).toContain("upcitemdb"); // provider name IS allowed as structured metadata
      expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.reasonText)).toBe(false);
      expect(outcome.payload.decision.reason.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.decision.reason)).toBe(false);
    });

    it("Go-UPC prefix-conflict settle: the raw 'Go-UPC brand ... conflicts with prefix owner' reason is sanitized to an honest customer-facing string", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-go-upc-key";
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("go-upc.com/api")) {
          return new Response(
            JSON.stringify({ code: "OK", product: { name: "Some Unrelated Brand Widget", brand: "UnrelatedBrand", barcode: VALID_GTIN } }),
            { status: 200 },
          );
        }
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // Prove this actually exercised the Go-UPC settle (not a coincidental pass via some other path).
      expect(outcome.payload.providerNames).toContain("go-upc");
      expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.reasonText)).toBe(false);
      expect(outcome.payload.decision.reason.length).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(outcome.payload.decision.reason)).toBe(false);
    });
  });

  // QA ROUND-3 #5 (live-proven bypass on 1bfa6fe): the FREE rung-0 guards (round-1) and the L2 cache
  // re-validation (round-2) correctly reject example/test barcodes, but a code with a VALID GS1 check
  // digit that is nonetheless a documentation/example GTIN (4006381333931 / 5901234123457 /
  // 012345678905, all on EXAMPLE_BARCODE_BLOCKLIST) still ESCALATED to the LIVE PAID Go-UPC rung, which
  // returns verified-strength junk for these textbook codes ("Stabilo"/"Renault"/"Castrol") and the app
  // auto-counted it. FIX: a PRE-PAID-RUNG gate stops the ladder before any paid rung runs for a known
  // example/test code, settling an honest no-identity needs_review (never verified/suggested), saving
  // the paid call too. The code STILL appears + counts as Unidentified (TOP-LEVEL LAW).
  describe("QA round-3 #5: example/test barcodes never reach a paid rung or settle verified", () => {
    // Local denylist copy (the BUG #14 describe's DENYLIST_RE is scoped to that block): the honest
    // example-gate reason must never leak an internal rung/provider/skip-code token.
    const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;
    const GOUPC_API = "go-upc.com/api";
    // The 3 live-proven example codes. All have VALID GS1 check digits (so the round-2 misread guard
    // does NOT catch them - this gate is what does), and all are on EXAMPLE_BARCODE_BLOCKLIST.
    const EXAMPLE_CODES = ["4006381333931", "5901234123457", "012345678905"] as const;

    // A fetch stub that WOULD return a verified Go-UPC identity if the paid rung ever ran, plus a
    // verified UPCitemdb / Open Food Facts hit - so if ANY provider is consulted for an example code
    // the test would see a fabricated identity or a paid host call. The gate must make sure it doesn't.
    function stubEverythingWouldVerify(code: string) {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("go-upc.com")) {
          return new Response(
            JSON.stringify({ inferred: false, product: { name: "Fabricated Example Product", brand: "FabricatedBrand", category: "Misc", barcode: code, specs: [] } }),
            { status: 200 },
          );
        }
        if (url.includes(UPCITEMDB_HOST)) {
          return new Response(JSON.stringify({ code: "OK", items: [{ title: "Fabricated Example Product", brand: "FabricatedBrand", category: "Misc" }] }), { status: 200 });
        }
        if (url.includes(OFF_HOST)) {
          return new Response(JSON.stringify({ status: 1, product: { product_name: "Fabricated Example Product", brands: "FabricatedBrand" } }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    const paidGoUpcCalls = () => fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(GOUPC_API));

    for (const code of EXAMPLE_CODES) {
      it(`${code}: the paid Go-UPC rung is NEVER called and the decode never settles verified/suggested`, async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the pre-gate, not a block
        process.env.GO_UPC_API_KEY = "test-key"; // Go-UPC is genuinely payable - the gate must still stop it
        process.env.OPENAI_API_KEY = "test-key"; // GPT rung genuinely runnable too - must also be gated out
        stubEverythingWouldVerify(code);

        const outcome = await runDecodePipeline(makeReq(code));

        expect(outcome.kind).toBe("computed");
        if (outcome.kind !== "computed") throw new Error("unreachable");
        // The PAID Go-UPC API endpoint was NEVER contacted for an example code.
        expect(paidGoUpcCalls()).toHaveLength(0);
        // No paid AI provider host was contacted at all.
        expect(hitAnAiProvider()).toBe(false);
        // The decode never settles verified OR suggested - it is an honest no-identity needs_review.
        expect(outcome.payload.decision.status).not.toBe("verified");
        expect(outcome.payload.decision.status).not.toBe("suggested");
        // No fabricated identity leaked into the results.
        expect(JSON.stringify(outcome.payload.results)).not.toMatch(/Fabricated|FabricatedBrand/i);
        // An honest, non-empty, customer-safe reason is set (no internal rung/denylist tokens; #14 intact).
        expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
        expect(outcome.payload.reasonText).not.toMatch(/fetchv2|gpt-5\.5|goupc|upcitemdb|openfoodfacts/i);
        expect(DENYLIST_RE.test(outcome.payload.reasonText)).toBe(false);
        expect(outcome.payload.decision.reason.length).toBeGreaterThan(0);
        expect(DENYLIST_RE.test(outcome.payload.decision.reason)).toBe(false);
      }, 30000);
    }

    it("TOP-LEVEL LAW: an example code still produces a COUNTABLE Unidentified row (appears + counts)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubEverythingWouldVerify("4006381333931");

      const outcome = await runDecodePipeline(makeReq("4006381333931"));
      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // The pipeline returns a settled decode payload (mode "decode") the client renders + counts as an
      // Unidentified row - it is NOT a cap block, NOT a persisted receipt, NOT a thrown error.
      expect(outcome.payload.mode).toBe("decode");
      expect(outcome.payload.decision.status).not.toBe("verified");
    }, 30000);

    it("DEFENSE-IN-DEPTH: a paid-rung result whose decoded NAME is a test/sample product is not settled verified (code not on blocklist, so the pre-gate misses it)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      // VALID_GTIN is NOT on EXAMPLE_BARCODE_BLOCKLIST, so the pre-paid-rung gate does NOT fire and the
      // code genuinely reaches the paid Go-UPC rung. Go-UPC returns a VERIFIED-strength result whose
      // NAME contains a whole-word test/sample marker ("sample product") - isExampleOrTestRow(code,
      // name, brand) is true on the identity even though it is false on the code alone. The
      // defense-in-depth guard at the paid-rung settle must downgrade it out of verified/suggested.
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes("go-upc.com")) {
          return new Response(
            JSON.stringify({ inferred: false, product: { name: "Acme Sample Product 12oz", brand: "Acme", category: "Misc", barcode: VALID_GTIN, specs: [] } }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      // The pre-gate did NOT fire (code is not blocklisted) - the paid Go-UPC rung genuinely ran...
      const rungs = (outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined ?? []).map((r) => r.rung);
      expect(rungs).toContain("goupc");
      // ...but the defense-in-depth guard downgraded the test-named identity out of verified/suggested.
      expect(outcome.payload.decision.status).not.toBe("verified");
      expect(outcome.payload.decision.status).not.toBe("suggested");
      expect(JSON.stringify(outcome.payload.results)).not.toMatch(/Sample Product/i);
      expect(outcome.payload.reasonText.length).toBeGreaterThan(0);
    }, 30000);

    it("REGRESSION: a NORMAL valid corpus-miss GTIN STILL runs the paid Go-UPC rung (gate only affects example codes)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      // VALID_GTIN "900000000003" is a real-shaped, valid-check-digit, non-example code absent from every
      // fixture, so it misses the free corpus/retail/learned peeks and reaches the paid ladder as before.
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 }); // genuine miss, but the CALL happened
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      if (outcome.kind !== "computed") throw new Error("unreachable");
      const rungs = (outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined ?? []).map((r) => r.rung);
      // The paid Go-UPC rung genuinely RAN for a normal code (proving the gate did not over-fire).
      expect(rungs).toContain("goupc");
      expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(GOUPC_API)).length).toBeGreaterThan(0);
    }, 30000);
  });

  describe("Gemini Pro review fix 2: GPT ladder spend+call recording never diverges on a partial throw", () => {
    const GOUPC_API = "go-upc.com/api";
    const UPCITEMDB_HOST = "api.upcitemdb.com";
    const OFF_HOST = "world.openfoodfacts.org";

    // Every free/earlier rung misses so the code genuinely reaches the paid GPT-5.5 rung, and OpenAI
    // itself returns a real answer - proving recordGptLadderSpend/recordGptLadderCall's call site
    // (pipeline.ts ~line 751-760) actually executes for a genuine paid GPT call.
    function stubAllMissExceptGpt() {
      fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 });
        if (url.includes("api.openai.com/v1/responses")) {
          const body = {
            output: [{
              type: "message",
              content: [{
                type: "output_text",
                text: JSON.stringify({
                  brand: "Acme", productName: "Acme Widget", specs: "", gtin: "",
                  confidence: 0.55, exactCodeFound: false, basis: "best guess",
                  sourceUrls: [],
                }),
              }],
            }],
            usage: { input_tokens: 200, output_tokens: 100 },
          };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
    }

    it("records both spend and call for a genuine GPT rung call (baseline sanity)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      stubAllMissExceptGpt();

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      expect(recordGptLadderSpend).toHaveBeenCalledTimes(1);
      expect(recordGptLadderCall).toHaveBeenCalledTimes(1);
    }, 30000);

    // FAILING-FIRST for the fix: before the fix, recordGptLadderSpend and recordGptLadderCall ran as
    // two sequential `await`s - if the first threw, the second (recordGptLadderCall) was skipped
    // entirely, silently diverging the spend-vs-call-count counters. The fix wraps both in
    // Promise.allSettled so one failing never skips the other.
    it("still records the call count even when recordGptLadderSpend rejects", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      stubAllMissExceptGpt();
      vi.mocked(recordGptLadderSpend).mockRejectedValueOnce(new Error("simulated spend-record failure"));

      const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(outcome.kind).toBe("computed");
      expect(recordGptLadderSpend).toHaveBeenCalledTimes(1);
      // The whole point of the fix: recordGptLadderCall must still fire even though the spend record
      // rejected. Pre-fix, the sequential `await recordGptLadderSpend(...)` throwing would skip this
      // entirely (0 calls); post-fix it always runs.
      expect(recordGptLadderCall).toHaveBeenCalledTimes(1);
    }, 30000);
  });

  // wave-3 (2026-07-20 owner-ratified): realistic per-rung ladder budgets + money preflight + GPT
  // signal threading + ORDER v3 escalation past a free suggestion via fetchv2/gpt.
  describe("wave-3: realistic per-rung budgets + money preflight (2026-07-20 owner-ratified)", () => {
    const GOUPC_API = "go-upc.com/api";

    it("DECODE_LADDER_TOTAL_MS default is 90000ms (raised from 15000): a fetchv2 rung with no env override is never deadline-skipped even though it can take up to ~27s", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      // No DECODE_LADDER_TOTAL_MS override - proves the new 90s default actually applies. All rungs
      // miss quickly (stubbed fetch), so this only proves the deadline itself is generous, not that a
      // slow call survives (that is proven by the budgetMs tests below).
      const out = await runDecodePipeline(makeReq(VALID_GTIN));
      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      const reasons = (out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
      // None of the rungs were skipped for "ladder deadline reached" - the old 15s default with even a
      // handful of quick misses could plausibly starve later rungs; the new 90s default never does.
      expect(reasons.some((r) => r.reason.includes("ladder deadline reached"))).toBe(false);
      expect(reasons.map((r) => r.rung)).toContain("gpt");
    });

    it("preflight skips fetchv2 with the exact reason text when DECODE_LADDER_TOTAL_MS leaves under 10s", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.DECODE_LADDER_TOTAL_MS = "5000"; // total deadline is only 5s - under FETCHV2_MIN_VIABLE_MS (10s)
      const out = await runDecodePipeline(makeReq(VALID_GTIN));
      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      const reasons = (out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
      const fetchv2Skip = reasons.find((r) => r.rung === "fetchv2" && r.reason.includes("insufficient time budget left"));
      expect(fetchv2Skip?.reason).toBe("skipped: insufficient time budget left (needed >=10s)");
    });

    it("preflight skips gpt with the exact reason text when DECODE_LADDER_TOTAL_MS leaves under 20s", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.OPENAI_API_KEY = "test-key"; // gpt must be genuinely capable of running to prove the TIME gate (not the key gate) is what skips it
      process.env.DECODE_LADDER_TOTAL_MS = "15000"; // 15s total: clears fetchv2's 10s minimum, not gpt's 20s minimum
      const out = await runDecodePipeline(makeReq(VALID_GTIN));
      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      const reasons = (out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
      const gptSkip = reasons.find((r) => r.rung === "gpt" && r.reason.includes("insufficient time budget left"));
      expect(gptSkip?.reason).toBe("skipped: insufficient time budget left (needed >=20s)");
    });

    it("skip-before-charge ordering: a GPT rung skipped for insufficient time NEVER calls chargeDailySlot / bills anything", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.OPENAI_API_KEY = "test-key";
      process.env.GO_UPC_API_KEY = "test-key";
      process.env.DECODE_LADDER_TOTAL_MS = "15000"; // clears goupc + fetchv2, not gpt's 20s minimum
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      // GPT's run() closure (shouldRunGptRung -> gptFromScratch) never executed: no OpenAI call, no
      // spend/call record.
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com"))).toBe(false);
      expect(recordGptLadderSpend).not.toHaveBeenCalled();
      expect(recordGptLadderCall).not.toHaveBeenCalled();
      const reasons = (out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
      expect(reasons.some((r) => r.rung === "gpt" && r.reason.includes("insufficient time budget left"))).toBe(true);
    });

    describe("Item D: fetchv2/gpt may upgrade a free suggestion (ORDER v3 extension)", () => {
      function stubFreeSuggestionThenPaid(opts: { fetchv2Confidence?: "high" | "low" | "none"; goupcMiss?: boolean }) {
        fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes(UPCITEMDB_HOST)) {
            return new Response(
              JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
              { status: 200 },
            );
          }
          if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
          if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 }); // goupc genuine miss (never wins)
          if (opts.fetchv2Confidence && opts.fetchv2Confidence !== "none" && url.includes("brocade")) {
            // brocade structured door is exercised via the fetchV2 module mock below instead.
          }
          return new Response("not found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchSpy);
      }

      it("a higher-confidence fetchv2 suggestion REPLACES the free suggestion", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        process.env.GO_UPC_API_KEY = "test-key";
        process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // makes fetchV2CanPay true
        stubFreeSuggestionThenPaid({ goupcMiss: true });
        // UPCitemdb's free suggestion confidence is fixed by upcItemDbRung (0.55 - see UpcItemDbProvider);
        // stub fetchV2 directly to return a clean "verified" result WITH the required confidence >= free.
        vi.mocked(fetchV2).mockResolvedValueOnce(
          makeResult({
            rawValue: VALID_GTIN,
            outcome: "verified",
            product: {
              brand: "Continental",
              name: "Continental TrueContact Tour",
              model: "TrueContact Tour",
              partNumber: "",
              size: "235/60R18",
              description: "",
              category: "tire",
              imageUrl: "",
            },
            evidence: {
              exactCodeFound: true,
              codeToProductProven: true,
              sourceQuality: "strong",
              sourceScore: 95,
              identityScore: 1,
              associationScore: 1,
              finalConfidence: 0.95,
              winningSourceUrl: "https://tirerack.com/x",
              winningSourceType: "strong_commercial",
              codeLocation: "json_ld.gtin",
              proofSummary: "exact code in a structured product record",
            },
            sourcesChecked: ["https://tirerack.com/x"],
          }),
        );

        const out = await runDecodePipeline(makeReq(VALID_GTIN));

        expect(out.kind).toBe("computed");
        if (out.kind !== "computed") throw new Error("unreachable");
        expect(out.payload.providerNames).toContain("fetchv2");
        expect(out.payload.results[0]?.brand).toBe("Continental");
        expect(out.payload.decision.status).toBe("verified");
      });

      it("a LOWER/equal-confidence gpt suggestion does NOT replace the free suggestion (free suggestion stands)", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        process.env.GO_UPC_API_KEY = "test-key";
        process.env.OPENAI_API_KEY = "test-key";
        stubFreeSuggestionThenPaid({ goupcMiss: true });
        fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes(UPCITEMDB_HOST)) {
            return new Response(
              JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
              { status: 200 },
            );
          }
          if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
          if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 });
          if (url.includes("api.openai.com/v1/responses")) {
            const body = {
              output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
                brand: "Acme", productName: "Acme Widget", category: "Tire", specs: "", gtin: "",
                confidence: 0.3, exactCodeFound: false, basis: "weak guess", sourceUrls: [],
              }) }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response("not found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchSpy);

        const out = await runDecodePipeline(makeReq(VALID_GTIN));

        expect(out.kind).toBe("computed");
        if (out.kind !== "computed") throw new Error("unreachable");
        // The free UPCitemdb suggestion (Falken) stands - GPT's weak 0.3 guess never beats it.
        expect(out.payload.providerNames).toContain("upcitemdb");
        expect(out.payload.results[0]?.brand).toBe("Falken");
      });

      it("non_public_code_type still blocks gpt from running in this escalation path (vendor-label code)", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        process.env.OPENAI_API_KEY = "test-key";
        // A vendor-label (ASIN) code never reaches the free-suggestion escalation branch since
        // buildFreeLadderRungs returns [] for non-GTINs (no goupc either) - so this proves the
        // non_public_code_type gate via the TOTAL-MISS path instead, which shares the identical
        // shouldRunGptRung gating this task's escalation path reuses.
        const ASIN = "B09XYZ7DEF";
        const out = await runDecodePipeline(makeReq(ASIN));
        expect(out.kind).toBe("computed");
        if (out.kind !== "computed") throw new Error("unreachable");
        expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com"))).toBe(false);
        const reasons = (out.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined) ?? [];
        expect(reasons.some((r) => r.rung === "gpt" && r.reason.includes("non_public_code_type"))).toBe(true);
      });

      it("pay-once: multi-rung escalation (goupc miss -> fetchv2 miss -> gpt runs) charges the cap exactly once per genuinely-run paid rung, never twice for one logical request", async () => {
        process.env.AI_LOOKUP_DAILY_LIMIT = "100";
        process.env.GO_UPC_API_KEY = "test-key";
        process.env.OPENAI_API_KEY = "test-key";
        stubFreeSuggestionThenPaid({ goupcMiss: true });
        fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes(UPCITEMDB_HOST)) {
            return new Response(
              JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
              { status: 200 },
            );
          }
          if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
          if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 });
          if (url.includes("api.openai.com/v1/responses")) {
            const body = {
              output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
                brand: "Acme", productName: "Acme Widget", category: "Tire", specs: "", gtin: "",
                confidence: 0.3, exactCodeFound: false, basis: "weak guess", sourceUrls: [],
              }) }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response("not found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchSpy);

        await runDecodePipeline(makeReq(VALID_GTIN));

        // Two genuinely-run paid rungs (goupc + gpt; fetchv2 has no discovery keys so paidWorkPossible's
        // fetchV2CanPay is false and it never even attempts a charge) -> exactly 2 charges, never more.
        expect(await readDailyUsed(await ladderStorage())).toBe(2);
      });
    });

    it("signal propagation: the ladder's AbortSignal reaches gptFromScratch's OpenAI fetch call (ctx.signal threaded through maybeGptLadder)", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.OPENAI_API_KEY = "test-key";
      let openAiSignal: AbortSignal | undefined;
      fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(UPCITEMDB_HOST)) return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 });
        if (url.includes(OFF_HOST)) return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        if (url.includes(GOUPC_API)) return new Response("not found", { status: 404 });
        if (url.includes("api.openai.com/v1/responses")) {
          openAiSignal = init?.signal ?? undefined;
          // Never resolves on its own - only the ladder's own abort (or the test's manual check below)
          // ends this promise. Proves the OpenAI call genuinely received a signal it can act on.
          return new Promise<Response>(() => {});
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      // A tiny ladder deadline forces the ladder to give up waiting on GPT quickly - but GPT's own
      // 20s preflight minimum must still be clearable for the rung to actually START (so the signal
      // gets threaded in the first place). Use a deadline just above GPT_MIN_VIABLE_MS (20s) so the
      // rung starts, then races the ladder's own abort.
      process.env.DECODE_LADDER_TOTAL_MS = "21000";

      const p = runDecodePipeline(makeReq(VALID_GTIN));
      // Give the synchronous/microtask chain a moment to reach the GPT rung and register the fetch call.
      await new Promise((r) => setTimeout(r, 50));
      expect(openAiSignal, "the OpenAI fetch call must have received a signal object").toBeTruthy();
      expect(openAiSignal?.aborted).toBe(false);

      await p; // let the ladder's own deadline abort resolve the hanging promise's race and settle
      // The ladder gave up waiting at its deadline - the signal threaded into the OpenAI call must now
      // show aborted, proving the abort actually propagated into the fetch call (not just a local
      // ladder-side give-up that leaves the real HTTP call running unaborted server-side).
      expect(openAiSignal?.aborted).toBe(true);
    }, 30000);
  });
});
