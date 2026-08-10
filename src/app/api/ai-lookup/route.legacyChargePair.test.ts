// @vitest-environment node
//
// ITEM 1 (final fix wave, legacy charge-pair consistency): the LEGACY (non-decode) authed path charges
// the global slot then the per-account slot as two sequential awaits (route.ts ~:424-425). If the SECOND
// throws, pre-fix the global slot was charged, the account slot was not, and the whole legitimate request
// 500s on a pure bookkeeping error - the SAME asymmetry class fixed for the decode path in 543e7e2. The
// fix wraps the PAIR: on failure of EITHER charge, log a structured "charge_pair_incomplete" divergence
// event and STILL return the normal successful lookup response (fail-open, like the rate limiter). This
// suite proves: account-charge rejects -> response is still 200, and the divergence event is logged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// Redirect ladderStorage() at a per-process tmp dir so real counters never pollute the repo tree.
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os2 = await import("node:os");
  const path2 = await import("node:path");
  const tmpLadderDir = path2.join(os2.tmpdir(), `ladder-storage-route-legacycp-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

// Always a valid member so the authed request reaches the legacy charge pair under test.
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }),
}));

// The heart of the test: the GLOBAL charge succeeds, but the SECOND charge (per-account) rejects. Pre-fix
// this rejection propagated out of the un-try/catch'd pair and 500'd the whole request; post-fix it is
// caught, logged as a divergence, and the request still serves its normal 200 lookup response.
// Item 1 (2026-08-09/10): the NON-god legacy authed per-account charge runs through the atomic
// conditional variant. A controllable spy lets each test choose that half's OUTCOME:
//   - THROW (storage error) -> S4 fail-open: serve 200, log divergence, never 5xx.
//   - resolve {granted:false} (authoritative account-cap denial) -> block 429 account_daily_cap.
const acctCondSpy = vi.hoisted(() => vi.fn());
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...actual,
    chargeDailySlotForAccountConditional: acctCondSpy,
  };
});

// Capture the structured divergence event without importing the real server logger's side effects.
const logSpy = vi.fn();
vi.mock("@/server/log", () => ({
  logServerEvent: (input: unknown) => logSpy(input),
}));

import { POST } from "@/app/api/ai-lookup/route";
import { __resetForTest } from "@/services/security/aiSpendGuard";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";

function makeRequest(body: object, ip = "7.7.7.7") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("/api/ai-lookup legacy authed charge-pair fail-open (Item 1)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "AI_LOOKUP_ACCOUNT_DAILY_LIMIT",
    "AI_LOOKUP_GLOBAL_BACKSTOP", "NEXT_PUBLIC_AUTH_MODE", "GEMINI_API_KEY", "OPENAI_API_KEY",
    "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY", "GO_UPC_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "DECODE_CACHE_FILE",
  ];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpDecodeCacheFile: string;
  const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-route-legacycp-test-${process.pid}`, ".ladder-kv.json");

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    logSpy.mockReset();
    acctCondSpy.mockReset();
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
    process.env.AI_LOOKUP_DAILY_LIMIT = "500";
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-legacycp-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    // No real network: every fetch is a stubbed 200 so providers fall back to the local mock cleanly.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpDecodeCacheFile); } catch {}
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  it("per-account charge rejects (storage error) on the legacy authed path -> response is still 200 and a divergence event is logged", async () => {
    // A NON-decode mode so the legacy authed cap block, not the decode pipeline's own charge, is the path
    // under test. The per-account conditional THROWS (a storage error, not a quota denial).
    acctCondSpy.mockRejectedValueOnce(new Error("simulated per-account charge failure"));
    const res = await POST(makeRequest({ cleanCode: "111000222333", businessId: "tenant-legacy", idToken: "tok", mode: "lookup" }));

    // Fail-open: the request already cleared every real gate, so a charge bookkeeping error must NOT 500 it.
    expect(res.status).toBe(200);

    // The divergence was logged with the honest event + a 200 status (bookkeeping error, request served).
    const diverged = logSpy.mock.calls
      .map((c) => c[0] as { event?: string; reasonCode?: string; status?: number; businessId?: string })
      .find((e) => e && e.event === "charge_pair_incomplete");
    expect(diverged).toBeDefined();
    expect(diverged?.reasonCode).toBe("charge_error");
    expect(diverged?.status).toBe(200);
    expect(diverged?.businessId).toBe("tenant-legacy");
  });

  it("per-account authoritative denial ({granted:false}) on the legacy authed path -> 429 account_daily_cap, not a served lookup", async () => {
    // Deep-review Finding 2 (2026-08-10): a {granted:false} from the per-account conditional is a REAL
    // quota denial (the tenant raced past the read gate to its own cap), distinct from a storage-error
    // throw. It must ENFORCE the account cap (429), never pin-and-serve past it.
    acctCondSpy.mockResolvedValueOnce({ used: 3, granted: false });
    const res = await POST(makeRequest({ cleanCode: "111000222333", businessId: "tenant-cap", idToken: "tok", mode: "lookup" }));

    expect(res.status).toBe(429);
    const body = (await res.json()) as { reasonCode?: string };
    expect(body.reasonCode).toBe("account_daily_cap");
  });
});
