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
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_GET_RATE_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AI_LOOKUP_COUNTER_FILE"];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;

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
    // No real network: every fetch is stubbed offline.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
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
});
