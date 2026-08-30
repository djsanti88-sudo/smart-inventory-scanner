import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDecodePipeline = vi.fn();
vi.mock("@/decoding/server/pipeline/pipeline", () => ({
  runDecodePipeline: (...args: unknown[]) => runDecodePipeline(...args),
  e2eMode: () => false,
}));

const resolveTrustedExactBarcodeDecision = vi.fn();
vi.mock("@/decoding/server/knowledge/tire/TireKnowledgeProvider", () => ({
  resolveTrustedExactBarcodeDecision: (...args: unknown[]) => resolveTrustedExactBarcodeDecision(...args),
}));

const getTireExactIndexFingerprint = vi.fn();
const hasBossHmacKeyConfigured = vi.fn(() => true);
vi.mock("@/decoding/server/knowledge/tire/tireExactIndex", () => ({
  getTireExactIndexFingerprint: (...args: unknown[]) => getTireExactIndexFingerprint(...args),
  hasBossHmacKeyConfigured: () => hasBossHmacKeyConfigured(),
}));

const logServerEvent = vi.fn();
vi.mock("@/decoding/server/log", () => ({
  logServerEvent: (...args: unknown[]) => logServerEvent(...args),
}));

const trustedExactCheck = vi.fn();
vi.mock("@/decoding/limits/trustedExactRateLimit", () => ({
  trustedExactRateLimiter: { check: (...args: unknown[]) => trustedExactCheck(...args) },
}));

const verifyIdToken = vi.fn();
const memberGet = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => verifyIdToken(...args) }),
  getAdminDb: () => ({ doc: () => ({ get: (...args: unknown[]) => memberGet(...args) }) }),
}));

const decodeStorage = vi.fn();
vi.mock("@/decoding/server/pipeline/storage", () => ({ decodeStorage: (...args: unknown[]) => decodeStorage(...args) }));

const legacyRateLimit = vi.fn();
const killSwitch = vi.fn();
vi.mock("@/decoding/limits/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/decoding/limits/aiSpendGuard")>();
  return {
    ...actual,
    killSwitchOn: () => killSwitch(),
    checkRateLimit: (...args: unknown[]) => legacyRateLimit(...args),
    readDailyUsedForAccount: vi.fn().mockResolvedValue(0),
    chargeDailySlotForAccount: vi.fn(),
  };
});

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: vi.fn(),
}));

const originalEnv = { ...process.env };
const fingerprint = { schemaVersion: "1.0.0", contentDigest: "A".repeat(64) };

function request(code: string, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    body: JSON.stringify({
      mode: "decode",
      deterministicOnly: true,
      cleanCode: code,
      businessId: "business-a",
      idToken: "token-a",
      ...extra,
    }),
  });
}

function bossHit(code = "3220017438") {
  return {
    kind: "hit" as const,
    sourceScope: "authenticated_boss_corpus" as const,
    result: {
      providerNames: ["tire-corpus"],
      path: "corpus_exact_barcode",
      results: [{
        productName: "Boss exact tire",
        brand: "Blackhawk",
        category: "Tire",
        specsShort: "235/60R18",
        specsFull: "private detail that is not scanner-required",
        primarySku: "BH-2356018",
        primaryBarcode: code,
        gtin: "",
        upc: "",
        ean: "",
        aliases: ["private-alias"],
        sourceUrls: ["https://private.example/evidence"],
        verifiedFacts: ["private fact"],
        guesses: [],
        imageUrl: "",
        productUrl: "",
        confidence: 1,
      }],
      evidences: [{ verified: true, matchedSources: ["private-source"] }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Trusted exact index match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: `trusted-exact:v1:${"B".repeat(32)}`,
        crossCheck: { decision: "single_provider", contradictions: [] },
      },
    },
  };
}

function globalHit(code = "029142337393") {
  const hit = bossHit(code);
  const { trustedExactCanonicalProductId: _privateCanonicalId, ...decision } = hit.result.decision;
  return {
    ...hit,
    sourceScope: "global_corpus" as const,
    result: {
      ...hit.result,
      decision: { ...decision, corroborationPath: "corpus_exact_barcode" },
    },
  };
}

beforeEach(async () => {
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = " business-a , business-b ";
  delete process.env.IS_E2E;
  verifyIdToken.mockReset().mockResolvedValue({ uid: "uid-a", email: "member@example.com" });
  memberGet.mockReset().mockResolvedValue({ exists: true });
  trustedExactCheck.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  resolveTrustedExactBarcodeDecision.mockReset().mockResolvedValue({ kind: "miss" });
  getTireExactIndexFingerprint.mockReset().mockResolvedValue(fingerprint);
  hasBossHmacKeyConfigured.mockReset().mockReturnValue(true);
  logServerEvent.mockReset();
  runDecodePipeline.mockReset().mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
  decodeStorage.mockReset().mockResolvedValue({});
  legacyRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  killSwitch.mockReset().mockReturnValue(false);
});

