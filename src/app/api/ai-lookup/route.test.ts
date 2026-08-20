// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The route imports server-only modules (groundedSpecFinder). Stub the marker so it can load in vitest.
vi.mock("server-only", () => ({}));

// P5b Task 2: this suite exercises real "verified"/app-verified decode outcomes (GPT ladder, tire
// corpus) with IS_E2E deliberately unset (testing the route's OWN abuse guards). Without this mock the
// route's fire-and-forget master-append hook would call the real Admin SDK (getAdminDb) on every such
// outcome, producing unhandled "Could not load the default credentials" rejections - TEST SAFETY: no
// automated test may reach live Firestore. Stubbed to a no-op; the hook's own wiring/gating is proven
// separately in route.masterAppend.test.ts.
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// Same hazard as masterAppend above, one rung earlier in the ladder (pipeline.ts's free
// master-catalog peek, c0be3b8): without this mock, `lookupMasterCatalog` calls the real Admin
// SDK (getAdminDb) on every decode compute in this suite, producing the identical unhandled
// "Could not load the default credentials" rejections - TEST SAFETY: no automated test may reach
// live Firestore. Stubbed to an honest "miss" (its documented fail-open shape); the rung's own
// wiring/gating is proven separately in masterLookup.test.ts and pipeline.test.ts.
vi.mock("@/server/catalog/masterLookup", () => ({
  lookupMasterCatalog: async () => ({ kind: "miss" as const }),
}));

// TASK T8b: route.ts calls `ladderStorage()` (no dir arg) which defaults to `process.cwd()` - the REAL
// repo root. A Go-UPC rung that genuinely hits writes a usage counter via that storage, which would
// pollute the actual repo working tree on every test run. Redirect ladderStorage() at a per-process tmp
// dir instead (fileLadderStorage itself is untouched/real - only the directory changes).
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-route-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

import { POST, GET } from "@/app/api/ai-lookup/route";
import { __resetForTest, readDailyUsed, recordGptLadderSpend, recordGptLadderCall, getGptLadderStatus } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";
import { canonicalGtin } from "@/services/upc/gtin";

// v2 daily cap (Task 1): the counter now lives in ladderStorage() (mocked above to a per-process tmp
// dir), not the old AI_LOOKUP_COUNTER_FILE. Reads today's usage through the SAME storage the route
// itself reads/writes, so these assertions prove the real atomic counter, not a parallel one.
async function dailyUsedNow(): Promise<number> {
  return readDailyUsed(await ladderStorage());
}

// Route-level wallet-protection smoke tests for /api/ai-lookup (6937cf3). They run with NO API keys and a
// fully STUBBED global.fetch, so NO live provider call and NO real network can occur. The guards run only
// when IS_E2E !== "1" (E2E mock mode skips them), so these tests force IS_E2E OFF to exercise the guards.

function makeRequest(body: object, ip = "9.9.9.9") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const AI_PROVIDER_HOSTS = ["generativelanguage.googleapis.com", "api.openai.com"];

