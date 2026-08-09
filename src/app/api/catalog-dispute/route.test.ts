import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Catalog revocation round: route unit tests for POST /api/catalog-dispute, modeled directly on
// src/app/api/catalog-review/[id]/route.test.ts's Admin SDK mock harness. Key behavioral
// difference from catalog-review (platform-only): ANY authenticated user (accessLevelServer ===
// "business" or "platform") may dispute - the whole point is letting shops, not just the owner,
// report a wrong shared identity. The abuse ceiling is the threshold/dedup logic in
// catalogDispute.ts, not tighter auth here.

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  disputeCatalogEntry: vi.fn(),
  memberGet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    doc: () => ({ get: mocks.memberGet }),
  }),
}));

vi.mock("@/server/catalog/catalogDispute", () => ({
  disputeCatalogEntry: mocks.disputeCatalogEntry,
}));

vi.mock("@/server/upc/storage", () => ({
  ladderStorage: async () => ({} as never),
}));

vi.mock("@/services/security/aiSpendGuard", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  intEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
}));

import { POST } from "@/app/api/catalog-dispute/route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/catalog-dispute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { idToken: "firebase-token", normalizedBarcode: "012345678905", businessId: "biz-a", reason: "marked_wrong" };

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "customer-uid", email: "customer@example.com" });
  mocks.disputeCatalogEntry.mockReset().mockResolvedValue({ ok: true, disputeCount: 1, changed: true, verificationStatus: "disputed" });
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  // Default: caller IS a member of "biz-a" (the businessId VALID_BODY claims), matching resolve-scan's
  // membership-check harness default so existing happy-path tests stay green.
  mocks.memberGet.mockReset().mockResolvedValue({ exists: true });
  vi.stubEnv("PLATFORM_OWNER_UIDS", "owner-uid");
  vi.stubEnv("PLATFORM_OWNER_EMAILS", "");
});

describe("POST /api/catalog-dispute request validation", () => {
  it("returns 429 when request-rate limit is exhausted", async () => {
    mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: false, retryAfterMs: 900 });
    const response = await POST(req({ ...VALID_BODY }));
    expect(response.status).toBe(429);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload.reasonCode).toBe("rate_limited");
    expect(payload.error).toMatch(/Too many requests/i);
  });

  // Cross-route rate-limit bucket isolation (ported from the preserved worktree fix,
  // .claude/worktrees/agent-a47380b0deaa5e8d2): this route used to call checkRateLimit(ip, ...)
  // with the BARE client IP, sharing one bucket with every other route calling checkRateLimit
  // with the same bare IP (ai-lookup POST, catalog-review GET, catalog-review/[id] POST) - a
  // burst on one route could 429 an unrelated route for the same client IP even though each
  // route defines its own distinct rate-limit env var. The key must carry a route-family
  // prefix so route A's traffic can never burn route B's limit.
  it("keys the rate limit with a route-family prefix, not the bare client IP", async () => {
    await POST(req({ ...VALID_BODY }));
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    const [key] = mocks.checkRateLimit.mock.calls[0] as [string, unknown];
    expect(key).toMatch(/^CATALOG_DISPUTE:/);
  });

  it("rejects a missing normalizedBarcode with 400", async () => {
    const response = await POST(req({ idToken: "t", businessId: "biz-a" }));
    expect(response.status).toBe(400);
    expect(mocks.disputeCatalogEntry).not.toHaveBeenCalled();
  });

  it("rejects a missing businessId with 400", async () => {
    const response = await POST(req({ idToken: "t", normalizedBarcode: "012345678905" }));
    expect(response.status).toBe(400);
    expect(mocks.disputeCatalogEntry).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON body with 400", async () => {
    const request = new NextRequest("http://localhost:3000/api/catalog-dispute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects an oversized businessId with 400", async () => {
    const response = await POST(req({ idToken: "t", normalizedBarcode: "012345678905", businessId: "b".repeat(129), reason: "marked_wrong" }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/businessId is too long/i);
  });

  it("rejects an oversized normalizedBarcode with 400", async () => {
    const response = await POST(req({ idToken: "t", normalizedBarcode: "0".repeat(65), businessId: "biz-a", reason: "marked_wrong" }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/normalizedBarcode is too long/i);
  });

  it("rejects an oversized reason with 400", async () => {
    const response = await POST(req({ idToken: "t", normalizedBarcode: "012345678905", businessId: "biz-a", reason: "r".repeat(2001) }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/reason is too long/i);
  });
});

describe("POST /api/catalog-dispute auth", () => {
  it("rejects a missing idToken with 401", async () => {
    const response = await POST(req({ normalizedBarcode: "012345678905", businessId: "biz-a" }));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid token with 401", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Invalid token"));
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(401);
  });

  it("returns 503 when server auth is not configured", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Could not load the default credentials"));
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(503);
  });

  // KEY behavioral difference from catalog-review: a plain business-level (non-platform-owner)
  // caller is accepted (200), never 403'd, because any shop may report a wrong shared identity.
  it("accepts a plain business-level caller (does NOT 403 a non-platform-owner)", async () => {
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(200);
    expect(mocks.disputeCatalogEntry).toHaveBeenCalledOnce();
  });

  // SECURITY: catalogEntries has no businessId of its own, but the dispute's abuse ceiling (design
  // §2.1's "3 distinct businesses" threshold and disputedBy attribution) is only meaningful if the
  // caller's token uid is actually a member of the businessId it claims. Without this check, one
  // authenticated account could spam fabricated businessId strings to fake "3 distinct businesses"
  // alone, defeating the human_verified demotion threshold entirely - mirrors resolve-scan's
  // membership check (403 "not_member").
  it("rejects a caller who is NOT a member of the claimed businessId with 403", async () => {
    mocks.memberGet.mockResolvedValue({ exists: false });
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(403);
    expect(mocks.disputeCatalogEntry).not.toHaveBeenCalled();
  });

  it("allows a platformOwner caller to dispute on behalf of any businessId without a membership doc", async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: "owner-uid", email: null });
    mocks.memberGet.mockResolvedValue({ exists: false });
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(200);
    expect(mocks.disputeCatalogEntry).toHaveBeenCalledOnce();
  });
});