afterEach(() => {
  for (const key of ["NEXT_PUBLIC_AUTH_MODE", "TRUSTED_EXACT_BOSS_BUSINESS_IDS", "IS_E2E"]) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("authenticated Boss trusted-exact route", () => {
  it("returns an allowlisted exact hit before every legacy/storage/provider seam with a minimal fingerprinted response", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(bossHit());
    const { POST } = await import("./route");

    const response = await POST(request("3220017438"));

    expect(response.status).toBe(200);
    expect(verifyIdToken).toHaveBeenCalledOnce();
    expect(memberGet).toHaveBeenCalledOnce();
    expect(trustedExactCheck).toHaveBeenCalledWith("uid-a", "business-a");
    expect(resolveTrustedExactBarcodeDecision).toHaveBeenCalledWith("3220017438", { authenticatedBossCorpus: true });
    expect(decodeStorage).not.toHaveBeenCalled();
    expect(legacyRateLimit).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toMatchObject({
      mode: "decode",
      providerNames: ["tire-corpus"],
      decision: {
        status: "verified",
        corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: `trusted-exact:v1:${"B".repeat(32)}`,
      },
      trustedExact: { path: "boss_trusted_exact_barcode", index: fingerprint },
    });
    expect(Object.keys(body.results[0]).sort()).toEqual([
      "brand", "category", "confidence", "ean", "gtin", "primaryBarcode", "primarySku",
      "productName", "specsShort", "upc",
    ]);
    expect(body).not.toHaveProperty("evidences");
    expect(body.results[0]).not.toHaveProperty("aliases");
    expect(body.results[0]).not.toHaveProperty("sourceUrls");
  });

  it("returns an authenticated caller's global trusted exact hit before legacy or provider work", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(globalHit());
    killSwitch.mockReturnValueOnce(true);
    const { POST } = await import("./route");

    const response = await POST(request("029142337393"));

    expect(response.status).toBe(200);
    expect(decodeStorage).not.toHaveBeenCalled();
    expect(legacyRateLimit).not.toHaveBeenCalled();
    expect(killSwitch).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toMatchObject({
      decision: { status: "verified", corroborationPath: "corpus_exact_barcode" },
      reasonCode: "trusted_exact_hit",
      trustedExact: { path: "trusted_exact_barcode", index: fingerprint },
    });
    expect(body.decision).not.toHaveProperty("trustedExactCanonicalProductId");
  });

  it("rechecks membership on every request so a revoked member cannot reuse private exact access", async () => {
    resolveTrustedExactBarcodeDecision
      .mockResolvedValueOnce(bossHit())
      .mockResolvedValueOnce({ kind: "miss" });
    memberGet
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: false });
    const { POST } = await import("./route");

    await POST(request("3220017438"));
    const revoked = await POST(request("SAFE-SHORT-MISS"));

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
    expect(revoked.status).toBe(403);
    expect(trustedExactCheck).toHaveBeenCalledOnce();
    expect(resolveTrustedExactBarcodeDecision).toHaveBeenCalledOnce();
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(decodeStorage).not.toHaveBeenCalled();
  });

  it("expires a positive membership after 30 seconds without ever caching the token verification", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(31_001);
    const { POST } = await import("./route");

    await POST(request("SAFE-SHORT-MISS"));
    await POST(request("SAFE-SHORT-MISS"));

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("does not cache membership misses", async () => {
    memberGet.mockResolvedValue({ exists: false });
    const { POST } = await import("./route");

    expect((await POST(request("3220017438"))).status).toBe(403);
    expect((await POST(request("3220017438"))).status).toBe(403);

    expect(verifyIdToken).toHaveBeenCalledTimes(2);
    expect(memberGet).toHaveBeenCalledTimes(2);
  });

  it("keys positive membership by both verified uid and requested business", async () => {
    memberGet
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false });
    const { POST } = await import("./route");

    expect((await POST(request("SAFE-SHORT-MISS"))).status).toBe(200);
    expect((await POST(request("SAFE-SHORT-MISS", { businessId: "business-b" }))).status).toBe(403);
    verifyIdToken.mockResolvedValueOnce({ uid: "uid-b", email: "other@example.com" });
    expect((await POST(request("SAFE-SHORT-MISS"))).status).toBe(403);

    expect(verifyIdToken).toHaveBeenCalledTimes(3);
    expect(memberGet).toHaveBeenCalledTimes(3);
  });

  it("rejects nonmembers, foreign-business membership, and expired tokens before exact access", async () => {
    const { POST } = await import("./route");
    memberGet.mockResolvedValueOnce({ exists: false });
    expect((await POST(request("3220017438"))).status).toBe(403);

    memberGet.mockResolvedValueOnce({ exists: false });
    expect((await POST(request("3220017438", { businessId: "business-b" }))).status).toBe(403);

    verifyIdToken.mockRejectedValueOnce(new Error("Firebase ID token has expired"));
    expect((await POST(request("3220017438"))).status).toBe(401);
    expect(resolveTrustedExactBarcodeDecision).not.toHaveBeenCalled();
    expect(trustedExactCheck).not.toHaveBeenCalled();
  });

  it("boss-for-everyone: an authed member NOT on the allowlist still reaches the server-verified corpus (auth, not the allowlist, grants access)", async () => {
    // Owner 2026-08-07 (Option A full): the allowlist no longer gates access. business-a is NOT in the
    // allowlist (business-b) yet, as a verified member, it still reaches the trusted index. The server
    // ALWAYS derives authenticatedBossCorpus:true from auth - the request body never changes that (this
    // proves capability is server-verified, not client-mintable, and not allowlisted).
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "business-b";
    const { POST } = await import("./route");

    const response = await POST(request("3220017438", { authenticatedBossCorpus: false }));

    expect(response.status).toBe(200);
    // Access granted by auth: the trusted index IS consulted, with server-derived authenticatedBossCorpus.
    expect(resolveTrustedExactBarcodeDecision).toHaveBeenCalledWith("3220017438", { authenticatedBossCorpus: true });
    expect(runDecodePipeline).not.toHaveBeenCalled();
    const body = await response.json();
    // Default mock returns a miss; a deterministic-only miss for a reachable member is trusted_exact_miss.
    expect(body.reasonCode).toBe("trusted_exact_miss");
    expect(body.decision.status).toBe("needs_review");
  });

  it("boss-for-everyone: resolves a boss code to trusted_exact_hit for an authed member who is NOT on the allowlist", async () => {
    // Failing-first (impl-boss-god-rate.md section 1): a non-allowlisted authed business decoding a boss
    // code (8848116004503-shaped fixture) now returns trusted_exact_hit instead of trusted_exact_not_available.
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "business-z"; // business-a is NOT allowlisted
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(bossHit("8848116004503"));
    const { POST } = await import("./route");

    const response = await POST(request("8848116004503"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(resolveTrustedExactBarcodeDecision).toHaveBeenCalledWith("8848116004503", { authenticatedBossCorpus: true });
    expect(body.reasonCode).toBe("trusted_exact_hit");
    expect(body.decision.status).toBe("verified");
    expect(body.trustedExact).toEqual({ path: "boss_trusted_exact_barcode", index: fingerprint });
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("returns trusted_exact_miss for allowlisted deterministic-only misses before all egress", async () => {
    const { POST } = await import("./route");

    const shortMiss = await POST(request("SAFE-SHORT-MISS"));
    const malformedMiss = await POST(request("???"));

    const shortMissBody = await shortMiss.json();
    const malformedMissBody = await malformedMiss.json();
    expect(shortMissBody.reasonCode).toBe("trusted_exact_miss");
    expect(malformedMissBody.reasonCode).toBe("trusted_exact_miss");
    // Fix-wave 2026-08-04: a genuinely checked-and-missed lookup keeps the original path value -
    // this is the one honest-miss case that really did reach the trusted index.
    expect(shortMissBody.trustedExact).toEqual({ path: "trusted_exact_miss" });
    expect(malformedMissBody.trustedExact).toEqual({ path: "trusted_exact_miss" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(decodeStorage).not.toHaveBeenCalled();
    expect(legacyRateLimit).not.toHaveBeenCalled();
  });

  it("boss-for-everyone: a NON-allowlisted authed member's bare-numeric deterministic-only miss now returns trusted_exact_miss (was trusted_exact_not_available)", async () => {
    // Owner 2026-08-07 (Option A full, inverted expectation): the allowlist no longer withholds the
    // trusted path. business-a is authed but NOT allowlisted (business-z); it is now CHECKED against the
    // trusted index and a genuine miss is trusted_exact_miss - not the old "not enabled for this session"
    // not_available. A truly non-authed / mock caller (no authedUid) still gets trusted_exact_not_available.
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "business-z";
    const { POST } = await import("./route");

    const response = await POST(request("8848116004503"));
    const body = await response.json();

    expect(response.status).toBe(200);
    // The code WAS checked against the trusted index (auth grants access under Option A).
    expect(resolveTrustedExactBarcodeDecision).toHaveBeenCalledWith("8848116004503", { authenticatedBossCorpus: true });
    expect(body.reasonCode).toBe("trusted_exact_miss");
    expect(body.decision.status).toBe("needs_review");
    expect(body.trustedExact).toEqual({ path: "trusted_exact_miss" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
    expect(decodeStorage).not.toHaveBeenCalled();
    expect(legacyRateLimit).not.toHaveBeenCalled();
  });

  it("returns trusted_exact_blocked_package for an allowlisted caller's blocked-package outcome", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "blocked_package" });
    const { POST } = await import("./route");

    const response = await POST(request("3220017438"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reasonCode).toBe("blocked_package");
    expect(body.reasonText).toBe("This package barcode requires review.");
    expect(body.decision.status).toBe("needs_review");
    expect(body.trustedExact).toEqual({ path: "trusted_exact_blocked_package" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("returns trusted_exact_unavailable for an allowlisted caller's unavailable-index outcome", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "unavailable" });
    const { POST } = await import("./route");

    const response = await POST(request("3220017438"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reasonCode).toBe("exact_index_unavailable");
    expect(body.reasonText).toBe("Trusted exact lookup requires review.");
    expect(body.trustedExact).toEqual({ path: "trusted_exact_unavailable" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  // Regression for defect #42 (2026-08-06): a live deploy missing BOSS_EXACT_INDEX_HMAC_KEY produced
  // this exact "unavailable" outcome for EVERY allowlisted business's scan, with zero server-side
  // signal distinguishing it from a corrupt-asset failure. The route must now log which class fired.
  it("logs a missing-hmac-key detail when the index is unavailable because the key is not configured", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "unavailable" });
    hasBossHmacKeyConfigured.mockReturnValue(false);
    const { POST } = await import("./route");

    await POST(request("3220017438"));

    expect(logServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/api/ai-lookup",
        event: "trusted_exact_index_unavailable",
        reasonCode: "exact_index_unavailable",
        detail: "missing_hmac_key",
      }),
    );
  });

  it("logs a shard-or-manifest-invalid detail when the key is configured but the asset itself failed", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "unavailable" });
    hasBossHmacKeyConfigured.mockReturnValue(true);
    const { POST } = await import("./route");

    await POST(request("3220017438"));

    expect(logServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "trusted_exact_index_unavailable",
        detail: "shard_or_manifest_invalid",
      }),
    );
  });

  it("L16: a FULL (non-deterministic) decode with the trusted index unavailable FALLS THROUGH to the ladder instead of dead-ending", async () => {
    // Round-1 fix: under Option A every authed user hits the trusted path, so a missing/rotated HMAC key
    // or failed shard SHA (kind:"unavailable") must NOT short-circuit every customer's decode to Needs
    // Review. A non-deterministic decode must continue to the full ladder (runDecodePipeline).
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "unavailable" });
    const { POST } = await import("./route");

    const response = await POST(request("8848116004503", { deterministicOnly: false }));

    // Reached the ladder rather than returning a terminal trusted_exact_unavailable body.
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body.reasonCode).not.toBe("exact_index_unavailable");
    // The unavailability was still logged (observability preserved).
    expect(logServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "trusted_exact_index_unavailable" }),
    );
  });

  it("deterministicOnly PROBE still returns the honest trusted_exact_unavailable signal when the index is unavailable", async () => {
    // The probe path is unchanged: it must report the honest signal (client work-reduction relies on it),
    // even though the full-decode path now falls through (test above).
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce({ kind: "unavailable" });
    const { POST } = await import("./route");

    const response = await POST(request("8848116004503")); // deterministicOnly:true by default
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reasonCode).toBe("exact_index_unavailable");
    expect(body.trustedExact).toEqual({ path: "trusted_exact_unavailable" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("returns trusted_exact_unavailable when a hit's index fingerprint cannot be verified", async () => {
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(bossHit());
    getTireExactIndexFingerprint.mockResolvedValueOnce(null);
    const { POST } = await import("./route");

    const response = await POST(request("3220017438"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reasonCode).toBe("exact_index_unavailable");
    expect(body.reasonText).toBe("Trusted exact index verification is unavailable.");
    expect(body.trustedExact).toEqual({ path: "trusted_exact_unavailable" });
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("throttles before both exact hits and misses", async () => {
    trustedExactCheck.mockReturnValueOnce({ allowed: false, retryAfterMs: 2_000 });
    resolveTrustedExactBarcodeDecision.mockResolvedValueOnce(bossHit());
    const { POST } = await import("./route");

    const response = await POST(request("3220017438"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(resolveTrustedExactBarcodeDecision).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });
});
