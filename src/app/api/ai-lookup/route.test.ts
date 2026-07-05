// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The route imports server-only modules (groundedSpecFinder). Stub the marker so it can load in vitest.
vi.mock("server-only", () => ({}));

import { POST, GET } from "@/app/api/ai-lookup/route";
import { __resetForTest, dailyUsage } from "@/services/security/aiSpendGuard";
import { clearDecodeCache } from "@/services/ai/decodeCache";

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
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_GET_RATE_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AI_LOOKUP_COUNTER_FILE", "AI_LOOKUP_GPT_LADDER_FILE"];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;
  let tmpGptLadderFile: string;

  beforeEach(() => {
    __resetForTest();
    clearDecodeCache();
    for (const k of keys) saved[k] = process.env[k];
    // Guards ACTIVE (not E2E) + NO provider keys (so providers fall back to the local mock).
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    tmpCounter = path.join(os.tmpdir(), `ai-usage-route-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_COUNTER_FILE = tmpCounter;
    tmpGptLadderFile = path.join(os.tmpdir(), `gpt-ladder-usage-route-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_GPT_LADDER_FILE = tmpGptLadderFile;
    // No real network: every fetch is stubbed offline.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
    try { fs.unlinkSync(tmpGptLadderFile); } catch {}
    __resetForTest();
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

  it("daily spend cap blocks with 429 daily_cap and makes ZERO provider/network calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("daily_cap");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("legacy 'lookup' mode is ALSO bound by the daily cap (no bypass)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "lookup" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("daily_cap");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a request with NO mode (legacy lookup default) is ALSO bound by the daily cap", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0";
    const res = await POST(makeRequest({ cleanCode: "111000222333" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("daily_cap");
  });

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
    const res = await POST(makeRequest({ cleanCode: "111000222444", mode: "decode" }));
    expect(res.status).toBe(200);
    expect(dailyUsage({ file: tmpCounter }).count).toBe(1);
  }, 20000);

  // Regression (same run): the cap was consumed BEFORE the decode cache was read, so a zero-spend
  // cached repeat scan burned cap slots and, once the cap tripped, returned 429 instead of the cached
  // product (the harness saw 109 "name mismatches" that were really empty 429 bodies).
  it("a cached repeat decode is FREE: no cap slot consumed and it still succeeds AT the cap", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "1";
    const first = await POST(makeRequest({ cleanCode: "111000222555", mode: "decode" }));
    expect(first.status).toBe(200); // consumed the single slot
    const repeat = await POST(makeRequest({ cleanCode: "111000222555", mode: "decode" }));
    expect(repeat.status, "cached repeat must not be blocked by the cap").toBe(200);
    const json = await repeat.json();
    expect(json.debug?.cached).toBe(true);
    expect(dailyUsage({ file: tmpCounter }).count).toBe(1);
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

  const gptLadderTodayKey = () => `gptLadderUsd:${new Date().toISOString().slice(0, 10)}`;

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
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.5") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "11122901", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).toBe("verified");
    expect(json.decision.corroborationPath).toBe("gpt_self_report");
    expect(json.providerNames).toContain("gpt-5.5-ladder");
    expect(json.reasonCode).toBe("gpt_ladder");
    // The ladder call itself must have actually happened (model gpt-5.5), proving this wasn't a
    // coincidental pass from some other path.
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.5")).toBe(true);
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
    const spend = JSON.parse(fs.readFileSync(tmpGptLadderFile, "utf8"));
    expect(spend[gptLadderTodayKey()].spentUsd).toBe(0.39);
  }, 40000);

  // IMPORTANT 1 lock: an info_only ladder outcome must be a retryable MISS, never a permanent cache
  // entry (decode.ts's invariant: "needs_review is reserved for no provider produced a product"). We
  // prove it by fast-forwarding Date.now() past the miss TTL between two POSTs for the SAME code and
  // showing the second call recomputes (hits the mocked ladder endpoint again) instead of returning a
  // stale cached value forever. Only Date.now() is mocked (not real timers), so the route's internal
  // setTimeout-based budgets are unaffected; today's date-keyed files (todayKey uses `new Date()`,
  // unmocked) stay consistent across both calls.
  it("an info_only GPT ladder outcome does NOT poison the decode cache: a second POST recomputes", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const infoOnlyBody = responsesBody({
      brand: "Goodyear", productName: "Goodyear (best guess, low confidence)", specs: "", gtin: "",
      confidence: 0.3, exactCodeFound: false, basis: "barcode prefix suggests Goodyear family", sourceUrls: [],
    });
    fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.5") {
        return new Response(JSON.stringify(infoOnlyBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const code = "11122904";
    const t0 = Date.now();

    const first = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.decision.status).toBe("needs_review");
    expect(firstJson.debug.cached).toBe(false);
    const ladderCallsBefore = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
    expect(ladderCallsBefore).toBeGreaterThan(0);

    // Fast-forward past the (default 10-minute) miss TTL so a retryable miss recomputes instead of
    // being read back from an in-memory cache that hasn't expired yet.
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t0 + 700_000);
    try {
      const second = await POST(makeRequest({ cleanCode: code, mode: "decode" }));
      expect(second.status).toBe(200);
      const secondJson = await second.json();
      // A PERMANENT (poisoned) cache entry would return cached:true with NO new provider call. Proving
      // it recomputes is the proof the info_only miss did not poison the cache forever.
      expect(secondJson.debug.cached).toBe(false);
      const ladderCallsAfter = fetchSpy.mock.calls.filter(([u]) => String(u).includes("api.openai.com/v1/responses")).length;
      expect(ladderCallsAfter).toBeGreaterThan(ladderCallsBefore);
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
      if (u.includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.5") {
        return new Response(JSON.stringify(verifiedBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await POST(makeRequest({ cleanCode: "111000222777", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // The code DID travel the Plan D path (floor produced), and the GPT verified self-report REPLACED it.
    expect(json.providerNames).toContain("parallel:floor");
    expect(json.providerNames).toContain("gpt-5.5-ladder");
    expect(json.decision.status).toBe("verified");
    expect(json.decision.corroborationPath).toBe("gpt_self_report");
    expect(json.reasonCode).toBe("gpt_ladder");
    expect(json.results[0].productName).toBe("Acme Widget Pro 500");
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).includes("api.openai.com/v1/responses") && modelOf(init) === "gpt-5.5")).toBe(true);
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
    // Cost truth: a failed call is still billed - the worst case must land in the spend file.
    const spend = JSON.parse(fs.readFileSync(tmpGptLadderFile, "utf8"));
    expect(spend[gptLadderTodayKey()].spentUsd).toBe(0.39);
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
});