describe("POST /api/catalog-dispute not found", () => {
  it("returns 404 when the target doc does not exist", async () => {
    mocks.disputeCatalogEntry.mockResolvedValue({ ok: false, reason: "not_found" });
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/catalog-dispute happy path + idempotency", () => {
  it("calls disputeCatalogEntry with the canonical GTIN, businessId, and reason", async () => {
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, disputeCount: 1, changed: true, verificationStatus: "disputed" });

    expect(mocks.disputeCatalogEntry).toHaveBeenCalledOnce();
    const call = mocks.disputeCatalogEntry.mock.calls[0][0];
    expect(call.businessId).toBe("biz-a");
    expect(call.reason).toBe("marked_wrong");
    // normalizedBarcode 012345678905 -> canonicalGtin strips leading zeros, pads to 14.
    expect(call.canonical).toBe("00012345678905");
  });

  it("two POSTs with the same businessId produce one net disputeCount increment (delegated to disputeCatalogEntry's own idempotency)", async () => {
    mocks.disputeCatalogEntry
      .mockResolvedValueOnce({ ok: true, disputeCount: 1, changed: true, verificationStatus: "disputed" })
      .mockResolvedValueOnce({ ok: true, disputeCount: 1, changed: false });

    const r1 = await POST(req(VALID_BODY));
    const r2 = await POST(req(VALID_BODY));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const p1 = await r1.json();
    const p2 = await r2.json();
    expect(p1.disputeCount).toBe(1);
    expect(p2.disputeCount).toBe(1);
    expect(p2.changed).toBe(false);
    expect(mocks.disputeCatalogEntry).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when normalizedBarcode is not a GTIN-shaped code (canonicalGtin cannot resolve)", async () => {
    const response = await POST(req({ ...VALID_BODY, normalizedBarcode: "not-a-gtin-shape" }));
    expect(response.status).toBe(400);
    expect(mocks.disputeCatalogEntry).not.toHaveBeenCalled();
  });

  it("returns 500 when disputeCatalogEntry reports a genuine error", async () => {
    mocks.disputeCatalogEntry.mockResolvedValue({ ok: false, reason: "error", detail: "firestore down" });
    const response = await POST(req(VALID_BODY));
    expect(response.status).toBe(500);
  });
});
