import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// MANDATORY pipeline mock: the route must reach its auth/policy gates deterministically with zero
// pipeline/provider work, and e2eMode must report false or the live-mode gates are skipped entirely.
const runDecodePipeline = vi.fn();
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...a: unknown[]) => runDecodePipeline(...a),
  e2eMode: () => false,
}));
const readDailyUsedForAccount = vi.fn();
const chargeDailySlotForAccount = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...orig,
    killSwitchOn: () => false,
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    readDailyUsedForAccount: (...a: unknown[]) => readDailyUsedForAccount(...a),
    chargeDailySlotForAccount: (...a: unknown[]) => chargeDailySlotForAccount(...a),
  };
});
const memberGet = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: memberGet }) }),
}));

const ORIG = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  delete process.env.IS_E2E;
  delete process.env.AI_LIVE_SCAN_CONTEXT;
  delete process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT;
  runDecodePipeline.mockReset().mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
  memberGet.mockReset().mockResolvedValue({ exists: true });
  readDailyUsedForAccount.mockReset().mockResolvedValue(0);
  chargeDailySlotForAccount.mockReset().mockResolvedValue(1);
});
afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.IS_E2E = ORIG.IS_E2E;
});

function decodeReq(extra: Record<string, unknown> = {}) {
  return new Request("http://x/api/ai-lookup", {
    method: "POST",
    body: JSON.stringify({ mode: "decode", cleanCode: "TX100-PN", businessId: "b1", idToken: "t", ...extra }),
  });
}

describe("ai-lookup D4 live-mode trust", () => {
  it("rejects a decode request with no idToken (401), before any pipeline work", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://x/api/ai-lookup", {
      method: "POST",
      body: JSON.stringify({ mode: "decode", cleanCode: "0123456789012", businessId: "b1" }),
    }));
    expect(res.status).toBe(401);
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("membership gate runs BEFORE any quota read/charge (403, zero per-account key touches)", async () => {
    memberGet.mockResolvedValue({ exists: false }); // authed member of A, sent businessId "B"
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(403);
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("hostile scanContext 'tire' + autoCount flag never reach the pipeline in live mode (server policy wins)", async () => {
    const { POST } = await import("./route");
    await POST(decodeReq({ scanContext: "tire", autoCountNonPublicWithEvidence: true, codeType: "upc" }));
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    const arg = runDecodePipeline.mock.calls[0][0] as {
      scanContext?: string; allowNonPublicAutoCount: boolean; codeType: string;
    };
    expect(arg.scanContext).toBe("any"); // live policy default: no tire auto-verify paths unlockable by a client
    expect(arg.allowNonPublicAutoCount).toBe(false); // live policy default: env AI_ALLOW_NONPUBLIC_AUTOCOUNT unset -> off
    expect(arg.codeType).not.toBe("upc"); // "TX100-PN" is not a UPC; server recompute wins over the client claim
  });

  it("per-account charge fires ONLY on paidComputeCharged (free rung-0 hit never charges the account)", async () => {
    const { POST } = await import("./route");
    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
    await POST(decodeReq());
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled(); // computed but FREE (corpus/retail/learned)

    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: true });
    await POST(decodeReq());
    expect(chargeDailySlotForAccount).toHaveBeenCalledOnce(); // genuine paid compute: exactly one account charge
  });
});
