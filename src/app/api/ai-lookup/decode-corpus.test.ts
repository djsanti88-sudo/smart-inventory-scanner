// @vitest-environment node
//
// Plan B Task 3 (integration): proves, through the REAL POST /api/ai-lookup route handler (not just the
// provider function in isolation), that a committed tire barcode resolves from the corpus and spends
// ZERO AI. This guards Plan B's whole value: known codes resolve free, including on Vercel where SQLite
// is unavailable (no knowledge.generated.db in the deployed bundle) and the in-memory JSON fallback
// (Task 1) is what actually serves the lookup.
//
// Seam chosen: the full route POST() handler, mirroring the existing wallet-protection tests in
// route.test.ts (IS_E2E off, no provider keys, global.fetch stubbed as a spy). This is the honest
// end-to-end seam: computeDecode() is a private closure inside route.ts (not exported), so calling it
// directly is not possible without refactoring the route (out of scope per the plan). Driving POST()
// exercises the exact code path a real request takes: cap/kill-switch checks -> corpus check
// (resolveExactBarcode -> lookupByExactBarcode -> getKnowledgeDb) -> early return with aiCalled:false,
// all BEFORE any provider is constructed or global.fetch is touched.
//
// getKnowledgeDb is mocked to null (same technique as tireKnowledgeIndex.jsonfallback.test.ts) so the
// JSON fallback path is what resolves the barcode, deterministically reproducing the Vercel case (no
// SQLite file in the bundle) rather than relying on a possibly-present local knowledge.generated.db.gz.
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => null,
  __resetKnowledgeDbForTests: () => {},
}));
// The route imports server-only modules (groundedSpecFinder). Stub the marker so it can load in vitest.
vi.mock("server-only", () => ({}));

// Same hazard route.test.ts guards against: without these mocks, a public-barcode decode that falls
// through the corpus reaches pipeline.ts's free master-catalog peek (lookupMasterCatalog) and/or the
// route's fire-and-forget master-append hook (maybeAppendMasterCatalogEntry), both of which construct
// the real Admin SDK (getAdminDb) absent a mock, producing unhandled "Could not load the default
// credentials" rejections - TEST SAFETY: no automated test may reach live Firestore. Stubbed to their
// documented fail-open shapes; the rungs' own wiring/gating is proven separately in
// masterLookup.test.ts, masterAppend.test.ts, and route.masterAppend.test.ts.
vi.mock("@/server/catalog/masterLookup", () => ({
  lookupMasterCatalog: async () => ({ kind: "miss" as const }),
}));
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// v2 daily cap (Task 1): route.ts now reads/writes the cap counter through ladderStorage(). This file
// does NOT set TURSO_DATABASE_URL, so an unmocked ladderStorage() would default to the file adapter
// rooted at process.cwd() - the REAL repo root - and pollute the working tree on every test run (same
// hazard route.test.ts's existing mock guards against). Redirect at a per-process tmp dir instead.
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-decode-corpus-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { POST } from "@/app/api/ai-lookup/route";
import { __resetForTest, readDailyUsed } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import { __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";
import { clearDecodeCache } from "@/services/ai/decodeCache";

/** Reads today's daily-cap usage through the SAME (mocked, tmp-dir) ladderStorage() the route uses. */
async function dailyUsedNow(): Promise<number> {
  return readDailyUsed(await ladderStorage());
}

// A barcode confirmed present in the committed barcodeIndex (see tireKnowledge.generated.json /
// tireKnowledgeIndex.jsonfallback.test.ts).
const KNOWN_TIRE_BARCODE = "848983006257";

function makeDecodeRequest(cleanCode: string, ip = "9.9.9.9") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ cleanCode, mode: "decode" }),
  });
}

