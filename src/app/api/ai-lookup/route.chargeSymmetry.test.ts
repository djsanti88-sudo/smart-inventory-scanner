// @vitest-environment node
//
// FINDING B (P6 fix wave, cost-truth / accounting symmetry): the GLOBAL daily slot was charged inside
// the pipeline's chargePaidSlot (before the paid rungs run), while the PER-ACCOUNT slot was charged
// LATER, back at the route, only after the pipeline returned cleanly (gated on outcome.paidComputeCharged).
// If the ladder threw AFTER chargePaidSlot, the global counter was charged but the account counter never
// was -> permanent accounting drift on the exception path. The fix moves the per-account charge INTO
// chargePaidSlot, immediately after the global chargeDailySlot, so the two ALWAYS move together at one
// exception-consistent site. L12 preserved: still exactly one global + one account charge per genuine
// paid compute.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// Redirect ladderStorage() at a per-process tmp dir so the REAL atomic counters are exercised.
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-route-chargesym-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

// Always a valid member so every request reaches the cap logic under test.
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }),
}));

// The heart of the test: force the PAID ladder to throw AFTER chargePaidSlot has already charged the
// global slot. The pipeline calls runLadder TWICE - first the FREE run (must MISS so the total-free-miss
// branch is taken and chargePaidSlot fires), then the PAID run (where we throw to simulate a mid-ladder
// exception on the paid path). So: run the real ladder for the free call (it misses - 404 fetches, no
// keys), then throw on the paid call.
vi.mock("@/server/upc/ladder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/ladder")>();
  let calls = 0;
  return {
    ...actual,
    runLadder: vi.fn(async (...args: Parameters<typeof actual.runLadder>) => {
      calls += 1;
      if (calls === 1) return actual.runLadder(...args); // FREE run: real, misses -> no outcome
      throw new Error("simulated mid-ladder failure after chargePaidSlot"); // PAID run: throw
    }),
  };
});

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

function makeRequest(body: object, ip = "8.8.8.8") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("/api/ai-lookup charge symmetry on a mid-ladder exception (Finding B)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_ACCOUNT_DAILY_LIMIT",
    "AI_LOOKUP_GLOBAL_BACKSTOP", "NEXT_PUBLIC_AUTH_MODE", "GEMINI_API_KEY", "OPENAI_API_KEY",
    "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY", "GO_UPC_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "DECODE_CACHE_FILE",
  ];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpDecodeCacheFile: string;
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-route-chargesym-test-${process.pid}`, ".ladder-kv.json");

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
    delete process.env.GO_UPC_API_KEY;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
    process.env.AI_LOOKUP_DAILY_LIMIT = "500";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key"; // paid work genuinely possible (L6 gate)
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-chargesym-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
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
    // A genuine-unknown GTIN so the pipeline reaches the paid ladder (where our mocked runLadder throws).
    return POST(makeRequest({ cleanCode: "111000222333", businessId: "tenant-b", idToken: "tok", mode: "decode", ...extra }));
  }

  it("pipeline throws AFTER chargePaidSlot -> global AND account counters BOTH advance by exactly one (move together)", async () => {
    const gBefore = await globalUsedNow();
    const aBefore = await acctUsedNow("tenant-b");

    // The mocked runLadder throws, so the route rejects (a 5xx or thrown error is fine - what matters is
    // the counters). We only care that the two counters stayed in lock-step.
    await authedReq().catch(() => undefined);

    const gAfter = await globalUsedNow();
    const aAfter = await acctUsedNow("tenant-b");

    // The global slot WAS charged inside chargePaidSlot before the throw. Pre-fix the account slot was
    // charged only at the route AFTER a clean return, so on this exception path it stayed at aBefore ->
    // drift (global advanced, account did not). Post-fix both advance together by exactly one.
    expect(gAfter).toBe(gBefore + 1);
    expect(aAfter).toBe(aBefore + 1);
    expect(gAfter - gBefore).toBe(aAfter - aBefore); // the invariant: they move TOGETHER
  });
});
