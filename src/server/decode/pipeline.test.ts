// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The pipeline imports `server-only` (and server-only modules). Stub the marker so it loads in vitest.
vi.mock("server-only", () => ({}));

// Redirect ladderStorage() at a per-process tmp dir so the daily-cap / Go-UPC usage counters never
// pollute the real repo working tree (identical to the route test's mock).
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

import { runDecodePipeline, DailyCapExceededError } from "@/server/decode/pipeline";
import { detectCodeType } from "@/services/codeTypeDetector";
import { __resetForTest, readDailyUsed } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import * as decodeCacheModule from "@/services/ai/decodeCache";
import { clearDecodeCache } from "@/services/ai/decodeCache";
import { __resetForTest as __resetDecodeCacheStoreForTest } from "@/server/decodeCacheStore";

// Thin unit tests for the extracted decode pipeline (Task 2.4). They run with NO API keys and a fully
// STUBBED global.fetch, so NO live provider call and NO real network can occur - every rung either
// skips (no key) or misses. These prove the two invariants the route relied on and that must survive
// the extraction: (1) an all-miss ladder returns an unresolved payload whose reason chain names every
// rung that came back empty (owner: never silent); (2) a cap-exhausted request is blocked from the
// paid ladder with an honest cap reason.

const AI_PROVIDER_HOSTS = ["generativelanguage.googleapis.com", "api.openai.com", "go-upc.com", "firecrawl.dev"];

function makeReq(code: string) {
  return {
    code,
    codeType: detectCodeType(code),
    rawCodeSanitized: code,
    cleanCodeSanitized: code,
    threshold: 0.8,
    allowNonPublicAutoCount: true,
    forceRetry: false,
  } as const;
}

const ladderKvFile = () => path.join(os.tmpdir(), `ladder-storage-pipeline-test-${process.pid}`, ".ladder-kv.json");