describe("/api/ai-lookup decode: a committed tire barcode resolves from the corpus with ZERO AI spend", () => {
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AI_LOOKUP_COUNTER_FILE", "DECODE_CACHE_FILE", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;
  let tmpDecodeCacheFile: string;
  // Same fixed-per-process shared mocked ladderStorage() dir as route.test.ts - wipe the v2 daily-cap
  // kv file per test so tests in this file don't accumulate onto the same TODAY-dated counter key.
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-decode-corpus-test-${process.pid}`, ".ladder-kv.json");

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    __resetTireKnowledgeCacheForTests();
    // L1 in-memory decode cache (route.ts's withDecodeCache) is a MODULE-LEVEL singleton, not reset by
    // __resetDecodeCacheStoreForTest (that's the L2 persistent store). Without this, a code resolved by
    // an earlier test in this file stays warm in L1 and every later POST for that same code short-circuits
    // via the (correct) L1-cache cap bypass - masking whether the CORPUS lookup itself bypasses the cap.
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
    // Real (non-E2E) code path so the corpus check in computeDecode() actually runs: the E2E branch
    // (`IS_E2E=1`) short-circuits straight to the mock provider and SKIPS the corpus check entirely, which
    // would prove nothing about the Vercel fix. No provider keys either, so a provider call (if it somehow
    // happened) would be visibly wrong, not silently mocked away.
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    tmpCounter = path.join(os.tmpdir(), `ai-usage-decode-corpus-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_COUNTER_FILE = tmpCounter;
    // Task 4: a real (non-E2E) decode now write-throughs to the persistent L2 cache - point it at a tmp
    // file so this test never touches the repo's real .decode-cache.json.
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-corpus-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    // No real network at all: if ANY code path reached fetch (i.e. the AI/page-fetch path), this spy
    // would record the call and the assertions below would fail. A corpus hit must never touch this.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  it("resolves the tire barcode with aiCalled:false, a corpus provider name, and NO fetch/network call", async () => {
    const res = await POST(makeDecodeRequest(KNOWN_TIRE_BARCODE));
    expect(res.status).toBe(200);
    const json = await res.json();

    // Corpus hit, not Needs Review / AI decode.
    expect(json.mode).toBe("decode");
    expect(json.decision.status).toBe("verified");
    expect(json.providerNames).toEqual(["tire-corpus"]);
    expect(json.debug.corroborationPath).toBe("corpus_exact_barcode");

    // The exact assertion this test exists to prove: NO AI was called.
    expect(json.debug.aiCalled).toBe(false);
    expect(json.debug.pageFetched).toBe(false);

    // Strongest possible proof of zero AI spend: global.fetch (the only way this route can reach
    // Gemini/OpenAI/Firecrawl) was never invoked at all, because the corpus check returns before any
    // provider is constructed or called.
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20000);

  it("a non-corpus code is NOT claimed as a corpus hit (sanity: the assertion above is not vacuous)", async () => {
    const res = await POST(makeDecodeRequest("000000000000"));
    const json = await res.json();
    expect(json.providerNames).not.toEqual(["tire-corpus"]);
    expect(json.debug?.corroborationPath).not.toBe("corpus_exact_barcode");
  }, 20000);

  // Daily-cap-vs-free-resolution fix: the cap must bound only PAID work (Go-UPC/Fetch V2/GPT-5.5), never
  // a $0 corpus/cache hit. Before the fix the cap was checked BEFORE computeDecode() ran the corpus
  // lookup, so an exhausted cap (limit 0) 429'd even a code the corpus could answer for free.
  it("a corpus hit STILL resolves (verified, aiCalled:false) even when the daily cap is fully exhausted (limit 0)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted
    const res = await POST(makeDecodeRequest(KNOWN_TIRE_BARCODE));
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).toBe("verified");
    expect(json.providerNames).toEqual(["tire-corpus"]);
    expect(json.debug.aiCalled).toBe(false);
    expect(json.reasonCode).not.toBe("daily_cap");
    // No provider/network call at all - a free corpus hit never touches fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20000);

  // A corpus/free hit must not consume a cap slot at all (not just "not be blocked by" one) - the
  // counter should read the SAME before and after the decode.
  it("a corpus hit does NOT increment the daily-cap counter", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const before = await dailyUsedNow();
    const res = await POST(makeDecodeRequest(KNOWN_TIRE_BARCODE));
    expect(res.status).toBe(200);
    const after = await dailyUsedNow();
    expect(after).toBe(before);
  }, 20000);
});

