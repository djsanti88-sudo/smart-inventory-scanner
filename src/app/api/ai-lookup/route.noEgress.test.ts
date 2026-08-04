import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The trusted exact pipeline boundary is proven with the real pipeline in pipeline.noEgress.test.ts.
// This companion loads the real route with the route-only master-catalog write seam trapped before import.
const harness = vi.hoisted(() => {
  const counts: Record<string, number> = {};
  const trap = (name: string) => () => {
    counts[name] = (counts[name] ?? 0) + 1;
    throw new Error(`no-egress route seam invoked: ${name}`);
  };
  const reset = () => Object.keys(counts).forEach((key) => delete counts[key]);
  return { counts, trap, reset, tryTrustedExactDecode: vi.fn(), deriveTrustedExactAccessForVerifiedRoute: vi.fn(), verifyIdToken: vi.fn(), memberGet: vi.fn(), exactRateCheck: vi.fn() };
});

vi.mock("@/server/decode/pipeline", () => ({
  tryTrustedExactDecode: (...args: unknown[]) => harness.tryTrustedExactDecode(...args),
  runDecodePipeline: harness.trap("pipeline_fallback"),
  deriveTrustedExactAccessForVerifiedRoute: (...args: unknown[]) => harness.deriveTrustedExactAccessForVerifiedRoute(...args),
  e2eMode: () => false,
}));
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: harness.trap("build_master_catalog_entry"),
  appendMasterCatalogEntry: harness.trap("append_master_catalog_entry"),
}));
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => harness.verifyIdToken(...args) }),
  getAdminDb: () => ({ doc: () => ({ get: (...args: unknown[]) => harness.memberGet(...args) }) }),
}));
vi.mock("@/services/security/trustedExactRateLimit", () => ({
  trustedExactRateLimiter: { check: (...args: unknown[]) => harness.exactRateCheck(...args) },
  maskTrustedExactIdentifier: () => "masked",
}));
vi.mock("@/services/security/roleAccess", () => ({ isPlatformOwnerServer: () => false }));
vi.mock("@/server/tire-knowledge/tireExactIndex", () => ({ getTireExactIndexFingerprint: vi.fn().mockResolvedValue({ schemaVersion: 1, contentDigest: "safe" }) }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: harness.trap("ladder_storage") }));
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return { ...actual, killSwitchOn: harness.trap("kill_switch"), checkRateLimit: harness.trap("rate_limit"), readDailyUsedForAccount: harness.trap("account_cap"), chargeDailySlotForAccount: harness.trap("account_charge") };
});
vi.mock("@/server/log", () => ({ logServerEvent: harness.trap("telemetry") }));

import { POST } from "./route";

function verifiedExactOutcome() {
  return {
    kind: "computed" as const,
    cached: false,
    paidComputeCharged: false,
    payload: {
      mode: "decode" as const, providerNames: ["tire-corpus"], results: [{ productName: "Boss Roadmaster 235/60R18" }], evidences: [], providerStatuses: [],
      decision: { status: "verified", confidence: 1, reason: "exact", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, corroborationPath: "boss_trusted_exact_barcode", trustedExactCanonicalProductId: "trusted-exact:00012345678905", crossCheck: { decision: "single_provider", confidence: 1, reason: "exact", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] } },
      reasonCode: "ok", reasonText: "", timedOut: false,
      debug: { corroborationPath: "boss_trusted_exact_barcode", aiCalled: false, pageFetched: false },
      sanitizedInput: { rawCodeSanitized: "012345678905", cleanCodeSanitized: "012345678905" },
    },
  };
}

beforeEach(() => {
  harness.reset();
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "b1";
  harness.verifyIdToken.mockReset().mockResolvedValue({ uid: "u1", email: "owner@example.invalid" });
  harness.memberGet.mockReset().mockResolvedValue({ exists: true });
  harness.exactRateCheck.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  harness.deriveTrustedExactAccessForVerifiedRoute.mockReset().mockReturnValue(Object.freeze({}));
  harness.tryTrustedExactDecode.mockReset().mockResolvedValue(verifiedExactOutcome());
});
afterEach(() => {
  delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
});

describe("trusted exact route master-append no-egress proof", () => {
  it("returns an authenticated verified Boss hit without scheduling master-catalog append or downstream egress", async () => {
    const response = await POST(new Request("http://x/api/ai-lookup", { method: "POST", body: JSON.stringify({ mode: "decode", rawCode: "012345678905", cleanCode: "012345678905", idToken: "token", businessId: "b1" }) }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ decision: { status: "verified", corroborationPath: "boss_trusted_exact_barcode", trustedExactCanonicalProductId: "trusted-exact:00012345678905" } });
    expect(harness.tryTrustedExactDecode).toHaveBeenCalledOnce();
    expect(harness.counts).toEqual({});
  });

  it("negative controls prove the trapped route-only seams increment and throw", () => {
    for (const name of ["build_master_catalog_entry", "append_master_catalog_entry", "pipeline_fallback", "ladder_storage", "kill_switch", "rate_limit", "account_cap", "account_charge", "telemetry"]) {
      expect(() => harness.trap(name)()).toThrow(`no-egress route seam invoked: ${name}`);
      expect(harness.counts[name]).toBe(1);
    }
  });
});
