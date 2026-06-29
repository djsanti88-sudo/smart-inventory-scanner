// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The route imports server-only modules (groundedSpecFinder). Stub the marker so it can load in vitest.
vi.mock("server-only", () => ({}));

import { POST } from "@/app/api/ai-lookup/route";
import { __resetForTest } from "@/services/security/aiSpendGuard";

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
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AI_LOOKUP_COUNTER_FILE"];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpCounter: string;

  beforeEach(() => {
    __resetForTest();
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

  it("a valid request UNDER the limit is NOT blocked (proceeds to decode) and calls NO live AI provider", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("decode");
    expect(["kill_switch", "daily_cap", "rate_limited"]).not.toContain(json.reasonCode);
    expect(hitAnAiProvider(), "no Gemini/OpenAI host may be contacted with no keys").toBe(false);
  }, 20000);
});
