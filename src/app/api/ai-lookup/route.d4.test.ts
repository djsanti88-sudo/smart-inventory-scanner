import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __resetTrustedExactMembershipCacheForTest } from "@/services/security/trustedExactMembershipCache";

// MANDATORY pipeline mock: the route must reach its auth/policy gates deterministically with zero
// pipeline/provider work, and e2eMode must report false or the live-mode gates are skipped entirely.
const runDecodePipeline = vi.fn();
const tryTrustedExactDecode = vi.fn();
const deriveTrustedExactAccessForVerifiedRoute = vi.fn();
const routeCapability = Object.freeze({ routeOnly: true });
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...a: unknown[]) => runDecodePipeline(...a),
  tryTrustedExactDecode: (...a: unknown[]) => tryTrustedExactDecode(...a),
  deriveTrustedExactAccessForVerifiedRoute: (...a: unknown[]) => deriveTrustedExactAccessForVerifiedRoute(...a),
  e2eMode: () => false,
}));
const trustedExactCheck = vi.fn();
vi.mock("@/services/security/trustedExactRateLimit", () => ({
  trustedExactRateLimiter: { check: (...a: unknown[]) => trustedExactCheck(...a) },
  maskTrustedExactIdentifier: (value: string) => value.length <= 3 ? "***" : `${value.slice(0, 3)}...${value.slice(-3)}`,
}));
const isPlatformOwnerServer = vi.fn();
vi.mock("@/services/security/roleAccess", () => ({
  isPlatformOwnerServer: (...a: unknown[]) => isPlatformOwnerServer(...a),
}));
const getTireExactIndexFingerprint = vi.fn();
vi.mock("@/server/tire-knowledge/tireExactIndex", () => ({
  getTireExactIndexFingerprint: (...a: unknown[]) => getTireExactIndexFingerprint(...a),
}));
const ladderStorage = vi.fn();
vi.mock("@/server/upc/storage", () => ({ ladderStorage: (...a: unknown[]) => ladderStorage(...a) }));
const appendMasterCatalogEntry = vi.fn();
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: vi.fn(),
  appendMasterCatalogEntry: (...a: unknown[]) => appendMasterCatalogEntry(...a),
}));
const logServerEvent = vi.fn();
vi.mock("@/server/log", () => ({ logServerEvent: (...a: unknown[]) => logServerEvent(...a) }));
const readDailyUsedForAccount = vi.fn();
const chargeDailySlotForAccount = vi.fn();
const killSwitchOn = vi.fn();
const checkRateLimit = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...orig,
    killSwitchOn: () => killSwitchOn(),
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    readDailyUsedForAccount: (...a: unknown[]) => readDailyUsedForAccount(...a),
    chargeDailySlotForAccount: (...a: unknown[]) => chargeDailySlotForAccount(...a),
  };
});
const memberGet = vi.fn();
const adminDoc = vi.fn((path: unknown) => {
  void path;
  return { get: memberGet };
});
const verifyIdToken = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: (...a: unknown[]) => verifyIdToken(...a) }),
  getAdminDb: () => ({ doc: (path: unknown) => adminDoc(path) }),
}));