// FIX 2 (2026-07-01): the parallel resolver is TERMINAL for public barcodes. A public-barcode miss that
// bottoms out at the Plan C prefix floor must END there (Suggested/Needs Review) and NEVER run the
// expensive legacy Gemini/OpenAI fast path. With no provider keys, the legacy fast path uses mockProvider
// (providerNames ["mock"], a fabricated product name) - so a floor return proves the legacy path was skipped.
describe("/api/ai-lookup decode: parallel resolver is TERMINAL for public barcodes (no legacy money-pit)", () => {
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AI_LOOKUP_COUNTER_FILE", "DECODE_CACHE_FILE", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;
  let tmpDecodeCacheFile: string;

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    __resetTireKnowledgeCacheForTests();
    // L1 in-memory decode cache (route.ts's withDecodeCache) is a MODULE-LEVEL singleton, not reset by
    // __resetDecodeCacheStoreForTest (that's the L2 persistent store). Without this, a code resolved by
    // an earlier test in this file stays warm in L1 and every later POST for that same code short-circuits
    // via the (correct) L1-cache cap bypass - masking whether the CORPUS lookup itself bypasses the cap.
    clearDecodeCache();
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY; // no keys: grounding leg + legacy Gemini/OpenAI are all inert
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    tmpCounter = path.join(os.tmpdir(), `ai-usage-terminal-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_COUNTER_FILE = tmpCounter;
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-terminal-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    // The only fetch a floor-return path may touch is the free upcitemdb barcode-DB leg. This spy returns
    // an EMPTY body so that leg misses; any call to a legacy AI endpoint would be visibly wrong.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  // 049000028904: a public UPC-A whose GS1 prefix maps to Coca-Cola in the derived catalog (see
  // sideDoorFirewall.store.test.ts). Both fast legs miss (no keys / empty barcode-DB body) -> the prefix
  // floor names the brand. That floor must be the FINAL answer, with NO legacy AI/mock call.
  it("a public-barcode double-miss ends at the prefix floor (Suggested) and NEVER runs the legacy path", async () => {
    const res = await POST(makeDecodeRequest("049000028904"));
    expect(res.status).toBe(200);
    const json = await res.json();

    // The parallel prefix floor is the terminal answer - not the legacy mock provider.
    expect(json.providerNames).toEqual(["parallel:floor"]);
    expect(json.debug.corroborationPath).toBe("parallel_floor");
    expect(json.results[0].productName).toBe("Coca-Cola / product unconfirmed");
    // Floor is a naming aid only: NEVER verified, NEVER auto-counted.
    expect(json.decision.status).not.toBe("verified");
    expect(json.evidences[0].verified).toBe(false);

    // PROOF the legacy money-pit was skipped: with no keys the legacy path runs mockProvider
    // (providerNames ["mock"]); it never appears. And no fetch went to a legacy AI endpoint - the only
    // fetches are the free upcitemdb barcode-DB leg.
    expect(json.providerNames).not.toContain("mock");
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => /generativelanguage|openai\.com/i.test(u))).toBe(false);
  }, 20000);

  // A NON-public code (vendor label / alpha SKU) must still reach the legacy path unchanged: the parallel
  // resolver is gated to public barcodes, so it returns null here and does NOT short-circuit.
  it("a NON-public code still reaches the legacy path (parallel resolver does not short-circuit it)", async () => {
    const res = await POST(makeDecodeRequest("X001ABCDEF")); // X00... FNSKU-style vendor label, not a public barcode
    const json = await res.json();
    expect(json.providerNames).not.toEqual(["parallel:floor"]);
    expect(json.providerNames.some((n: string) => n.startsWith("parallel:"))).toBe(false);
    expect(json.debug?.corroborationPath ?? "").not.toMatch(/^parallel_/);
  }, 20000);
});