describe("runDecodePipeline (extracted decode pipeline; no live AI)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["IS_E2E", "AI_LOOKUP_DAILY_LIMIT", "GEMINI_API_KEY", "OPENAI_API_KEY", "FIRECRAWL_API_KEY", "GO_UPC_API_KEY", "BRAVE_SEARCH_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE"];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetForTest();
    __resetDecodeCacheStoreForTest();
    clearDecodeCache();
    try { fs.unlinkSync(ladderKvFile()); } catch {}
    for (const k of keys) saved[k] = process.env[k];
    // Guards ACTIVE (not E2E) + NO provider keys (so every rung skips or misses; no real network).
    delete process.env.IS_E2E;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GO_UPC_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    // Any stray outbound fetch resolves to a benign 404 - proves no live provider is required.
    fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  const hitAnAiProvider = () => fetchSpy.mock.calls.some(([u]) => AI_PROVIDER_HOSTS.some((h) => String(u).includes(h)));

  it("all-miss ladder returns an unresolved payload whose reason chain names every rung that came back empty", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the miss, not the block
    const outcome = await runDecodePipeline(makeReq("111000222333"));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    // Nothing resolved: the decision is NOT verified and no product auto-counts.
    expect(outcome.payload.decision.status).not.toBe("verified");
    // The reason chain surfaces every rung's miss (owner: never a silent needs_review).
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect(Array.isArray(reasons)).toBe(true);
    const rungsSeen = (reasons ?? []).map((r) => r.rung);
    expect(rungsSeen).toContain("fetchv2");
    expect(rungsSeen).toContain("gpt");
    // No live AI/paid provider was contacted (all keys absent).
    expect(hitAnAiProvider()).toBe(false);
  }, 30000);

  it("cap-blocked: an exhausted daily cap blocks the paid ladder with an honest cap reason and zero paid calls", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // already at/over the cap
    const outcome = await runDecodePipeline(makeReq("111000222333"));

    expect(outcome.kind).toBe("cap_blocked");
    if (outcome.kind !== "cap_blocked") throw new Error("unreachable");
    // Honest cap reason (the string the route turns into a 429 daily_cap response).
    expect(outcome.message).toMatch(/cap/i);
    // The DailyCapExceededError type is exported for the route's catch site.
    expect(DailyCapExceededError).toBeTypeOf("function");
    // The counter was NOT charged on a blocked request (read-only gate, then throw before charge).
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    // No paid provider was contacted once the cap is exhausted.
    expect(hitAnAiProvider()).toBe(false);
  });

  // FREE-RUNGS-OUTSIDE-THE-PAID-CAP (bug fix, 2026-07-12 review): UPCitemdb / Open Food Facts must
  // never charge the paid daily AI-lookup cap, and an already-exhausted paid cap must never block
  // them from running and resolving a code for $0. VALID_GTIN has a real GS1 check digit, so it is
  // GTIN-gated into the free half of the ladder (buildFreeLadderRungs); the earlier cap tests above
  // use "111000222333", which has a BAD check digit and so never reaches the free rungs at all -
  // these tests need a code that genuinely exercises the free half.
  // Synthetic 12-digit code with a valid GS1 check digit but NOT a real product - deliberately
  // absent from the tire corpus / retail knowledge index / barcodeDb fixtures, so it reaches the
  // ladder rungs themselves instead of short-circuiting on a free corpus hit above them.
  const VALID_GTIN = "900000000003";
  const UPCITEMDB_HOST = "api.upcitemdb.com";
  const OFF_HOST = "world.openfoodfacts.org";

  function stubFreeRungFetch(opts: { upcHit?: boolean } = {}) {
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(UPCITEMDB_HOST)) {
        if (opts.upcHit) {
          return new Response(
            JSON.stringify({ code: "OK", items: [{ title: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken", category: "Tire" }] }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ code: "OK", items: [] }), { status: 200 }); // genuine miss
      }
      if (url.includes(OFF_HOST)) {
        return new Response(JSON.stringify({ status: 0 }), { status: 200 }); // genuine miss
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
  }

  it("free rung settles (UPCitemdb hit) -> paid daily counter UNCHANGED, even when the cap is ALREADY exhausted going in (no DailyCapExceededError)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "0"; // cap already exhausted before this request even starts
    stubFreeRungFetch({ upcHit: true });

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    // The free rung answered -> a normal "computed" result, NOT cap_blocked. Proves an exhausted
    // paid cap never blocks a free-rung resolution, and no DailyCapExceededError was thrown.
    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    expect(outcome.payload.providerNames).toContain("upcitemdb");
    expect(outcome.payload.decision.status).toBe("needs_review"); // UPCitemdb hit is always a suggestion
    // The PAID daily-cap counter's actual stored value must be exactly unchanged (still 0) - not
    // merely "no throw". A free-rung resolution must never touch the paid charge function at all.
    expect(await readDailyUsed(await ladderStorage())).toBe(0);
    // Only the free-rung host was ever contacted - never an AI/paid provider host.
    expect(hitAnAiProvider()).toBe(false);
  });

  it("cap available + free rungs MISS -> paid charge happens EXACTLY ONCE, paid rungs run, and reasons chain is free-phase-then-paid-phase", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap
    stubFreeRungFetch({ upcHit: false }); // both free rungs genuinely miss

    const outcome = await runDecodePipeline(makeReq(VALID_GTIN));

    expect(outcome.kind).toBe("computed");
    if (outcome.kind !== "computed") throw new Error("unreachable");
    const reasons = outcome.payload.debug.ladderReasons as Array<{ rung: string; reason: string }> | undefined;
    expect(Array.isArray(reasons)).toBe(true);
    const rungOrder = (reasons ?? []).map((r) => r.rung);
    // Free phase first (both GTIN-gated free rungs ran and missed), then the paid phase in order.
    // goupc is GTIN-gated in (VALID_GTIN qualifies), so it appears; no live key means it then misses too.
    expect(rungOrder).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
    // The paid daily-cap counter was charged EXACTLY ONCE for this request (free rungs missed, so the
    // paid phase ran; the cap started at 0 and must now read exactly 1 - not 0, not 2+).
    expect(await readDailyUsed(await ladderStorage())).toBe(1);
  });

  it("Z3: two encodings of one product share one cache identity (canonical GTIN cache key)", async () => {
    process.env.AI_LOOKUP_DAILY_LIMIT = "100"; // plenty of cap; the point is the shared key, not the block
    const seen: string[] = [];
    const withDecodeCacheSpy = vi.spyOn(decodeCacheModule, "withDecodeCache");
    withDecodeCacheSpy.mockImplementation(async (key, _isSuccess, compute) => {
      seen.push(key);
      return { value: await compute(), cached: false };
    });

    // Same product, two zero-padding encodings: EAN-13 "0036000291452" and its UPC-A form
    // "036000291452" both canonicalize to "00036000291452" (canonicalGtin pads to 14).
    await runDecodePipeline(makeReq("0036000291452"));
    await runDecodePipeline(makeReq("036000291452"));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]); // one shared cache identity, not two
    expect(seen[0]).toBe("00036000291452");

    withDecodeCacheSpy.mockRestore();
  });
});
