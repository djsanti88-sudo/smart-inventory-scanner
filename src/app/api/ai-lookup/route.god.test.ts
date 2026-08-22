import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GOD ACCOUNT (owner order 2026-08-07): the SERVER-verified platform owner bypasses every server
// spend/rate/cap gate on /api/ai-lookup EXCEPT the kill switch, and is still CHARGED (cost-truth).
// God identity is derived ONLY from the verified token + the NON-PUBLIC PLATFORM_OWNER_UIDS/EMAILS
// allowlist (isPlatformOwnerServer) - never a client value. These tests prove: (1) a god request over
// the rate limit / daily cap still proceeds; (2) a non-god identical request is still blocked; (3) god
// does NOT bypass the kill switch; (4) god:true is threaded into the pipeline.

const runDecodePipeline = vi.fn();
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...args: unknown[]) => runDecodePipeline(...args),
  e2eMode: () => false,
}));

// Trusted-exact path falls through to the pipeline (a clean miss) so the cap/rate-limit gates run.
vi.mock("@/server/tire-knowledge/TireKnowledgeProvider", () => ({
  resolveTrustedExactBarcodeDecision: vi.fn().mockResolvedValue({ kind: "miss" }),
}));

const logServerEvent = vi.fn();
vi.mock("@/server/log", () => ({ logServerEvent: (...args: unknown[]) => logServerEvent(...args) }));

const trustedExactCheck = vi.fn();
vi.mock("@/services/security/trustedExactRateLimit", () => ({
  trustedExactRateLimiter: { check: (...args: unknown[]) => trustedExactCheck(...args) },
}));

const verifyIdToken = vi.fn();
const memberGet = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => verifyIdToken(...args) }),
  getAdminDb: () => ({ doc: () => ({ get: (...args: unknown[]) => memberGet(...args) }) }),
}));

const decodeStorage = vi.fn();
vi.mock("@/server/decode/storage", () => ({ decodeStorage: (...args: unknown[]) => decodeStorage(...args) }));

const legacyRateLimit = vi.fn();
const killSwitch = vi.fn();
const readDailyUsedForAccount = vi.fn();
const chargeDailySlotForAccount = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...actual,
    killSwitchOn: () => killSwitch(),
    checkRateLimit: (...args: unknown[]) => legacyRateLimit(...args),
    readDailyUsedForAccount: (...args: unknown[]) => readDailyUsedForAccount(...args),
    chargeDailySlotForAccount: (...args: unknown[]) => chargeDailySlotForAccount(...args),
  };
});

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: vi.fn(),
}));

const GOD_UID = "nDPz45mqDMaaucovnl4y5v5vhSH3";
const GOD_EMAIL = "djsanti88@gmail.com";
const originalEnv = { ...process.env };

