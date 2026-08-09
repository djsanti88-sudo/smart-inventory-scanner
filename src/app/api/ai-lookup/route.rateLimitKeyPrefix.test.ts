// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Cross-route rate-limit bucket isolation (ported from the preserved worktree fix,
// .claude/worktrees/agent-a47380b0deaa5e8d2): the decode POST path used to call
// checkRateLimit(clientIp, ...) with the BARE client IP, sharing one bucket with every OTHER
// route calling checkRateLimit with the same bare IP (catalog-dispute, catalog-review,
// catalog-review/[id]) - a bulk-scan session hammering this route could 429 an unrelated
// catalog request for the same client IP, and vice versa, even though each route configures
// its own distinct rate-limit env var. This test proves the decode POST path keys its rate
// limit with a route-family prefix (matching the GET handler's existing "GET:${ip}" and the
// export route's "EXPORT:${ip}" convention), not the bare IP.

vi.mock("server-only", () => ({}));

// Same test-safety mocks as route.test.ts: without these the route's fire-and-forget
// master-append/master-lookup hooks reach the real Admin SDK during this suite.
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));
vi.mock("@/server/catalog/masterLookup", () => ({
  lookupMasterCatalog: async () => ({ kind: "miss" as const }),
}));

// Redirect ladderStorage() at a per-process tmp dir (same reasoning as route.test.ts: route.ts
// calls ladderStorage() with no dir arg, defaulting to the real repo root).
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-route-prefix-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

const checkRateLimitSpy = vi.hoisted(() => vi.fn());
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...actual,
    checkRateLimit: (...args: Parameters<typeof actual.checkRateLimit>) => {
      checkRateLimitSpy(...args);
      return actual.checkRateLimit(...args);
    },
  };
});

import { POST } from "@/app/api/ai-lookup/route";

function makeRequest(body: object, ip = "9.9.9.9") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai-lookup decode-path rate-limit key prefix", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY", "AI_LOOKUP_COUNTER_FILE", "AI_LOOKUP_GPT_LADDER_FILE", "DECODE_CACHE_FILE", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GO_UPC_API_KEY", "GO_UPC_MONTHLY_LIMIT"];
  let tmpCounter: string;
  let tmpGptLadderFile: string;
  let tmpDecodeCacheFile: string;
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-route-prefix-test-${process.pid}`, ".ladder-kv.json");

  beforeEach(() => {
    checkRateLimitSpy.mockClear();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
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
    process.env.AI_LOOKUP_DAILY_LIMIT = "100";
    tmpCounter = path.join(os.tmpdir(), `ai-usage-route-prefix-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_COUNTER_FILE = tmpCounter;
    tmpGptLadderFile = path.join(os.tmpdir(), `gpt-ladder-usage-route-prefix-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.AI_LOOKUP_GPT_LADDER_FILE = tmpGptLadderFile;
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-prefix-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpCounter); } catch {}
    try { fs.unlinkSync(tmpGptLadderFile); } catch {}
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    vi.restoreAllMocks();
  });

  it("keys the decode-path rate limit with a POST: route prefix, not the bare client IP", async () => {
    await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(checkRateLimitSpy).toHaveBeenCalledTimes(1);
    const [key] = checkRateLimitSpy.mock.calls[0] as [string, unknown];
    expect(key).toMatch(/^POST:/);
  }, 20000);
});
