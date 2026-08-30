// @vitest-environment node
//
// FINDING C (P6 fix wave, agy-confirmed availability bug): both ai-lookup rate-limit call sites (GET and
// POST) did `storage: await decodeStorage()` UNGUARDED. A storage init throw (e.g. Turso/libsql
// unreachable) turned into a raw 500 for EVERY request - the rate limiter, whose entire job is to
// protect the app, would instead take the app down on a storage hiccup. The fix wraps each rate-limit
// block in try/catch that fails OPEN (skip the limiter, log rate_limit_unavailable), mirroring the
// export route's now-standard pattern (src/app/api/account/export/route.ts:123-142).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

// Never let this suite construct a REAL Admin SDK client: on a keyless CI runner the gRPC stub's
// async credential fetch rejects AFTER the test finishes ("Could not load the default credentials")
// and vitest fails the whole run on the unhandled rejection. These tests never authenticate, so the
// admin surface is a plain stub.
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => { throw new Error("no auth in this suite"); }) }),
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

// decodeStorage() throws on the FIRST call of each request (the rate-limit site under test) and returns
// a real tmp-dir file store on every subsequent call, so the request can proceed past the fail-open
// limiter and exercise the rest of the handler normally. This isolates the rate-limit fail-open: if the
// fix is absent, the FIRST throw becomes a raw 500 and the request never gets past the limiter.
let failNextStorageInit = false;
vi.mock("@/server/decode/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/decode/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-route-failopen-test-${process.pid}`);
  return {
    ...actual,
    decodeStorage: vi.fn(async () => {
      if (failNextStorageInit) {
        failNextStorageInit = false; // only the FIRST call of the request (the rate-limit site) throws
        throw new Error("storage init failed (Turso unreachable)");
      }
      return actual.fileDecodeStorage(tmpLadderDir);
    }),
  };
});

import { POST, GET } from "@/app/api/ai-lookup/route";
import { __resetForTest } from "@/decoding/limits/aiSpendGuard";
import { clearDecodeCache } from "@/decoding/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";

function makeRequest(body: object, ip = "7.7.7.7") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("/api/ai-lookup rate-limit fail-open on storage init failure (Finding C)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "AI_LOOKUP_DAILY_LIMIT", "OPENAI_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE", "NEXT_PUBLIC_AUTH_MODE"];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let tmpDecodeCacheFile: string;

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    failNextStorageInit = false;
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.IS_E2E;
    delete process.env.AI_LOOKUP_KILL_SWITCH;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.NEXT_PUBLIC_AUTH_MODE; // mock auth mode (no live-auth gate)
    tmpDecodeCacheFile = path.join(os.tmpdir(), `decode-cache-route-failopen-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpDecodeCacheFile;
    fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    vi.restoreAllMocks();
  });

  it("POST: a storage init throw at the rate-limit site does NOT 500 - the request proceeds (fails open)", async () => {
    failNextStorageInit = true; // the POST rate-limit decodeStorage() throws
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "decode" }));
    // Pre-fix: raw 500 (unhandled throw from the unguarded rate-limit site). Post-fix: fails open,
    // proceeds, and returns a normal (non-500) response.
    expect(res.status).not.toBe(500);
    expect(res.status).toBeLessThan(500);
  });

  it("GET: a storage init throw at the rate-limit site does NOT 500 - the status endpoint still responds", async () => {
    failNextStorageInit = true; // the GET rate-limit decodeStorage() throws
    const req = new Request("http://localhost/api/ai-lookup", { method: "GET", headers: { "x-forwarded-for": "7.7.7.8" } });
    const res = await GET(req);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200); // status endpoint still returns its config payload
  });
});
