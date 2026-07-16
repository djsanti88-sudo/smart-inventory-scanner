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
}));
vi.mock("@/server/learnedProducts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/learnedProducts")>();
  realLearned.getLearnedProduct = actual.getLearnedProduct;
  realLearned.upsertLearnedProduct = actual.upsertLearnedProduct;
  return { ...actual, getLearnedProduct: vi.fn(actual.getLearnedProduct), upsertLearnedProduct: vi.fn(actual.upsertLearnedProduct) };
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

import { runDecodePipeline, DailyCapExceededError, classifySourceTier } from "@/server/decode/pipeline";
import { detectCodeType } from "@/services/codeTypeDetector";
import { __resetForTest, readDailyUsed } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import * as decodeCacheModule from "@/services/ai/decodeCache";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest, getPersistedDecode, type PersistedDecode } from "@/server/decodeCacheStore";
import { resolveExactBarcode, resolveExactPartNumber, type CorpusDecodeResult } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { resolveUnknownFast } from "@/services/ai/parallelResolve";
import { getLearnedProduct, upsertLearnedProduct, __resetLearnedProductsForTest, type LearnedProductRow } from "@/server/learnedProducts";
import { fetchV2 } from "@/services/fetchV2/index";
import { makeResult } from "@/services/fetchV2/types";

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
  const keys = ["IS_E2E", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "GO_UPC_API_KEY", "BRAVE_SEARCH_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE", "LEARNED_PRODUCTS_FILE"];
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
  const FLOORED_GTIN = "5603344000017";

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
    // Decision stays needs_review (never verified) and the reason keeps the full all-miss chain.
    expect(outcome.payload.decision.status).not.toBe("verified");
    expect(outcome.payload.reasonText).toMatch(/No rung resolved the code/);
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
  });

  it("Z3: two encodings of one product share one cache identity (canonical GTIN cache key)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the shared key, not the block
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

    it("ESCALATION: a free suggestion continues to Go-UPC; a Go-UPC verified exact WINS", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: true });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      expect(out.payload.decision.status).toBe("verified");
      expect(out.payload.providerNames).toContain("go-upc");
      // The escalation ran Go-UPC only; fetchv2/gpt were NEVER reached.
      const rungs = ladderRungsOf(out);
      expect(rungs).not.toContain("fetchv2");
      expect(rungs).not.toContain("gpt");
    });

    it("ESCALATION: a Go-UPC miss falls back to the stashed free suggestion; fetchv2/gpt NEVER run", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-key";
      stubUpcSuggestionThenGoupc({ goupcVerified: false });

      const out = await runDecodePipeline(makeReq(VALID_GTIN));

      expect(out.kind).toBe("computed");
      if (out.kind !== "computed") throw new Error("unreachable");
      // The stashed free suggestion is the final answer (its provider name survives in the payload).
      expect(out.payload.providerNames).toContain("upcitemdb");
      // fetchv2/gpt must never run past a free suggestion.
      const rungs = ladderRungsOf(out);
      expect(rungs).not.toContain("fetchv2");
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
  // fetch call inspection) because Plan D's own retail peek (lookupBarcodeDb, pipeline.ts:852) and the
  // AM-7 keyless fetchv2 pattern-URL door (barcodeSources.ts's "upcitemdb.com" web-page entry) both
  // legitimately reach upcitemdb-family hosts for unrelated reasons - only the ladder's own reasons
  // chain unambiguously proves whether the STEERED rungs (upcitemdb/openfoodfacts) ran.
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
});
