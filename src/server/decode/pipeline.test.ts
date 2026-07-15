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

// Thin unit tests for the extracted decode pipeline (Task 2.4). They run with NO API keys and a fully
// STUBBED global.fetch, so NO live provider call and NO real network can occur - every rung either
// skips (no key) or misses. These prove the two invariants the route relied on and that must survive
// the extraction: (1) an all-miss ladder returns an unresolved payload whose reason chain names every
// rung that came back empty (owner: never silent); (2) a cap-exhausted request is blocked from the
// paid ladder with an honest cap reason.

const AI_PROVIDER_HOSTS = ["generativelanguage.googleapis.com", "api.openai.com", "go-upc.com", "firecrawl.dev"];

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

describe("runDecodePipeline (extracted decode pipeline; no live AI)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["IS_E2E", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "GO_UPC_API_KEY", "BRAVE_SEARCH_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE"];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Task 6: restore the pass-through implementations so each test starts from real behavior; a test
    // that wants a synthetic corpus hit / persisted receipt uses mockResolvedValueOnce explicitly.
    vi.mocked(resolveExactBarcode).mockReset().mockImplementation(realImpls.resolveExactBarcode);
    vi.mocked(resolveExactPartNumber).mockReset().mockImplementation(realImpls.resolveExactPartNumber);
    vi.mocked(getPersistedDecode).mockReset().mockImplementation(realImpls.getPersistedDecode);
    vi.mocked(resolveUnknownFast).mockReset().mockImplementation(realParallel.resolveUnknownFast);
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    try { fs.unlinkSync(decodeCacheTestFile()); } catch {}
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
  }, 30000);

  it("cap-blocked: an exhausted daily cap blocks the paid ladder with an honest cap reason and zero paid calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
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

  // Task 8 (P1/P2): the owner "never fully unknown" rule - a scan must never surface as a bare
  // "Unidentified item" when the GS1 company prefix knows the company. FLOORED_GTIN's prefix 5603344
  // has a REAL prefixIndex dominant ("general", a Continental-family member), so prefixFloorName names
  // it "General (Continental family) / product unconfirmed". It is deliberately absent from every free
  // corpus/DB fixture, so it reaches the paid ladder (P2) or the all-miss return (P1).
  const FLOORED_GTIN = "5603344000017";

  it("P2: a cap-blocked decode still carries the prefix floor (never a fully-unknown 429)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted -> paid ladder is blocked
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
    stubFreeRungFetch({ upcHit: false }); // both free rungs genuinely miss

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect(Array.isArray(reasons)).toBe(true);
    const rungOrder = (reasons ?? []).map((r) => r.rung);
    // Free phase first (both GTIN-gated free rungs ran and missed), then the paid phase in order.
    // goupc is GTIN-gated in (VALID_GTIN qualifies), so it appears; no live key means it then misses too.
    expect(rungOrder).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
    // The paid daily-cap counter was charged EXACTLY ONCE for this request (free rungs missed, so the
    // paid phase ran; the cap started at 0 and must now read exactly 1 - not 0, not 2+).
    expect(await readDailyUsed(await ladderStorage())).toBe(1);
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
});
