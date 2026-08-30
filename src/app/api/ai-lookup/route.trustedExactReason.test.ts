import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the route harness: mock every external seam before importing the route so the POST
// handler is exercised in isolation.
const runDecodePipeline = vi.fn();
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...args: unknown[]) => runDecodePipeline(...args),
  e2eMode: () => false,
}));

const trustedExactCheck = vi.fn();
vi.mock("@/services/security/trustedExactRateLimit", () => ({
  trustedExactRateLimiter: { check: (...args: unknown[]) => trustedExactCheck(...args) },
  maskTrustedExactIdentifier: (value: string) => value,
}));

vi.mock("@/users-businesses/roles/roleAccess", () => ({
  isPlatformOwnerServer: () => false,
}));

vi.mock("@/server/tire-knowledge/tireExactIndex", () => ({
  getTireExactIndexFingerprint: async () => ({ schemaVersion: 1, contentDigest: "digest" }),
}));

vi.mock("@/server/decode/storage", () => ({
  decodeStorage: async () => ({}),
}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: vi.fn(),
  appendMasterCatalogEntry: vi.fn(),
}));

vi.mock("@/server/log", () => ({
  logServerEvent: vi.fn(),
}));

vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...orig,
    killSwitchOn: () => false,
    checkRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }),
    readDailyUsedForAccount: async () => 0,
    chargeDailySlotForAccount: async () => 1,
  };
});

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn() }),
  getAdminDb: () => ({ doc: vi.fn() }),
}));

const ORIG = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
  delete process.env.NEXT_PUBLIC_REQUIRE_LOGIN;
  delete process.env.IS_E2E;
  delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  delete process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
  runDecodePipeline.mockReset().mockResolvedValue({
    kind: "computed",
    payload: {
      decision: { status: "needs_review" },
      reasonCode: "no_result",
      reasonText: "No exact match.",
      debug: {},
      results: [],
    },
    cached: false,
    paidComputeCharged: false,
  });
  trustedExactCheck.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.NEXT_PUBLIC_REQUIRE_LOGIN = ORIG.NEXT_PUBLIC_REQUIRE_LOGIN;
  process.env.IS_E2E = ORIG.IS_E2E;
  process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = ORIG.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = ORIG.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
});

function probe(cleanCode: string) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "decode", cleanCode, rawCode: cleanCode, deterministicOnly: true }),
  });
}

describe("deterministicOnly miss reasons are honest", () => {
  it("tells a non-allowlisted session that nothing was checked", async () => {
    const { POST } = await import("./route");
    const res = await POST(probe("8848116004503"));
    const body = await res.json();

    expect(body.reasonCode).toBe("trusted_exact_not_available");
    expect(body.reasonText).toBe(
      "Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.",
    );
    expect(body.decision.status).toBe("needs_review");
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });
});
