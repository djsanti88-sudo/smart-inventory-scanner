import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/sync-database/cloud/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => ({ uid: "owner-uid" })) }),
  getAdminDb: () => ({
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ exists: true, data: () => ({ role: "owner" }) })),
    })),
    collection: vi.fn(),
    recursiveDelete: vi.fn(async () => undefined),
  }),
}));
vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/decoding/server/log", () => ({ logServerEvent: vi.fn() }));

const checkAccountDeleteRateLimit = vi.fn();
vi.mock("@/users-businesses/account/accountDeleteRateLimit", () => ({
  checkAccountDeleteRateLimit: (...args: unknown[]) => checkAccountDeleteRateLimit(...args),
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/delete", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_BODY = { businessId: "biz-1", idToken: "tok", confirmPhrase: "DELETE MY ACCOUNT" };

describe("delete route rate limiting", () => {
  beforeEach(() => {
    vi.resetModules();
    checkAccountDeleteRateLimit.mockReset();
    process.env.IS_E2E = "";
  });

  it("returns 429 with Retry-After when the limiter denies", async () => {
    checkAccountDeleteRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 120_000 });
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("keys the limiter on verified identities only (DELETE:<businessId>:<uid>) with the configured window", async () => {
    checkAccountDeleteRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    const { POST } = await import("./route");
    await POST(makeRequest(VALID_BODY));
    expect(checkAccountDeleteRateLimit).toHaveBeenCalledWith(
      "DELETE:biz-1:owner-uid",
      expect.objectContaining({ limit: 3, windowMs: 3_600_000 }),
    );
  });

  it("fails closed when the Firestore-backed limiter errors (503, deletion does NOT run)", async () => {
    checkAccountDeleteRateLimit.mockRejectedValue(new Error("firestore down"));
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });

  it("does not consume the bucket for non-owners (limiter never called)", async () => {
    vi.doMock("@/sync-database/cloud/firebaseAdmin", () => ({
      getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => ({ uid: "counter-uid" })) }),
      getAdminDb: () => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: true, data: () => ({ role: "counter" }) })),
        })),
        collection: vi.fn(),
        recursiveDelete: vi.fn(),
      }),
    }));
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(checkAccountDeleteRateLimit).not.toHaveBeenCalled();
  });
});