const ORIG = { ...process.env };
beforeEach(() => {
  __resetTrustedExactMembershipCacheForTest();
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  delete process.env.IS_E2E;
  delete process.env.AI_LIVE_SCAN_CONTEXT;
  delete process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT;
  delete process.env.PLATFORM_OWNER_EMAILS;
  delete process.env.PLATFORM_OWNER_UIDS;
  delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  delete process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS;
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS;
  delete process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  delete process.env.NEXT_PUBLIC_BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
  delete process.env.VERCEL_ENV;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  runDecodePipeline.mockReset().mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
  tryTrustedExactDecode.mockReset().mockResolvedValue(null);
  deriveTrustedExactAccessForVerifiedRoute.mockReset().mockImplementation((verified: boolean) => verified ? routeCapability : undefined);
  trustedExactCheck.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  isPlatformOwnerServer.mockReset().mockReturnValue(false);
  getTireExactIndexFingerprint.mockReset().mockResolvedValue({ schemaVersion: 1, contentDigest: "digest" });
  ladderStorage.mockReset().mockResolvedValue({});
  appendMasterCatalogEntry.mockReset();
  logServerEvent.mockReset();
  killSwitchOn.mockReset().mockReturnValue(false);
  checkRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  verifyIdToken.mockReset().mockResolvedValue({ uid: "u1", email: "a@b.co", exp: Math.floor(Date.now() / 1_000) + 3_600 });
  adminDoc.mockClear();
  memberGet.mockReset().mockResolvedValue({ exists: true });
  readDailyUsedForAccount.mockReset().mockResolvedValue(0);
  chargeDailySlotForAccount.mockReset().mockResolvedValue(1);
});
afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.IS_E2E = ORIG.IS_E2E;
  process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = ORIG.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = ORIG.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
  process.env.PLATFORM_OWNER_EMAILS = ORIG.PLATFORM_OWNER_EMAILS;
  process.env.PLATFORM_OWNER_UIDS = ORIG.PLATFORM_OWNER_UIDS;
  process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS = ORIG.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS;
  process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS = ORIG.NEXT_PUBLIC_PLATFORM_OWNER_UIDS;
  process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS = ORIG.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  process.env.NEXT_PUBLIC_BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = ORIG.NEXT_PUBLIC_BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS;
  process.env.VERCEL_ENV = ORIG.VERCEL_ENV;
  process.env.FIREBASE_PROJECT_ID = ORIG.FIREBASE_PROJECT_ID;
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = ORIG.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
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
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("membership gate runs BEFORE any quota read/charge (403, zero per-account key touches)", async () => {
    memberGet.mockResolvedValue({ exists: false }); // authed member of A, sent businessId "B"
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(403);
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled();
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("verifies every token but reuses a positive membership read for the same uid and business", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");

    await POST(decodeReq());
    await POST(decodeReq());

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledOnce();
  });

  it("reverifies the token on every warm deterministic exact request while caching only membership", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");

    await POST(decodeReq({ deterministicOnly: true }));
    await POST(decodeReq({ deterministicOnly: true }));

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledOnce();
    expect(tryTrustedExactDecode).toHaveBeenCalledTimes(2);
  });

  it("does not reuse deterministic authorization for another business", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");

    await POST(decodeReq({ deterministicOnly: true }));
    memberGet.mockResolvedValueOnce({ exists: false });
    const response = await POST(decodeReq({ deterministicOnly: true, businessId: "b2" }));

    expect(response.status).toBe(403);
    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
  });

  it("does not cache an absent membership", async () => {
    memberGet.mockResolvedValue({ exists: false });
    const { POST } = await import("./route");

    await expect(POST(decodeReq())).resolves.toMatchObject({ status: 403 });
    await expect(POST(decodeReq())).resolves.toMatchObject({ status: 403 });

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
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

  // FINDING B (P6 fix wave): the per-account DECODE charge moved OUT of this route and INTO the
  // pipeline's chargePaidSlot (charged together with the global slot, at one exception-consistent site).
  // The route therefore no longer post-charges the account on the decode path - it delegates BOTH charges
  // to runDecodePipeline. With the pipeline mocked here, the route must NOT call chargeDailySlotForAccount
  // regardless of paidComputeCharged (charge symmetry is proven end-to-end in route.chargeSymmetry.test.ts
  // and the real-counter happy path in route.a2.test.ts).
  it("decode route delegates the per-account charge to the pipeline (never post-charges it here)", async () => {
    const { POST } = await import("./route");
    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
    await POST(decodeReq());
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled(); // free rung-0 hit: pipeline charged nothing

    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: true });
    await POST(decodeReq());
    // Even on a genuine paid compute, the ROUTE does not charge the account - the pipeline already did,
    // inside chargePaidSlot, alongside the global charge. No double-charge, no route-level post-charge.
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled();
  });

  it("derives an opaque capability only from verified membership plus the server allowlist", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");
    await POST(decodeReq({ authenticatedBossCorpus: false, deterministicOnly: false }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(true);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), routeCapability);

    tryTrustedExactDecode.mockReset().mockResolvedValue(null);
    deriveTrustedExactAccessForVerifiedRoute.mockClear();
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "other-business";
    await POST(decodeReq({ authenticatedBossCorpus: true }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(false);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("grants a valid member from the trimmed legacy server-only allowlist", async () => {
    process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = "  b1  ";
    const { POST } = await import("./route");

    await POST(decodeReq());

    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(true);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), routeCapability);
  });

  it("grants only nonce-scoped certification members on the hardcoded Firebase Preview target", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.FIREBASE_PROJECT_ID = "smart-inventory-preview";
    const { POST } = await import("./route");

    await POST(decodeReq({ businessId: "boss-preview-20260803-n5vj6nxl7-014-lane-00" }));

    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(true);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), routeCapability);
  });

  it("never grants the certification namespace outside the hardcoded Firebase Preview target", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.FIREBASE_PROJECT_ID = "smart-inventory-preview";
    const { POST } = await import("./route");

    await POST(decodeReq({ businessId: "boss-preview-20260803-n5vj6nxl7-014-lane-00" }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenLastCalledWith(false);

    deriveTrustedExactAccessForVerifiedRoute.mockClear();
    process.env.VERCEL_ENV = "preview";
    process.env.FIREBASE_PROJECT_ID = "smart-inventory-scanner-app";
    await POST(decodeReq({ businessId: "boss-preview-20260803-n5vj6nxl7-014-lane-00" }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenLastCalledWith(false);
  });

  it("accepts the union of the new and legacy server-only allowlists", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "new-business";
    process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = "legacy-business";
    const { POST } = await import("./route");

    await POST(decodeReq({ businessId: "new-business" }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenLastCalledWith(true);

    await POST(decodeReq({ businessId: "legacy-business" }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenLastCalledWith(true);
  });

  it("ignores an empty legacy allowlist without granting access", async () => {
    process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = " ,  , ";
    const { POST } = await import("./route");

    await POST(decodeReq());

    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(false);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("does not let NEXT_PUBLIC legacy/new variables or matching body fields grant trusted access", async () => {
    process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    process.env.NEXT_PUBLIC_BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");

    await POST(decodeReq({
      TRUSTED_EXACT_BOSS_BUSINESS_IDS: "b1",
      BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS: "b1",
      authenticatedBossCorpus: true,
      trustedExactAccess: true,
    }));

    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(false);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("does not let legacy allowlisting bypass verified business membership", async () => {
    process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = "b1";
    memberGet.mockResolvedValue({ exists: false });
    const { POST } = await import("./route");

    const response = await POST(decodeReq());

    expect(response.status).toBe(403);
    expect(deriveTrustedExactAccessForVerifiedRoute).not.toHaveBeenCalled();
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
  });

  it("returns deterministic-only decode misses before the legacy pipeline can reach external work", async () => {
    const { POST } = await import("./route");
    runDecodePipeline.mockResolvedValueOnce({ kind: "computed", payload: { mode: "decode", debug: {}, decision: { status: "needs_review" } }, cached: false, paidComputeCharged: false });
    const response = await POST(decodeReq({ deterministicOnly: true }));
    expect(response.status).toBe(200);
    expect(runDecodePipeline).toHaveBeenCalledWith(expect.objectContaining({ deterministicOnly: true }));
  });

  it.each(["0000000000000", "1234567890123"])("keeps an unindexed malformed or placeholder-shaped deterministic request local (%s)", async (cleanCode) => {
    const { POST } = await import("./route");
    const response = await POST(decodeReq({ cleanCode, deterministicOnly: true }));

    expect(response.status).toBe(200);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.objectContaining({ code: cleanCode }), undefined);
    expect(runDecodePipeline).toHaveBeenCalledWith(expect.objectContaining({ code: cleanCode, deterministicOnly: true }));
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it.each([undefined, "lookup"])("rejects deterministicOnly for normalized non-decode mode %s before downstream work", async (mode) => {
    const { POST } = await import("./route");
    const response = await POST(decodeReq({ mode, deterministicOnly: true }));
    expect(response.status).toBe(400);
    expect((await response.json()).reasonCode).toBe("invalid_deterministic_mode");
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("validates businessId before any Admin identity or document-path use", async () => {
    const { POST } = await import("./route");
    const response = await POST(decodeReq({ businessId: "bad/id" }));
    expect(response.status).toBe(400);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(adminDoc).not.toHaveBeenCalled();
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
  });

  it("lets a verified platform owner attempt trusted exact before membership rejection", async () => {
    memberGet.mockResolvedValue({ exists: false });
    isPlatformOwnerServer.mockReturnValue(true);
    tryTrustedExactDecode.mockResolvedValue({
      kind: "computed",
      payload: { decision: { status: "verified" }, debug: {}, results: [{ productName: "Known tire" }] },
      cached: false,
      paidComputeCharged: false,
    });
    const { POST } = await import("./route");
    const response = await POST(decodeReq());
    expect(response.status).toBe(200);
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(true);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), routeCapability);
  });

  it("returns the existing 403 after a platform-owner exact miss without membership, before AI controls", async () => {
    memberGet.mockResolvedValue({ exists: false });
    isPlatformOwnerServer.mockReturnValue(true);
    const { POST } = await import("./route");
    const response = await POST(decodeReq());
    expect(response.status).toBe(403);
    expect((await response.json()).reasonCode).toBe("not_member");
    expect(tryTrustedExactDecode).toHaveBeenCalledOnce();
    expect(killSwitchOn).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("reverifies a platform-owner nonmember token on deterministic exact misses", async () => {
    memberGet.mockResolvedValue({ exists: false });
    isPlatformOwnerServer.mockReturnValue(true);
    const { POST } = await import("./route");

    const first = await POST(decodeReq({ deterministicOnly: true }));
    const second = await POST(decodeReq({ deterministicOnly: true }));

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "bad/id,also-good"])("fails closed for server allowlist %s despite body and NEXT_PUBLIC spoofing", async (allowlist) => {
    if (allowlist === undefined) delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
    else process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = allowlist;
    process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS = "u1";
    process.env.NEXT_PUBLIC_TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    const { POST } = await import("./route");
    await POST(decodeReq({ authenticatedBossCorpus: true, platformOwner: true, trustedExactAccess: true }));
    expect(deriveTrustedExactAccessForVerifiedRoute).toHaveBeenCalledWith(false);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("applies the trusted scanner limiter before an allowlisted exact hit and all downstream work", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    killSwitchOn.mockReturnValue(true);
    tryTrustedExactDecode.mockResolvedValue({
      kind: "computed",
      payload: { decision: { status: "verified" }, debug: {}, results: [{ productName: "Known tire" }] },
      cached: false,
      paidComputeCharged: false,
    });
    const { POST } = await import("./route");
    const response = await POST(decodeReq());
    expect(response.status).toBe(200);
    expect(trustedExactCheck).toHaveBeenCalledWith("u1", "b1");
    expect(killSwitchOn).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  it("throttles authorized exact aliases without provider or storage calls", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    let trustedAttempts = 0;
    trustedExactCheck.mockImplementation(() => ({
      allowed: ++trustedAttempts <= 600,
      retryAfterMs: 60_000,
    }));
    tryTrustedExactDecode.mockResolvedValue({
      kind: "computed",
      payload: { decision: { status: "verified" }, debug: {}, results: [{ productName: "Known tire" }] },
      cached: false,
      paidComputeCharged: false,
    });
    const { POST } = await import("./route");

    for (let scan = 0; scan < 600; scan += 1) {
      const response = await POST(decodeReq({ cleanCode: `000000000${scan}` }));
      expect(response.status).toBe(200);
    }
    await expect(POST(decodeReq({ cleanCode: "000000000600" }))).resolves.toMatchObject({ status: 429 });

    expect(trustedExactCheck).toHaveBeenCalledTimes(601);
    expect(tryTrustedExactDecode).toHaveBeenCalledTimes(600);
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("returns trusted limiter Retry-After and logs only a masked business identifier", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "business-secret";
    trustedExactCheck.mockReturnValue({ allowed: false, retryAfterMs: 2_001 });
    const { POST } = await import("./route");
    const response = await POST(decodeReq({ businessId: "business-secret" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    const logged = JSON.stringify(logServerEvent.mock.calls);
    expect(logged).toContain("bus...ret");
    expect(logged).not.toContain("business-secret");
    expect(tryTrustedExactDecode).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
  });

  it("whitelists the exact fingerprint fields on authenticated verified exact hits", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
    getTireExactIndexFingerprint.mockResolvedValue({ schemaVersion: 7, contentDigest: "safe", keys: ["secret"], sourcePath: "private" });
    tryTrustedExactDecode.mockResolvedValue({
      kind: "computed",
      payload: { decision: { status: "verified" }, debug: {}, results: [] },
      cached: false,
      paidComputeCharged: false,
    });
    const { POST } = await import("./route");
    const json = await (await POST(decodeReq())).json();
    expect(json.debug.trustedExactIndex).toEqual({ schemaVersion: 7, contentDigest: "safe" });
  });

  it.each(["blocked_package", "exact_index_unavailable"])("returns %s before every normal downstream path", async (reasonCode) => {
    tryTrustedExactDecode.mockResolvedValue({
      kind: "computed",
      payload: { decision: { status: "needs_review", reasonCode }, debug: {}, results: [] },
      cached: false,
      paidComputeCharged: false,
    });
    const { POST } = await import("./route");
    const response = await POST(decodeReq());
    expect(response.status).toBe(200);
    expect((await response.json()).decision.reasonCode).toBe(reasonCode);
    expect(killSwitchOn).not.toHaveBeenCalled();
    expect(ladderStorage).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  it("preserves ordinary member miss parity through the existing AI controls and pipeline", async () => {
    const { POST } = await import("./route");
    const response = await POST(decodeReq());
    expect(response.status).toBe(200);
    expect(tryTrustedExactDecode).toHaveBeenCalledWith(expect.any(Object), undefined);
    expect(checkRateLimit).toHaveBeenCalledOnce();
    expect(runDecodePipeline).toHaveBeenCalledWith(expect.objectContaining({
      capContext: { authedBusinessId: "b1", accountCapCleared: true },
      trustedExactAccess: undefined,
    }));
  });
});