function decodeRequest(extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    body: JSON.stringify({
      mode: "decode",
      cleanCode: "111000222333",
      businessId: "business-a",
      idToken: "token-a",
      ...extra,
    }),
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  // SERVER-ONLY allowlist (never NEXT_PUBLIC): the god identity.
  process.env.PLATFORM_OWNER_UIDS = GOD_UID;
  process.env.PLATFORM_OWNER_EMAILS = GOD_EMAIL;
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS;
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS;
  delete process.env.IS_E2E;
  delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  // Default: god identity signs in with a fully verified token.
  verifyIdToken.mockReset().mockResolvedValue({ uid: GOD_UID, email: GOD_EMAIL, email_verified: true });
  memberGet.mockReset().mockResolvedValue({ exists: true });
  trustedExactCheck.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  logServerEvent.mockReset();
  runDecodePipeline.mockReset().mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
  decodeStorage.mockReset().mockResolvedValue({});
  legacyRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  killSwitch.mockReset().mockReturnValue(false);
  readDailyUsedForAccount.mockReset().mockResolvedValue(0);
  chargeDailySlotForAccount.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  for (const key of [
    "NEXT_PUBLIC_AUTH_MODE", "PLATFORM_OWNER_UIDS", "PLATFORM_OWNER_EMAILS",
    "NEXT_PUBLIC_PLATFORM_OWNER_UIDS", "NEXT_PUBLIC_PLATFORM_OWNER_EMAILS", "IS_E2E",
    "TRUSTED_EXACT_BOSS_BUSINESS_IDS",
  ]) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("god account server bypass on /api/ai-lookup", () => {
  it("threads god:true into the pipeline for the platform owner, false for a normal member", async () => {
    const { POST } = await import("./route");

    await POST(decodeRequest());
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    expect((runDecodePipeline.mock.calls[0][0] as { god?: boolean }).god).toBe(true);

    runDecodePipeline.mockClear();
    verifyIdToken.mockResolvedValueOnce({ uid: "normal-uid", email: "clerk@example.com" });
    await POST(decodeRequest());
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    expect((runDecodePipeline.mock.calls[0][0] as { god?: boolean }).god).toBe(false);
  });

  it("god bypasses the per-IP rate limit; a non-god identical request is 429'd", async () => {
    legacyRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./route");

    // God: the per-IP limiter is never consulted, and the request proceeds to the pipeline.
    const godRes = await POST(decodeRequest());
    expect(godRes.status).toBe(200);
    expect(legacyRateLimit).not.toHaveBeenCalled();
    expect(runDecodePipeline).toHaveBeenCalledOnce();

    // Non-god, identical: blocked by the same limiter.
    verifyIdToken.mockResolvedValueOnce({ uid: "normal-uid", email: "clerk@example.com" });
    const normalRes = await POST(decodeRequest());
    expect(normalRes.status).toBe(429);
    expect(legacyRateLimit).toHaveBeenCalled();
  });

  it("god bypasses the trusted-exact per-uid rate limiter; a non-god member is still limited", async () => {
    trustedExactCheck.mockReturnValue({ allowed: false, retryAfterMs: 2000 });
    const { POST } = await import("./route");

    // God: the trusted-exact limiter is skipped entirely, so a 429 never fires there.
    const godRes = await POST(decodeRequest());
    expect(godRes.status).toBe(200);
    expect(trustedExactCheck).not.toHaveBeenCalled();

    // Non-god member hitting the same exhausted trusted-exact limiter is 429'd.
    verifyIdToken.mockResolvedValueOnce({ uid: "normal-uid", email: "clerk@example.com" });
    const normalRes = await POST(decodeRequest());
    expect(normalRes.status).toBe(429);
    expect((await normalRes.json()).reasonCode).toBe("trusted_exact_rate_limited");
  });

  it("god bypasses the decode per-account daily cap; a non-god identical request is 429'd account_daily_cap", async () => {
    runDecodePipeline.mockImplementation(async (request: { god?: boolean }) => request.god
      ? { kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false }
      : { kind: "cap_blocked", message: "cap reached", reasonCode: "account_daily_cap" });
    const { POST } = await import("./route");

    const godRes = await POST(decodeRequest());
    expect(godRes.status).toBe(200);
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    // Still threaded as god so the pipeline's own chargePaidSlot never throws the cap either.
    expect((runDecodePipeline.mock.calls[0][0] as { god?: boolean }).god).toBe(true);

    verifyIdToken.mockResolvedValueOnce({ uid: "normal-uid", email: "clerk@example.com" });
    const normalRes = await POST(decodeRequest());
    expect(normalRes.status).toBe(429);
    expect((await normalRes.json()).reasonCode).toBe("account_daily_cap");
  });

  it("god does NOT bypass the kill switch (the owner's own emergency stop stays enforced)", async () => {
    killSwitch.mockReturnValue(true);
    const { POST } = await import("./route");

    const res = await POST(decodeRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).reasonCode).toBe("kill_switch");
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  describe("email arm requires a VERIFIED email (round-1 security fix)", () => {
    beforeEach(() => {
      // Isolate the EMAIL arm: no UID on the allowlist, only the owner's email. Rate limiter blocked so
      // a god (bypass) returns 200 and a non-god returns 429 - a crisp god / not-god signal.
      delete process.env.PLATFORM_OWNER_UIDS;
      process.env.PLATFORM_OWNER_EMAILS = GOD_EMAIL;
      legacyRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    });

    it("a token whose email == owner email but email_verified:false is NOT god", async () => {
      verifyIdToken.mockResolvedValue({ uid: "attacker-uid", email: GOD_EMAIL, email_verified: false });
      const { POST } = await import("./route");
      const res = await POST(decodeRequest());
      expect(res.status).toBe(429); // per-IP limiter applied -> not god
      expect(legacyRateLimit).toHaveBeenCalled();
    });

    it("a token whose email == owner email with email_verified:true IS god", async () => {
      verifyIdToken.mockResolvedValue({ uid: "some-uid", email: GOD_EMAIL, email_verified: true });
      const { POST } = await import("./route");
      const res = await POST(decodeRequest());
      expect(res.status).toBe(200); // bypasses the per-IP limiter -> god
      expect(legacyRateLimit).not.toHaveBeenCalled();
    });

    it("a UID match is god regardless of email_verified (owner uid on the allowlist)", async () => {
      delete process.env.PLATFORM_OWNER_EMAILS;
      process.env.PLATFORM_OWNER_UIDS = GOD_UID;
      verifyIdToken.mockResolvedValue({ uid: GOD_UID, email: GOD_EMAIL, email_verified: false });
      const { POST } = await import("./route");
      const res = await POST(decodeRequest());
      expect(res.status).toBe(200); // uid arm lights up god even with an unverified email
      expect(legacyRateLimit).not.toHaveBeenCalled();
    });
  });

  it("does not light up god from a NEXT_PUBLIC allowlist or a request body flag (server-only truth)", async () => {
    delete process.env.PLATFORM_OWNER_UIDS;
    delete process.env.PLATFORM_OWNER_EMAILS;
    process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS = GOD_UID; // client-visible: must NOT grant god
    legacyRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { POST } = await import("./route");

    // Even the real god uid, when ONLY present in the NEXT_PUBLIC allowlist, is not god server-side.
    const res = await POST(decodeRequest({ isGod: true }));
    expect(res.status).toBe(429); // the per-IP limiter still applies -> not god
    expect(legacyRateLimit).toHaveBeenCalled();
  });

  // S1 (deep review 2026-08-09): god bypasses every spend/rate/cap gate, so a STOLEN owner token that
  // survives session revocation is a direct bill-drain hole. The base verify deliberately stays
  // checkRevoked-free (hot path, every scan pays that round-trip); the god arm re-verifies with
  // checkRevoked=true. Rare, cheap, and it closes the bypass.
  describe("revoked-session hardening on the god arm", () => {
    const revoked = () =>
      Object.assign(new Error("The Firebase ID token has been revoked."), { code: "auth/id-token-revoked" });

    it("a REVOKED god token is 401 token_revoked and never reaches the pipeline", async () => {
      // Hot-path verify (no checkRevoked) still succeeds - exactly the attack: the token is structurally
      // valid, only its SESSION was killed. The revocation is visible only to the checkRevoked re-verify.
      verifyIdToken.mockReset().mockImplementation(async (_token: unknown, checkRevoked?: boolean) => {
        if (checkRevoked) throw revoked();
        return { uid: GOD_UID, email: GOD_EMAIL, email_verified: true };
      });
      const { POST } = await import("./route");

      const res = await POST(decodeRequest());
      expect(res.status).toBe(401);
      expect((await res.json()).reasonCode).toBe("token_revoked");
      expect(runDecodePipeline).not.toHaveBeenCalled();
      // The re-verify really did run with checkRevoked=true.
      expect(verifyIdToken).toHaveBeenCalledWith("token-a", true);
    });

    it("a NORMAL member is NOT put through the extra checkRevoked round-trip (hot path unchanged)", async () => {
      verifyIdToken.mockReset().mockImplementation(async (_token: unknown, checkRevoked?: boolean) => {
        if (checkRevoked) throw revoked();
        return { uid: "normal-uid", email: "clerk@example.com", email_verified: true };
      });
      const { POST } = await import("./route");

      const res = await POST(decodeRequest());
      expect(res.status).toBe(200);
      expect(runDecodePipeline).toHaveBeenCalledOnce();
      expect(verifyIdToken).toHaveBeenCalledTimes(1);
      expect(verifyIdToken).not.toHaveBeenCalledWith("token-a", true);
    });

    it("a god token whose re-verify fails on server auth CONFIG returns 503, not a false 401", async () => {
      verifyIdToken.mockReset().mockImplementation(async (_token: unknown, checkRevoked?: boolean) => {
        if (checkRevoked) throw new Error("Could not load the default credentials");
        return { uid: GOD_UID, email: GOD_EMAIL, email_verified: true };
      });
      const { POST } = await import("./route");

      const res = await POST(decodeRequest());
      expect(res.status).toBe(503);
      expect((await res.json()).reasonCode).toBe("auth_unavailable");
      expect(runDecodePipeline).not.toHaveBeenCalled();
    });
  });
});