describe("/api/ai-lookup wallet protection (route-level smoke; no live AI)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_GET_RATE_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY", "AI_LOOKUP_COUNTER_FILE", "AI_LOOKUP_GPT_LADDER_FILE", "DECODE_CACHE_FILE", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GPT_LADDER_DAILY_USD", "GO_UPC_API_KEY", "GO_UPC_MONTHLY_LIMIT"];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;
  let tmpGptLadderFile: string;
  let tmpDecodeCacheFile: string;
  // The mocked ladderStorage() (see the vi.mock above) resolves to a FIXED per-process tmp dir, shared
  // across every test in this file - unlike tmpCounter/tmpGptLadderFile/tmpDecodeCacheFile, it cannot be
  // re-randomized per test (the vi.mock factory captures the dir once, at mock-setup time). The v2 daily
  // cap counter (Task 1) now lives inside that shared dir's generic kv file, keyed by TODAY's real date -
  // so without a per-test wipe, every test in this suite would accumulate onto the SAME counter. Deleting
  // just the kv file (not the whole dir) leaves the Go-UPC usage/miss-cache files other tests may exercise
  // untouched.
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-route-test-${process.pid}`, ".ladder-kv.json");

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
    // Guards ACTIVE (not E2E) + NO provider keys (so providers fall back to the local mock).
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.GO_UPC_API_KEY;
    delete process.env.GO_UPC_MONTHLY_LIMIT;
    tmpCounter = path.join(os.tmpdir(), `ai-usage-route-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_COUNTER_FILE = tmpCounter;
    tmpGptLadderFile = path.join(os.tmpdir(), `gpt-ladder-usage-route-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_GPT_LADDER_FILE = tmpGptLadderFile;
    // L2 persistent decode cache (Task 4) MUST point at a tmp file for every test in this suite - a
    // real (non-E2E) decode POST now write-throughs to it, and without this it would pollute the
    // repo's real .decode-cache.json on every test run.
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    // No real network: every fetch is stubbed offline.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
    try { fs.unlinkSync(tmpGptLadderFile); } catch {}
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  const hitAnAiProvider = () => fetchSpy.mock.calls.some(([u]) => AI_PROVIDER_HOSTS.some((h) => String(u).includes(h)));

  it("kill switch blocks with 503 and makes ZERO provider/network calls", async () => {
    process.env.AI_LOOKUP_KILL_SWITCH = "1";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(503);
    expect((await res.json()).reasonCode).toBe("kill_switch");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // "111000222333" is a genuine-unknown 12-digit UPC (not in the tire corpus or the retail index - see
  // decode-corpus.test.ts) that MUST reach a paid ladder rung to resolve. With the cap exhausted (limit
  // 0) the cap must still bound this paid path: blocked BEFORE any PAID rung runs. Note: Plan D's own
  // FREE structured-DB door (UPCitemdb trial lookup) still runs before the cap gate - it is a free
  // consensus vote, not paid work - so this asserts no PAID provider host was contacted, not zero fetch
  // calls (see hitAnAiProvider below; a stricter "zero fetch" assertion lives in decode-corpus.test.ts's
  // corpus-hit case, which never reaches Plan D's network door at all).
  it("daily spend cap blocks a genuine-unknown (paid-path) code with 429 daily_cap and makes ZERO paid provider calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
    // L6 (Task 12c): the cap gate only fires when paid work is genuinely POSSIBLE (paidWorkPossible).
    // A Brave key makes Fetch V2's paid discovery capable for any code shape, so the cap still has
    // paid work to block. (NOT GO_UPC_API_KEY - a live goupc attempt writes a 30-day negative-cache
    // entry into the shared per-file ladder-storage tmp dir and leaks into later tests on this code.)
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("daily_cap");
    expect(hitAnAiProvider(), "no Gemini/OpenAI host may be contacted once the cap is exhausted").toBe(false);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("go-upc.com")), "Go-UPC must not be contacted once the cap is exhausted").toBe(false);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("firecrawl.dev")), "Firecrawl must not be contacted once the cap is exhausted").toBe(false);
  });

  // Same code/cap as above, but asserting the DECODE-MODE specific contract: the paid ladder (Go-UPC /
  // Fetch V2 / GPT-5.5) never runs a rung once the cap is exhausted - the route must not fall through to
  // a needs_review payload that silently skipped every rung without saying why.
  it("with the cap exhausted, a genuine-unknown code is blocked from the paid ladder (no rung executes)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: paid work must be genuinely possible to block
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.reasonCode).toBe("daily_cap");
    expect(String(json.error || json.reasonText || "")).toMatch(/cap/i);
    // No paid rung (Go-UPC / Fetch V2's paid discovery / GPT-5.5) was ever reached.
    expect(json.providerNames ?? []).not.toContain("go-upc");
    expect(json.providerNames ?? []).not.toContain("fetchv2");
    expect(json.providerNames ?? []).not.toContain("gpt-5.5-ladder");
  });

  // The counter DOES increment once a request genuinely reaches paid work (as opposed to a free corpus
  // hit - see decode-corpus.test.ts "a corpus hit does NOT increment the daily-cap counter").
  it("a genuine-unknown (paid-path) decode DOES increment the daily-cap counter by exactly one", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: a key makes paid work genuinely possible -> slot charged
    const before = (await dailyUsedNow());
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(200);
    const after = (await dailyUsedNow());
    expect(after).toBe(before + 1);
  }, 20000);

  // L6 contract at route level (Task 12c, owner-ratified 2026-07-15): with ZERO provider keys, the
  // "paid" ladder degrades to free doors + honest skips - that run must NOT eat a cap slot. The
  // response still completes normally (never blocked, never charged).
  it("L6: a fully KEYLESS genuine-unknown decode returns WITHOUT charging the daily-cap counter", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // beforeEach already deleted every provider key - paidWorkPossible() is false for this code.
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(200);
    expect((await dailyUsedNow()), "a keyless run performs no paid work and must not consume a slot").toBe(0);
  }, 20000);

  // CONSOLIDATION A1 (2026-08-19): the legacy single-provider 'lookup' mode is DELETED. It burned two
  // daily-cap slots BEFORE doing any work (so even a mock-provider POST that paid for nothing charged
  // the meter twice) and it was the last live paid Gemini call in the product. The endpoint now serves
  // the decode pipeline ONLY, and anything else is refused up front - before auth, before any counter
  // read, before any storage touch - so an unrecognised mode can never fall through into billable work.
  it("the deleted legacy 'lookup' mode is refused with 400 unsupported_mode and charges nothing", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const before = await dailyUsedNow();
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "lookup" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reasonCode).toBe("unsupported_mode");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await dailyUsedNow()).toBe(before);
  });

  it("a request with NO mode is refused with 400 unsupported_mode and charges nothing", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const before = await dailyUsedNow();
    const res = await POST(makeRequest({ cleanCode: "111000222333" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reasonCode).toBe("unsupported_mode");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await dailyUsedNow()).toBe(before);
  });

  it("an unrecognised mode is refused with 400 unsupported_mode; 'decode-deep' is still accepted", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const bad = await POST(makeRequest({ cleanCode: "111000222333", mode: "garbage" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).reasonCode).toBe("unsupported_mode");

    const deep = await POST(makeRequest({ cleanCode: "111000222555", mode: "decode-deep" }));
    expect(deep.status).toBe(200);
  }, 20000);

  it("GET status endpoint is rate-limited (no unthrottled scrape/flood)", async () => {
    process.env.AI_LOOKUP_GET_RATE_LIMIT = "3";
    const mkGet = () => new Request("http://localhost/api/ai-lookup", { headers: { "x-forwarded-for": "7.7.7.7" } });
    for (let i = 0; i < 3; i++) expect((await GET(mkGet())).status).toBe(200);
    const blocked = await GET(mkGet()); // 4th within the window -> blocked
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).reasonCode).toBe("rate_limited");
  });

  it("a valid request UNDER the limit is NOT blocked (proceeds to decode) and calls NO live AI provider", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("decode");
    expect(["kill_switch", "daily_cap", "rate_limited"]).not.toContain(json.reasonCode);
    expect(hitAnAiProvider(), "no Gemini/OpenAI host may be contacted with no keys").toBe(false);
  }, 20000);

  // Regression (2026-07-02 scale500 run): each decode POST was incrementing the daily cap TWICE (the
  // route-wide check plus a duplicate inside the decode branch), halving the effective cap.
  it("one decode POST consumes exactly ONE daily-cap slot", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: a key makes paid work genuinely possible -> slot charged
    const res = await POST(makeRequest({ cleanCode: "111000222444", mode: "decode" }));
    expect(res.status).toBe(200);
    expect((await dailyUsedNow())).toBe(1);
  }, 20000);

  // Regression (same run): the cap was consumed BEFORE the decode cache was read, so a zero-spend
  // cached repeat scan burned cap slots and, once the cap tripped, returned 429 instead of the cached
  // product (the harness saw 109 "name mismatches" that were really empty 429 bodies).
  it("a cached repeat decode is FREE: no cap slot consumed and it still succeeds AT the cap", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "1";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: a key makes paid work genuinely possible -> slot charged
    const first = await POST(makeRequest({ cleanCode: "111000222555", mode: "decode" }));
    expect(first.status).toBe(200); // consumed the single slot
    const repeat = await POST(makeRequest({ cleanCode: "111000222555", mode: "decode" }));
    expect(repeat.status, "cached repeat must not be blocked by the cap").toBe(200);
    const json = await repeat.json();
    expect(json.debug?.cached).toBe(true);
    expect((await dailyUsedNow())).toBe(1);
  }, 40000);

  // --- GPT-5.5 ladder rung wiring (route-level; Task 3 review fixes + Task 3b) -------------------
  // The first block of tests uses 8-digit NUMERIC codes (detectCodeType -> "numeric_sku"): those skip
  // the Plan-D fast resolver (public-barcode-gated) and exercise the rung at computeDecode's FINAL
  // exit. The Task 3b block below uses REAL 12-digit UPCs (upc_a) that end at Plan D's generic
  // "Unidentified item" floor and exercises the rung at the Plan D early-return exit - the fix that
  // made the rung reachable for public barcodes at all.

  /** Build a Responses-API-shaped body carrying the given JSON as the model's output_text. */
  function responsesBody(parsed: Record<string, unknown>, usage = { input_tokens: 200, output_tokens: 100 }) {
    return {
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(parsed) }] }],
      usage,
    };
  }

  /** Pull the OpenAI Responses API `model` field back out of a fetch call's request body. */
  function modelOf(init: unknown): string {
    try {
      const body = (init as { body?: string } | undefined)?.body;
      return body ? (JSON.parse(body).model ?? "") : "";
    } catch {
      return "";
    }
  }

  // B1: the GPT ladder $-guard now persists through the SAME durable ladderStorage() seam the route
  // itself reads/writes (mocked above to the shared per-process tmp kv dir), not the standalone
  // tmpGptLadderFile - so this read-through-storage helper (mirroring dailyUsedNow()) proves the real
  // atomic counter the route uses, not a parallel one.
  async function gptLadderSpendNowUsd(): Promise<number> {
    const status = await getGptLadderStatus({ storage: await ladderStorage() });
    return status.spentUsd;
  }

  it("gpt-5.5 ladder rung fires and auto-counts (verified) when nothing else resolved the code", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const verifiedBody = responsesBody({
      brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17", specs: "265/70R17 115T",
      gtin: "", confidence: 0.92, exactCodeFound: true, basis: "exact code found on a real page",
      sourceUrls: ["https://example.com/x"],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "111000222901", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // D6 core (2026-07-20): a bare GPT self-report is demoted to "suggested" - it can no longer mint
    // "verified". It still settles the ladder (still the gpt-5.5-ladder provider, still stops the
    // ladder) - only the status/badge/alias decision changed, per the decode-trust plan.
    expect(json.decision.status).toBe("suggested");
    expect(json.decision.corroborationPath).toBe("gpt_self_report");
    expect(json.providerNames).toContain("gpt-5.5-ladder");
    expect(json.reasonCode).toBe("gpt_ladder");
    // The ladder call itself must have actually happened (model gpt-5.4-mini), proving this wasn't a
    // coincidental pass from some other path.
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini")).toBe(true);
  }, 40000);

  it("gpt-5.5 ladder rung is SKIPPED with a visible reason when no OpenAI key is configured, and never calls the endpoint", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // beforeEach already deletes OPENAI_API_KEY - this is the "prior rung never even got a key" case.
    const res = await POST(makeRequest({ cleanCode: "11122902", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.providerNames).not.toContain("gpt-5.5-ladder");
    expect(json.debug.gptLadderSkipReason).toBe("no_api_key");
    expect(
      json.providerStatuses.some(
        (s: { provider: string; status: string; errorCode?: string }) =>
          s.provider === "gpt-5.5-ladder" && s.status === "skipped" && s.errorCode === "no_api_key",
      ),
    ).toBe(true);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com/v1/responses"))).toBe(false);
  }, 40000);

  it("records worst-case spend when the GPT ladder call itself fails (HTTP 500); decision stays non-verified", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("api.openai.com/v1/responses")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "11122903", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).not.toBe("verified");
    expect(await gptLadderSpendNowUsd()).toBeCloseTo(0.39, 5);

    // TRANSIENT-FAILURE GUARD (found live 2026-07-06): a failed rung call is NOT genuine ladder
    // exhaustion - it must NOT write a permanent no_result_receipt (that froze the code forever on
    // one OpenAI hiccup), and the failure must be visible as a surfaced skip, never silent.
    expect(json.debug.gptLadderSkipReason).toMatch(/^gpt_call_failed:/); // classified diagnostics (e8ef3737)
    expect(
      json.providerStatuses.some(
        (s: { provider: string; status: string; errorCode?: string }) =>
          s.provider === "gpt-5.5-ladder" && s.status === "skipped" && s.errorCode?.startsWith("gpt_call_failed"),
      ),
    ).toBe(true);
    const stored = fs.existsSync(tmpDecodeCacheFile) ? JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8")) : {};
    expect(stored["11122903"], "a transient rung failure must stay retryable - no permanent receipt").toBeUndefined();
  }, 40000);

  // PROBE PARITY (owner order 2026-07-06, supersedes the old info_only contract): a weak GPT best
  // guess is a NORMAL suggestion now - the productName is shown, the decision is "suggested", and it
  // is cached like any other ladder success (kind "result", sourceTier "gpt_ladder"). A repeat scan
  // must be served from cache with ZERO new ladder calls; forceRetry remains the explicit escape hatch.
  it("a weak GPT best-guess resolves as a visible suggestion, caches as a result, and never re-bills on repeat scans", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const weakGuessBody = responsesBody({
      brand: "Goodyear", productName: "Goodyear (best guess, low confidence)", specs: "", gtin: "",
      confidence: 0.3, exactCodeFound: false, basis: "barcode prefix suggests Goodyear family", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini") {
        return new Response(JSON.stringify(weakGuessBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const code = "11122904";
    const t0 = Date.now();

    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.decision.status).toBe("suggested");
    expect(firstJson.results[0].productName).toBe("Goodyear (best guess, low confidence)");
    expect(firstJson.debug.cached).toBe(false);
    const ladderCallsBefore = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    expect(ladderCallsBefore).toBeGreaterThan(0);
    const storedAfterFirst = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8"));
    // Z3: the L2 store is keyed by the canonical GTIN, not the raw scanned code.
    const storeKey = canonicalGtin(code) ?? code;
    expect(storedAfterFirst[storeKey].kind).toBe("result");
    expect(storedAfterFirst[storeKey].tier).toBe("suggested");
    expect(storedAfterFirst[storeKey].sourceTier).toBe("gpt_ladder");

    // Fast-forward past the (default 10-minute) L1 miss TTL - a cached RESULT must still short-circuit
    // (from L1's long success TTL or the L2 persisted result), with zero new paid calls.
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t0 + 700_000);
    try {
      const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
      expect(second.status).toBe(200);
      const secondJson = await second.json();
      expect(secondJson.decision.status).toBe("suggested");
      const ladderCallsAfterCache = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
      expect(ladderCallsAfterCache, "a cached suggested result must make ZERO new ladder calls").toBe(ladderCallsBefore);

      // The owner's explicit escape hatch still works: forceRetry bypasses the cache and recomputes.
      const third = await POST(makeRequest({ cleanCode: code, mode: "decode", forceRetry: true }));
      expect(third.status).toBe(200);
      const ladderCallsAfterForceRetry = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
      expect(ladderCallsAfterForceRetry, "forceRetry must genuinely re-call the ladder").toBeGreaterThan(ladderCallsAfterCache);
    } finally {
      nowSpy.mockRestore();
    }
  }, 60000);

  // --- Task 3b: the rung is reachable from the Plan D early return (REAL public 12-digit UPCs) ----
  // Plan D (resolveUnknownFast) is TERMINAL for public barcodes: it always returns at least the
  // generic "Unidentified item (barcode X)" floor, never null, so before Task 3b the GPT ladder rung
  // at computeDecode's final exit was UNREACHABLE for every real upc_a/ean_13/gtin_14 scan.
  // NOTE on the test code: the coordinator-prescribed 848983006257 is an exact TIRE-CORPUS row in
  // this repo (tireKnowledge.generated.json) - it terminates VERIFIED at the corpus rung (locked by
  // decode-corpus.test.ts) and the ladder must correctly never fire for it. These tests instead use
  // 12-digit UPCs whose prefix maps to NOTHING in the catalog prefix index (verified against
  // brandPrefixMap.json + derivedPrefixMap.json), so corpus/retail/Plan D all miss and Plan D ends at
  // the generic unresolved floor (needs_review) - the exact scenario the fix must catch.

  it("Task 3b: GPT rung fires for a REAL 12-digit UPC that ends at Plan D's unresolved floor, and REPLACES the floor", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const verifiedBody = responsesBody({
      brand: "Acme", productName: "Acme Widget Pro 500", specs: "500 ml", gtin: "",
      confidence: 0.9, exactCodeFound: true, basis: "exact code found on a real page", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "111000222777", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // The code DID travel the Plan D path (floor produced), and the GPT self-report REPLACED it.
    // D6 core (2026-07-20): the self-report settles as "suggested" (demoted), never "verified".
    expect(json.providerNames).toContain("parallel:floor");
    expect(json.providerNames).toContain("gpt-5.5-ladder");
    expect(json.decision.status).toBe("suggested");
    expect(json.decision.corroborationPath).toBe("gpt_self_report");
    expect(json.reasonCode).toBe("gpt_ladder");
    expect(json.results[0].productName).toBe("Acme Widget Pro 500");
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini")).toBe(true);
  }, 40000);

  it("Task 3b: GPT HTTP 500 on the Plan D floor preserves the floor result untouched and records worst-case spend", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("api.openai.com/v1/responses")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "111000222778", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // The ladder ran (endpoint contacted) but produced a none-tier - Plan D's floor is NOT clobbered.
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com/v1/responses"))).toBe(true);
    expect(json.decision.status).toBe("needs_review");
    expect(json.reasonCode).not.toBe("gpt_ladder");
    expect(json.providerNames).toEqual(["parallel:floor"]);
    expect(json.results[0].productName).toBe("Unidentified item (barcode 111000222778)");
    // Cost truth: a failed call is still billed - the worst case must land in durable storage.
    expect(await gptLadderSpendNowUsd()).toBeCloseTo(0.39, 5);
  }, 40000);

  it("Task 3b: a 12-digit UPC with NO key still ends at the floor with a visible ladder skip (no endpoint call)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    // beforeEach already deletes OPENAI_API_KEY.
    const res = await POST(makeRequest({ cleanCode: "111000222779", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.providerNames).toEqual(["parallel:floor"]);
    expect(json.debug.gptLadderSkipReason).toBe("no_api_key");
    expect(
      json.providerStatuses.some(
        (s: { provider: string; status: string; errorCode?: string }) =>
          s.provider === "gpt-5.5-ladder" && s.status === "skipped" && s.errorCode === "no_api_key",
      ),
    ).toBe(true);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com/v1/responses"))).toBe(false);
  }, 40000);

  // --- Task 4: L2 persistent decode cache + permanent no_result_receipt --------------------------
  // These tests clear the L1 in-memory decode cache (clearDecodeCache()) BEFORE the second/third/
  // fourth POST of a code, simulating a fresh serverless instance whose L1 is empty but whose L2
  // (file-fallback here; Turso in production) still has the prior outcome. That isolates the L2 peek/
  // write-through path from the already-covered L1 short-TTL behavior above.

  it("Task 4: a genuinely exhausted code (GPT ran, tier none) gets a permanent receipt; a later POST short-circuits with ZERO provider calls and ZERO daily-slot burn", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    // Genuine exhaustion = GPT ANSWERED and honestly found nothing (empty productName). An HTTP
    // failure is no longer exhaustion (transient-failure guard 2026-07-06) - it stays retryable.
    const emptyAnswer = responsesBody({
      brand: "", productName: "", specs: "", gtin: "",
      confidence: 0, exactCodeFound: false, basis: "no match found anywhere", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("api.openai.com/v1/responses")) {
        return new Response(JSON.stringify(emptyAnswer), { status: 200, headers: { "content-type": "application/json" } }); // ladder runs, ends tier "none"
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // QA round-2: a VALID-check-digit UPC whose prefix maps to nothing -> Plan D unresolved floor. This
    // test exercises the receipt cache/replay machinery, NOT misread handling - the SEAM 1 misread guard
    // now re-runs (never replays) a bad-check-digit code, so this anchor must be genuinely valid.
    const code = "111000222702";
    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.decision.status).toBe("needs_review");
    expect((await dailyUsedNow())).toBe(1);

    // The receipt landed in the L2 store (file-fallback mode here).
    // Z3: the L2 store is keyed by the canonical GTIN, not the raw scanned code.
    const stored = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8"));
    expect(stored[canonicalGtin(code) ?? code].kind).toBe("no_result_receipt");

    const ladderCallsBefore = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    clearDecodeCache(); // simulate a fresh serverless instance: L1 is empty, only L2 has the receipt

    const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.decision.status).toBe("needs_review");
    expect(secondJson.debug.persistedCacheHit).toBe(true);
    expect(secondJson.debug.persistedKind).toBe("no_result_receipt");

    const ladderCallsAfter = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    expect(ladderCallsAfter, "the receipted code must make ZERO new provider calls").toBe(ladderCallsBefore);
    expect((await dailyUsedNow()), "a receipted repeat must not burn a daily slot").toBe(1);
  }, 60000);

  it("Task 4: forceRetry bypasses AND overwrites a permanent receipt, re-running providers and burning a fresh daily slot", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const code = "111000222719"; // QA round-2: valid check digit (tests forceRetry/receipt machinery, not misread)
    let openaiCallCount = 0;
    const verifiedBody = responsesBody({
      brand: "Acme", productName: "Acme Retry Widget", specs: "", gtin: "",
      confidence: 0.9, exactCodeFound: true, basis: "exact code found on a real page", sourceUrls: [],
    });
    const exhaustedBody = responsesBody({
      brand: "", productName: "", specs: "", gtin: "",
      confidence: 0, exactCodeFound: false, basis: "no match found anywhere", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("api.openai.com/v1/responses")) {
        openaiCallCount++;
        // First (genuine) call: exhausted (GPT answered with an empty productName -> tier none; an
        // HTTP failure would now be a transient skip, not a receipt). forceRetry call: returns a
        // verified hit, proving the provider genuinely re-ran rather than replaying anything cached.
        if (openaiCallCount === 1) return new Response(JSON.stringify(exhaustedBody), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect((await first.json()).decision.status).toBe("needs_review");
    const storedAfterFirst = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8"));
    // Z3: the L2 store is keyed by the canonical GTIN, not the raw scanned code.
    expect(storedAfterFirst[canonicalGtin(code) ?? code].kind).toBe("no_result_receipt");
    expect((await dailyUsedNow())).toBe(1);

    clearDecodeCache();
    // Without forceRetry, this would short-circuit on the receipt with zero calls (proven above) -
    // WITH forceRetry it must bypass the receipt, re-run the ladder, and burn a fresh slot.
    const retried = await POST(makeRequest({ cleanCode: code, mode: "decode", forceRetry: true }));
    expect(retried.status).toBe(200);
    const retriedJson = await retried.json();
    // D6 core (2026-07-20): a bare GPT self-report settles "suggested" (demoted), never "verified" -
    // it still genuinely re-ran and still settled/persisted, which is what this test proves.
    expect(retriedJson.decision.status).toBe("suggested");
    expect(retriedJson.providerNames).toContain("gpt-5.5-ladder");
    expect(openaiCallCount, "forceRetry must genuinely re-call the provider").toBe(2);
    expect((await dailyUsedNow()), "a genuine forceRetry recompute burns its own slot").toBe(2);

    // The overwrite is durable: the receipt is now a "result" entry.
    // Z3: the L2 store is keyed by the canonical GTIN, not the raw scanned code.
    const storedAfterRetry = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8"));
    expect(storedAfterRetry[canonicalGtin(code) ?? code].kind).toBe("result");

    // And a THIRD, normal (non-forceRetry) POST now short-circuits on the fresh suggested result with
    // no further provider calls.
    clearDecodeCache();
    const third = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    const thirdJson = await third.json();
    expect(thirdJson.decision.status).toBe("suggested");
    expect(thirdJson.debug.persistedCacheHit).toBe(true);
    expect(thirdJson.debug.persistedKind).toBe("result");
    expect(openaiCallCount, "the replayed suggested result must make no new provider call").toBe(2);
    expect((await dailyUsedNow())).toBe(2);
  }, 60000);

  it("Task 4: a suggested GPT-ladder outcome persists as a permanent result; a later POST replays it with ZERO provider calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const verifiedBody = responsesBody({
      brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17", specs: "265/70R17 115T",
      gtin: "", confidence: 0.92, exactCodeFound: true, basis: "exact code found on a real page",
      sourceUrls: ["https://example.com/x"],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const code = "111000222900"; // QA round-2: valid check digit (tests suggested-result cache replay, not misread)
    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    // D6 core (2026-07-20): a bare GPT self-report settles "suggested" (demoted), never "verified".
    expect((await first.json()).decision.status).toBe("suggested");
    const stored = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8"));
    // Z3: the L2 store is keyed by the canonical GTIN, not the raw scanned code.
    const storeKey = canonicalGtin(code) ?? code;
    expect(stored[storeKey].kind).toBe("result");
    // IMPORTANT 3 (review): a GPT-ladder result must record which PAID stage produced it.
    expect(stored[storeKey].sourceTier).toBe("gpt_ladder");
    expect((await dailyUsedNow())).toBe(1);

    const ladderCallsBefore = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    clearDecodeCache();

    const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    const secondJson = await second.json();
    expect(secondJson.decision.status).toBe("suggested");
    expect(secondJson.providerNames).toContain("gpt-5.5-ladder");
    expect(secondJson.debug.persistedCacheHit).toBe(true);
    const ladderCallsAfter = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    expect(ladderCallsAfter).toBe(ladderCallsBefore);
    expect((await dailyUsedNow())).toBe(1);
  }, 60000);

  it("Task 4: E2E mode never reads or writes the persistent decode cache", async () => {
    process.env.IS_E2E = "1";
    const res = await POST(makeRequest({ cleanCode: "111000222782", mode: "decode" }));
    expect(res.status).toBe(200);
    expect(fs.existsSync(tmpDecodeCacheFile), "E2E must never create the persistent cache file").toBe(false);
  });

  // --- Review fixes (post-Task-4): CRITICAL 1, CRITICAL 2, IMPORTANT 3 ----------------------------

  // CRITICAL 1 lock: forceRetry must burn a daily-cap slot even when L1 (in-memory decodeCache) is still
  // warm. Before the fix, the cap-check condition only looked at `getDecodeCache(code) === undefined &&
  // !persistedHit` - both false with a warm L1 entry - so the cap check was SKIPPED. But
  // `withDecodeCache(..., { forceRefresh: forceRetry })` bypasses L1 UNCONDITIONALLY, so the provider(s)
  // genuinely ran again for FREE (zero cap slots burned). This test deliberately does NOT call
  // clearDecodeCache() between the two POSTs, so a warm L1 entry is exactly what forceRetry must see.
  it("CRITICAL 1: forceRetry burns a daily-cap slot even with a warm L1 entry (no clearDecodeCache)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    // A REAL public 12-digit UPC whose prefix maps to nothing (same family as the Task 3b codes above) -
    // Plan D is TERMINAL for it, so the GPT ladder rung fires EXACTLY ONCE per compute at the Plan D
    // exit (no legacy fast+escalation race to entangle the call count with, unlike a numeric_sku code).
    const code = "111000222990";
    let openaiCallCount = 0;
    const verifiedBody = responsesBody({
      brand: "Acme", productName: "Acme ForceRetry Widget", specs: "", gtin: "",
      confidence: 0.9, exactCodeFound: true, basis: "exact code found on a real page", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("api.openai.com/v1/responses")) {
        openaiCallCount++;
        // First call: ends non-verified (tier none) so L1 caches it with the short miss TTL (still
        // warm - not expired - for the immediately-following forceRetry POST below). Second (forceRetry)
        // call: returns a verified hit, proving the provider genuinely re-ran.
        if (openaiCallCount === 1) return new Response("Internal Server Error", { status: 500 });
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.decision.status).not.toBe("verified");
    expect(openaiCallCount, "sanity: the ladder genuinely ran once on the first POST").toBe(1);
    expect((await dailyUsedNow())).toBe(1);

    // Deliberately NO clearDecodeCache() here: L1's short-TTL miss entry for `code` is still warm.
    const retried = await POST(makeRequest({ cleanCode: code, mode: "decode", forceRetry: true }));
    expect(retried.status).toBe(200);
    const retriedJson = await retried.json();
    // D6 core (2026-07-20): a bare GPT self-report settles "suggested" (demoted), never "verified" -
    // it still genuinely bypassed the warm L1 entry, which is what this test proves.
    expect(retriedJson.decision.status, "forceRetry must genuinely bypass the warm L1 entry").toBe("suggested");
    expect(openaiCallCount, "forceRetry must genuinely re-call the provider despite warm L1").toBe(2);
    expect((await dailyUsedNow()), "forceRetry must burn its own daily-cap slot, even with a warm L1 entry").toBe(2);
  }, 60000);

  // CRITICAL 2 lock (doctrine correction): a code blocked by the GPT ladder's OWN dollar budget was
  // NEVER PROBED - it must NOT become a permanent no_result_receipt (that would freeze the code forever,
  // surviving past the daily budget resetting tomorrow, with no automatic recovery). A second POST, once
  // the budget allows, must genuinely re-attempt the ladder rather than short-circuit on a stale receipt.
  it("CRITICAL 2: a budget-blocked ladder outcome leaves NO permanent receipt; a later POST re-attempts once budget allows", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.GPT_LADDER_DAILY_USD = "0"; // worst-case reservation (0.39) always exceeds a 0 cap
    // A REAL public 12-digit UPC whose prefix maps to nothing - Plan D is TERMINAL for it, so there is
    // NO legacy fast+escalation race to entangle with (a numeric_sku code would trigger a legitimate
    // OpenAI escalation call unrelated to the ladder, which is not what this test is about).
    const code = "111000222992";

    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.decision.status).toBe("needs_review");
    expect(firstJson.debug.gptLadderSkipReason).toBe("budget_exceeded");
    // The ladder endpoint was never even contacted (budget check short-circuits before the call).
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com/v1/responses"))).toBe(false);
    // No permanent receipt: the persistent cache file must not have gained an entry for this code.
    let storedAfterFirst: Record<string, unknown> = {};
    try { storedAfterFirst = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8")); } catch { /* file never created is also valid proof */ }
    expect(storedAfterFirst[code], "a budget-blocked code must never receive a permanent receipt").toBeUndefined();

    // Raise the budget and simulate a fresh attempt (L1's short miss TTL would otherwise replay the same
    // needs_review without proving anything about L2 - clearDecodeCache proves this is genuinely NOT
    // gated by any persisted receipt).
    delete process.env.GPT_LADDER_DAILY_USD;
    clearDecodeCache();
    const verifiedBody = responsesBody({
      brand: "Acme", productName: "Acme Budget-Recovered Widget", specs: "", gtin: "",
      confidence: 0.9, exactCodeFound: true, basis: "exact code found on a real page", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.4-mini") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    // D6 core (2026-07-20): a bare GPT self-report settles "suggested" (demoted), never "verified" -
    // it still genuinely re-attempted, which is what this test proves.
    expect(secondJson.decision.status, "the ladder must genuinely re-attempt, not be blocked by a stale receipt").toBe("suggested");
    expect(secondJson.debug.persistedCacheHit, "there was no receipt to replay").not.toBe(true);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("api.openai.com/v1/responses"))).toBe(true);
  }, 60000);

  // IMPORTANT 3 lock (a): a FREE-rung result (tire corpus) must NEVER be written to L2, even though it
  // is "verified". A permanent L2 cache entry for a free rung would mask a future corpus correction
  // forever, for zero cost benefit (nothing paid was spent to justify durability).
  it("IMPORTANT 3(a): a tire-corpus hit (free rung) is verified but writes NO L2 entry", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const KNOWN_TIRE_BARCODE = "848983006257"; // committed corpus row (see decode-corpus.test.ts)
    const res = await POST(makeRequest({ cleanCode: KNOWN_TIRE_BARCODE, mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).toBe("verified");
    expect(json.providerNames).toEqual(["tire-corpus"]);
    // No persistDecode call ever happened for this code -> the file was never created (or, if some
    // other assertion in this suite ever shares a file, at minimum has no entry for this code).
    expect(fetchSpy).not.toHaveBeenCalled();
    let stored: Record<string, unknown> = {};
    try { stored = JSON.parse(fs.readFileSync(tmpDecodeCacheFile, "utf8")); } catch { /* file never created is also valid proof */ }
    expect(stored[KNOWN_TIRE_BARCODE], "a free-rung (tire-corpus) result must never be persisted to L2").toBeUndefined();
  }, 20000);

  // Task 6: GET /api/ai-lookup exposes the GPT ladder's own spend/call status for the Settings panel.
  describe("GET status: gptLadder spend panel fields", () => {
    const mkGet = () => new Request("http://localhost/api/ai-lookup", { headers: { "x-forwarded-for": "5.5.5.5" } });

    it("reports zero spend/calls and enabled:false with no OpenAI key configured", async () => {
      const res = await GET(mkGet());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.gptLadder).toEqual({ spentTodayUsd: 0, capUsd: 3, callsToday: 0, enabled: false });
    });

    it("reflects recorded spend + calls, and enabled:true once a key is configured and budget allows", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";
      const storage = await ladderStorage();
      await recordGptLadderSpend(0.42, { storage });
      await recordGptLadderCall({ storage });
      await recordGptLadderCall({ storage });
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.gptLadder.spentTodayUsd).toBeCloseTo(0.42, 5);
      expect(json.gptLadder.callsToday).toBe(2);
      expect(json.gptLadder.enabled).toBe(true);
    });

    it("enabled is false once spend + worst case would exceed the cap, even with a key configured", async () => {
      process.env.OPENAI_API_KEY = "test-openai-key";
      process.env.GPT_LADDER_DAILY_USD = "1";
      await recordGptLadderSpend(0.9, { storage: await ladderStorage() }); // 0.9 + worst-case(~0.39) > 1.0 cap
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.gptLadder.enabled).toBe(false);
    });
  });

  // Task 16: GET /api/ai-lookup exposes the Go-UPC monthly quota (used/limit/warn) + configured flag for
  // the Settings panel. Booleans + numbers ONLY - the key value must NEVER be in the response.
  describe("GET status: goUpc quota visibility", () => {
    const mkGet = () => new Request("http://localhost/api/ai-lookup", { headers: { "x-forwarded-for": "6.6.6.6" } });

    it("returns goUpc with the right shape (configured boolean, used number, limit number|null, unlimited/warn boolean)", async () => {
      const res = await GET(mkGet());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.goUpc).toBeDefined();
      expect(typeof json.goUpc.configured).toBe("boolean");
      expect(typeof json.goUpc.used).toBe("number");
      // limit is a number when a cap is configured, or null when unlimited (Infinity is not JSON-safe).
      expect(json.goUpc.limit === null || typeof json.goUpc.limit === "number").toBe(true);
      expect(typeof json.goUpc.unlimited).toBe("boolean");
      expect(typeof json.goUpc.warn).toBe("boolean");
    });

    it("reports unlimited by default (Go-UPC runs on the owner subscription, no monthly cap)", async () => {
      // beforeEach deletes GO_UPC_MONTHLY_LIMIT, so the default resolves to unlimited.
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.goUpc.unlimited).toBe(true);
      expect(json.goUpc.limit).toBe(null);
    });

    it("configured is false when GO_UPC_API_KEY is unset", async () => {
      // beforeEach already deletes GO_UPC_API_KEY.
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.goUpc.configured).toBe(false);
    });

    it("configured is true when GO_UPC_API_KEY is set, and the key value never appears in the response", async () => {
      const secret = "go-upc-secret-key-DO-NOT-LEAK-abc123";
      process.env.GO_UPC_API_KEY = secret;
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.goUpc.configured).toBe(true);
      // The entire serialized response must contain NO key material.
      expect(JSON.stringify(json)).not.toContain(secret);
    });

    it("respects GO_UPC_MONTHLY_LIMIT env for the reported limit", async () => {
      process.env.GO_UPC_MONTHLY_LIMIT = "10";
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.goUpc.limit).toBe(10);
      expect(json.goUpc.unlimited).toBe(false);
    });
  });

  // Task 8 + consolidation A1: the status endpoint must tell the truth about the decode ladder.
  // Gemini is permanently OUT of decode (corpus -> Go-UPC -> Fetch V2 -> GPT only) and A1 removed every
  // Gemini flag/model/key from the payload entirely, so the response can no longer imply Gemini
  // participates in decode - not even as a reported-but-unused field.
  describe("GET status: decode ladder truth (Task 8)", () => {
    const mkGet = () => new Request("http://localhost/api/ai-lookup", { headers: { "x-forwarded-for": "8.8.8.8" } });

    it("reports the real decode ladder order: corpus, go_upc, fetch_v2, gpt", async () => {
      const res = await GET(mkGet());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.decodeLadder).toEqual(["corpus", "go_upc", "fetch_v2", "gpt"]);
    });

    it("reports NO Gemini surface at all, even when GEMINI_API_KEY is configured", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      const res = await GET(mkGet());
      const json = await res.json();
      for (const field of [
        "geminiUsedForDecode", "geminiConfigured", "geminiEnabled", "geminiModel", "geminiProModel",
        "geminiSearchGrounding", "openaiEnabled", "openaiWebSearch", "openaiModel", "openaiProModel",
        "premiumFallback", "mode",
      ]) {
        expect(json, `${field} must be gone from the status payload`).not.toHaveProperty(field);
      }
      expect(json.missingKeys).not.toContain("GEMINI_API_KEY");
      expect(JSON.stringify(json).toLowerCase()).not.toContain("gemini");
    });

    it("keeps the fields the client still reads (no accidental removal/rename)", async () => {
      const res = await GET(mkGet());
      const json = await res.json();
      expect(typeof json.liveEnabled).toBe("boolean");
      expect(typeof json.autoDecodeOnScan).toBe("boolean");
      expect(typeof json.openaiConfigured).toBe("boolean");
      expect(typeof json.killSwitchOn).toBe("boolean");
      expect(Array.isArray(json.missingKeys)).toBe(true);
      // Task 1's daily counter must already be present and not duplicated by this task.
      expect(json.daily).toBeDefined();
      expect(typeof json.daily.used).toBe("number");
      expect(typeof json.daily.limit).toBe("number");
    });

    it("GET remains side-effect-free: repeated GETs do not move the daily counter", async () => {
      const first = await (await GET(mkGet())).json();
      const second = await (await GET(mkGet())).json();
      expect(second.daily.used).toBe(first.daily.used);
    });
  });

  // Spec 2 (M1): the GET status endpoint (polled by Settings) must report the SERVER kill switch
  // (AI_LOOKUP_KILL_SWITCH) so a shop owner can see "the server has this locked down" instead of a
  // silently-healthy-looking Settings screen while the POST handler 503s every lookup.
  describe("GET status: killSwitchOn visibility (Spec 2)", () => {
    const mkGet = () => new Request("http://localhost/api/ai-lookup", { headers: { "x-forwarded-for": "6.6.6.6" } });

    it("reports killSwitchOn: true when AI_LOOKUP_KILL_SWITCH=1", async () => {
      process.env.AI_LOOKUP_KILL_SWITCH = "1";
      const res = await GET(mkGet());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.killSwitchOn).toBe(true);
    });

    it("reports killSwitchOn: false when the env var is unset", async () => {
      delete process.env.AI_LOOKUP_KILL_SWITCH;
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.killSwitchOn).toBe(false);
    });

    it("reports killSwitchOn: true when AI_LOOKUP_KILL_SWITCH=true", async () => {
      process.env.AI_LOOKUP_KILL_SWITCH = "true";
      const res = await GET(mkGet());
      const json = await res.json();
      expect(json.killSwitchOn).toBe(true);
    });
  });

  // --- Task T8b: Plan D's non-verified floor/suggestion must NOT be terminal for public barcodes ----
  // CONFIRMED BUG (live proof T19 + code read): Plan D's generic "Unidentified item" floor was returned
  // immediately for every public barcode, so the spec-v6 ladder (Go-UPC -> Fetch V2 -> GPT-5.5) was
  // UNREACHABLE for exactly the codes it was built for (10/10 known-good GTINs terminated at the floor,
  // Go-UPC usage delta 0). The fix: stash Plan D's non-verified payload and run the ladder; the ladder's
  // settled result wins, and the stash is the fallback ONLY on an all-miss ladder.
  describe("Task T8b: Plan D floor yields to the spec-v6 ladder for public barcodes", () => {
    // A real 12-digit UPC-A (valid GS1 check digit) whose 7-digit prefix maps to nothing in the catalog
    // prefix index (same family as the pre-existing Task 3b test codes) - corpus/retail/Plan D all miss
    // and Plan D ends at the generic unresolved floor, the exact scenario the fix must catch.
    const UNKNOWN_PREFIX_UPC = "111000222887";

    it("(a) Plan D floor-only -> the Go-UPC rung is genuinely invoked, and a Go-UPC verified result is the response", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-go-upc-key";
      const goUpcHitBody = {
        product: { name: "Acme Go-UPC Widget", brand: "Acme", description: "", imageUrl: "", category: "", specs: [] },
        inferred: false,
      };
      fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("go-upc.com/api/v1/code/")) {
          return new Response(JSON.stringify(goUpcHitBody), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const res = await POST(makeRequest({ cleanCode: UNKNOWN_PREFIX_UPC, mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();

      // Go-UPC was genuinely called (spy proof), not just skipped/gated.
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("go-upc.com/api/v1/code/"))).toBe(true);
      // The ladder's Go-UPC rung answer WINS the response, replacing Plan D's floor. P5 D6 (Task 2):
      // Go-UPC is now an honest "suggested" (paid-DB self-report), never "verified" - it still WINS the
      // response and still auto-applies its identity, only the badge/verified-flag changed.
      expect(json.decision.status).toBe("suggested");
      expect(json.results[0].productName).toBe("Acme Go-UPC Widget");
      expect(json.providerNames).toContain("go-upc");
      // Plan D's own attempt is still recorded (debug transparency), not silently dropped.
      expect(json.providerNames).toContain("parallel:floor");
      expect(json.debug.ladderPath).toBe("goupc");
    }, 20000);

    it("(b) Plan D verified win -> no ladder rung is invoked; the Plan D payload is returned as-is", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.GO_UPC_API_KEY = "test-go-upc-key";
      process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
      const code = "111000222891";
      // Drive Plan D to a GENUINE verified (cross-checked) win: UPCitemdb names the product, and the
      // Firecrawl /search tiebreaker independently confirms a barcode-carrying snippet with an AGREEING
      // name (>=2 shared distinctive tokens: "acme" + "widget") - the two-source consensus resolveUnknownFast
      // requires before it will mark verified:true.
      fetchSpy = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("api.upcitemdb.com/prod/trial/lookup")) {
          return new Response(
            JSON.stringify({ items: [{ title: "Acme Widget Pro 500", brand: "Acme", offers: [{ link: "https://example.com/acme-widget" }] }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("api.firecrawl.dev/v2/search")) {
          return new Response(
            JSON.stringify({ data: { web: [{ url: "https://example.com/p", title: "Acme Widget Pro 500", description: `barcode ${code}` }] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const res = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();

      // Sanity: Plan D genuinely verified (proves this isn't accidentally hitting the floor path).
      expect(json.decision.status).toBe("verified");
      expect(json.providerNames[0]).toMatch(/^parallel:/);
      expect(json.results[0].productName).toBe("Acme Widget Pro 500");
      // No ladder rung ran: Go-UPC (keyed, would be called if reached) was never contacted.
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("go-upc.com/api/v1/code/"))).toBe(false);
      expect(json.providerNames).not.toContain("go-upc");
      expect(json.providerNames).not.toContain("fetchv2");
      expect(json.providerNames).not.toContain("gpt-5.5-ladder");
      expect(json.debug.ladderPath).toBeUndefined();
    }, 20000);

    it("(c) Plan D floor + ladder all-miss -> response equals the floor payload, reasons list every rung's miss", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      // beforeEach already deletes GO_UPC_API_KEY/OPENAI_API_KEY/FIRECRAWL_API_KEY and stubs fetch to
      // return "{}" for everything - Go-UPC is unavailable (no key), Fetch V2 finds no sources (no
      // discovery keys), and GPT is skipped (no key): every rung misses.
      const res = await POST(makeRequest({ cleanCode: "111000222888", mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();

      // The floor payload (Plan D's own unresolved result) is exactly what came back.
      expect(json.providerNames).toContain("parallel:floor");
      expect(json.results[0].productName).toBe("Unidentified item (barcode 111000222888)");
      expect(json.decision.status).toBe("needs_review");
      // Every rung's miss reason is listed (never silent about why the ladder didn't help) - the raw
      // chain lives in debug.ladderReasons (platform-only).
      expect(json.debug.ladderReasons).toBeDefined();
      const rungNames = (json.debug.ladderReasons as Array<{ rung: string; reason: string }>).map((r) => r.rung);
      expect(rungNames).toContain("fetchv2");
      expect(rungNames).toContain("gpt");
      // BUG #14 (QA hardening 2026-07-16): the CUSTOMER-facing reasonText must be honest and non-empty
      // but must never leak the raw rung chain's provider/model names.
      expect(json.reasonText.length).toBeGreaterThan(0);
      expect(json.reasonText).not.toMatch(/fetchv2|gpt-5\.5|goupc|upcitemdb/i);
    }, 20000);

    it("(d) daily-cap counter is incremented EXACTLY once for a Plan-D-floor + all-miss-ladder request", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: a key makes paid work genuinely possible -> slot charged
      const res = await POST(makeRequest({ cleanCode: "111000222889", mode: "decode" }));
      expect(res.status).toBe(200);
      expect((await dailyUsedNow())).toBe(1);
    }, 20000);

    it("(e) a subsequent identical request is served from cache with ZERO new daily-cap slots burned", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // L6: a key makes paid work genuinely possible -> slot charged
      const code = "111000222890";
      const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
      expect(first.status).toBe(200);
      expect((await dailyUsedNow())).toBe(1);
      const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
      expect(second.status).toBe(200);
      const secondJson = await second.json();
      expect(secondJson.debug.cached).toBe(true);
      expect((await dailyUsedNow()), "a cached repeat must not burn a second daily slot").toBe(1);
    }, 20000);
  });

  // BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): the CUSTOMER-facing PROSE fields
  // (reasonText, decision.reason, results[].guesses - the free-text a scan row actually renders) must
  // never leak raw vendor/service/model names ("upcitemdb", "openfoodfacts", "goupc"/"Go-UPC",
  // "fetchv2"/"Fetch V2", "gpt-5.5") or internal skip-reason codes ("gpt_call_failed", "no_api_key",
  // etc.). Structured metadata (providerNames, providerStatuses[].provider/errorCode) is NOT prose -
  // the client's own logic keys off those exact strings (e.g. scanStore.ts's gptSkipEntry lookup for
  // provider === "gpt-5.5-ladder") and is out of this bug's scope, same as debug.* (platform-only).
  describe("BUG #14: no raw vendor/model names leak into customer-facing PROSE fields", () => {
    const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

    /** Only the free-text fields a scan row actually renders to a customer. */
    function proseFields(json: Record<string, unknown>): string[] {
      const out: string[] = [];
      if (typeof json.reasonText === "string") out.push(json.reasonText);
      const decision = json.decision as { reason?: unknown } | undefined;
      if (decision && typeof decision.reason === "string") out.push(decision.reason);
      const results = Array.isArray(json.results) ? (json.results as Array<{ guesses?: unknown }>) : [];
      for (const r of results) {
        if (Array.isArray(r.guesses)) out.push(...r.guesses.filter((g): g is string => typeof g === "string"));
      }
      return out;
    }

    function assertProseClean(json: Record<string, unknown>) {
      const strings = proseFields(json);
      const leaks = strings.filter((s) => DENYLIST_RE.test(s));
      expect(leaks, `leaked raw token(s) in a customer-facing prose field: ${JSON.stringify(leaks)}`).toEqual([]);
      for (const s of strings) expect(s.length, "a customer-facing prose field must never be empty").toBeGreaterThan(0);
    }

    it("no-key all-miss response body (excluding debug) has no denylisted token", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      const res = await POST(makeRequest({ cleanCode: "111000222901", mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.decision.status).not.toBe("verified");
      assertProseClean(json);
      // Sanity: debug.* is exempt and DOES still carry the raw chain (proves the exemption is real,
      // not just an accidentally-clean body).
      const rawDebugString = JSON.stringify(json.debug);
      expect(DENYLIST_RE.test(rawDebugString)).toBe(true);
    }, 40000);

    it("HTTP-500 GPT ladder failure (gpt_call_failed): response body (excluding debug) has no denylisted token", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      process.env.OPENAI_API_KEY = "test-openai-key";
      fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("api.openai.com/v1/responses")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const res = await POST(makeRequest({ cleanCode: "111000222902", mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.decision.status).not.toBe("verified");
      // debug.gptLadderSkipReason legitimately carries the raw code for platform diagnosis.
      expect(json.debug.gptLadderSkipReason).toMatch(/^gpt_call_failed:/); // classified diagnostics (e8ef3737)
      assertProseClean(json);
    }, 40000);

    it("no OpenAI key configured: response body (excluding debug) has no denylisted token", async () => {
      process.env.AI_LOOKUP_DAILY_LIMIT = "100";
      // beforeEach already deletes OPENAI_API_KEY.
      const res = await POST(makeRequest({ cleanCode: "111000222903", mode: "decode" }));
      expect(res.status).toBe(200);
      const json = await res.json();
      assertProseClean(json);
    }, 40000);
  });
});
