// @vitest-environment node
//
// S4 (deep review 2026-08-09, uncharged spend on the legacy path): the legacy (non-decode) lookup path
// charged the daily slot and, if that charge THREW, logged a divergence and CONTINUED into the paid
// lookup - i.e. a storage hiccup turned into repeatable UNCHARGED SPEND, with no meter bounding the
// bill for as long as the storage stayed sick. Cost-truth says the opposite: an unrecordable charge
// must FAIL CLOSED (no paid call, honest reason).
//
// The split matters and is asserted here:
//   - GLOBAL charge fails  -> 503, no paid lookup (the bill-bounding meter never advanced).
//   - ACCOUNT charge fails -> still 200 (spend already metered globally; only the per-tenant counter
//     drifts by one) - that sound fail-open case is proven by route.legacyChargePair.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

vi.mock("@/server/upc/storage", () => ({ ladderStorage: async () => ({}) }));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }),
}));

vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", () => ({
  resolveTrustedExactBarcodeDecision: vi.fn().mockResolvedValue({ kind: "miss" }),
}));

// The heart of the test: the GLOBAL daily charge rejects (storage down).
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...actual,
    readDailyUsed: vi.fn(async () => 0),
    readDailyUsedForAccount: vi.fn(async () => 0),
    chargeDailySlot: vi.fn(async () => {
      throw new Error("simulated daily-cap storage failure");
    }),
    chargeDailySlotForAccount: vi.fn(async () => 1),
  };
});

const logSpy = vi.fn();
vi.mock("@/server/log", () => ({ logServerEvent: (input: unknown) => logSpy(input) }));

import { POST } from "@/app/api/ai-lookup/route";
import { __resetForTest } from "@/services/security/aiSpendGuard";
import { clearDecodeCache } from "@/services/ai/decodeCache";

function makeRequest(body: object, ip = "9.9.9.9") {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const saved: Record<string, string | undefined> = {};
const keys = ["IS_E2E", "AI_LOOKUP_KILL_SWITCH", "NEXT_PUBLIC_AUTH_MODE", "AI_LOOKUP_DAILY_LIMIT"];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetForTest();
  clearDecodeCache();
  logSpy.mockReset();
  for (const k of keys) saved[k] = process.env[k];
  delete process.env.IS_E2E;
  delete process.env.AI_LOOKUP_KILL_SWITCH;
  process.env.AI_LOOKUP_DAILY_LIMIT = "500";
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetForTest();
  vi.restoreAllMocks();
});

describe("/api/ai-lookup legacy path fails CLOSED when the global daily charge cannot be recorded (S4)", () => {
  it("authed legacy lookup: global charge throws -> 503 charge_unavailable, zero provider egress", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
    const res = await POST(
      makeRequest({ cleanCode: "111000222333", businessId: "tenant-x", idToken: "tok", mode: "lookup" })
    );

    expect(res.status).toBe(503);
    const payload = await res.json();
    expect(payload.reasonCode).toBe("charge_unavailable");
    expect(payload.error).toMatch(/no ai call made/i);
    // Nothing was paid for: the request never reached any provider.
    expect(fetchSpy).not.toHaveBeenCalled();

    const logged = logSpy.mock.calls
      .map((c) => c[0] as { reasonCode?: string; status?: number })
      .find((e) => e && e.reasonCode === "charge_unavailable");
    expect(logged?.status).toBe(503);
  });

  it("anonymous legacy lookup: global charge throws -> 503 charge_unavailable, zero provider egress", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    const res = await POST(makeRequest({ cleanCode: "111000222333", mode: "lookup" }));

    expect(res.status).toBe(503);
    expect((await res.json()).reasonCode).toBe("charge_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
