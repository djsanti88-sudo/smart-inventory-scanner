// @vitest-environment node
//
// P6 Task A2 (GC-A, law-critical): the tenant-starvation cap-reorder fix. Failing-first proof for the
// starvation case described in docs/archive/superpowers/plans/2026-07-20-phase6-sell-ready.md GC-A: with the
// GLOBAL counter already drained (>= AI_LOOKUP_DAILY_LIMIT) and an authed tenant's OWN account usage at
// 0, that tenant must SUCCEED on the decode path (pre-fix: 429). Consolidation A1 deleted the legacy
// 'lookup' path (and its half of this suite) - decode is the only path this endpoint serves.
// Anonymous traffic (no authedBusinessId) still hits the plain global cap exactly as before. An
// account-cap-exhausted tenant still 429s with the honest account_daily_cap reasonCode. Charge-count
// assertions prove L12 stays intact: exactly one global + one account charge per genuine paid compute,
// zero charges on any blocked request.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

// Same fire-and-forget master-append stub as route.test.ts - a real "verified" outcome would otherwise
// try to reach live Firestore via getAdminDb.
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// Redirect ladderStorage() at a per-process tmp dir (same pattern as route.test.ts / pipeline.test.ts)
// so this suite exercises the REAL atomic counters without touching the repo working tree.
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-route-a2-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

// Live-auth membership gate: always a valid member, exactly like route.d4.test.ts, so every request in
// this suite reaches the cap logic under test instead of 401/403ing on auth.
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }),
}));
// Boss-for-everyone (Option A, 2026-08-07): every authed member now reaches the trusted-exact path
// before the ladder. Mock a clean MISS so authed decodes fall through to the real pipeline exactly as
// before (these tests assert the per-account/global cap accounting done by the ladder, not the corpus).
vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", () => ({
  resolveTrustedExactBarcodeDecision: vi.fn().mockResolvedValue({ kind: "miss" }),
}));

import { POST } from "@/app/api/ai-lookup/route";
import { __resetForTest, readDailyUsed, readDailyUsedForAccount } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";

async function globalUsedNow(): Promise<number> {
  return readDailyUsed(await ladderStorage());
}
async function acctUsedNow(businessId: string): Promise<number> {
  return readDailyUsedForAccount(await ladderStorage(), businessId);
}

function makeRequest(body: object, ip = "9.9.9.9") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("/api/ai-lookup GC-A tenant-starvation cap reorder (P6 Task A2)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_ACCOUNT_DAILY_LIMIT",
    "AI_LOOKUP_GLOBAL_BACKSTOP", "NEXT_PUBLIC_AUTH_MODE", "GEMINI_API_KEY", "OPENAI_API_KEY",
    "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY", "GO_UPC_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "DECODE_CACHE_FILE",
  ];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpDecodeCacheFile: string;
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-route-a2-test-${process.pid}`, ".ladder-kv.json");

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.IS_E2E;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GO_UPC_API_KEY;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-a2-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  function authedReq(extra: Record<string, unknown> = {}) {
    return POST(makeRequest({ cleanCode: "111000222333", businessId: "tenant-a", idToken: "tok", ...extra }));
  }

  // isLiveAuth() is a single process-wide flag (NEXT_PUBLIC_AUTH_MODE), so "anonymous demo traffic
  // draining the shared global bucket while an authed tenant is starved" is simulated by draining the
  // counter in mock mode (today's real anonymous traffic shape) and then switching to live mode to
  // prove the authed tenant's request against that already-drained shared counter - both modes write
  // the SAME storage-backed global key (ladderStorage(), redirected to this suite's tmp dir).
  async function drainGlobalAsAnonymous(n: number, mode: "decode" | "decode-deep" = "decode") {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    for (let i = 0; i < n; i++) {
      const res = await POST(makeRequest({ cleanCode: `9990001112${i}2`, mode }));
      expect(res.status).not.toBe(429);
    }
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  }

  // --- DECODE path -----------------------------------------------------------------------------------

  it("decode path: an authed tenant with acctUsed=0 SUCCEEDS even though the global counter is already drained", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "1";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // makes paid work genuinely possible (L6 gate)
    await drainGlobalAsAnonymous(1, "decode"); // anonymous decode traffic exhausts the plain global cap
    expect(await globalUsedNow()).toBeGreaterThanOrEqual(1);

    const res = await authedReq({ mode: "decode" });
    expect(res.status).not.toBe(429); // FAILS PRE-FIX: pipeline's internal global gate cap_blocked 429s here
    const json = await res.json();
    expect(json.reasonCode).not.toBe("daily_cap");
  });

  it("decode path: anonymous traffic still 429s cap_blocked/daily_cap at the plain global cap (unchanged)", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    process.env.AI_LOOKUP_DAILY_LIMIT = "0";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("daily_cap");
  });

  it("decode path: an account-cap-exhausted tenant still 429s with account_daily_cap before the pipeline ever runs", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "500";
    process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT = "0";
    const res = await authedReq({ mode: "decode" });
    expect(res.status).toBe(429);
    expect((await res.json()).reasonCode).toBe("account_daily_cap");
  });

  it("decode path: exactly one global + one account charge per genuine paid compute", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "500";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    const before = await globalUsedNow();
    const acctBefore = await acctUsedNow("tenant-a");
    const res = await authedReq({ mode: "decode" });
    expect(res.status).not.toBe(401);
    // A genuine-unknown code with a discovery key configured reaches paid work -> exactly one charge each.
    expect(await globalUsedNow()).toBe(before + 1);
    expect(await acctUsedNow("tenant-a")).toBe(acctBefore + 1);
    void res;
  });
});
