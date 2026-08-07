import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => ({ uid: "owner-uid" })) }),
  getAdminDb: () => ({
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ exists: true, data: () => ({ role: "owner" }) })),
    })),
    collection: vi.fn(),
    recursiveDelete: vi.fn(async () => undefined),
  }),
}));
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: vi.fn(async () => ({})) }));
vi.mock("@/server/log", () => ({ logServerEvent: vi.fn() }));

const checkRateLimit = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return { ...real, checkRateLimit: (...args: unknown[]) => checkRateLimit(...args) };
});

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
    checkRateLimit.mockReset();
    process.env.IS_E2E = "";
  });

  it("returns 429 with Retry-After when the limiter denies", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 120_000 });
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("keys the limiter on verified identities only (DELETE:<businessId>:<uid>)", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    const { POST } = await import("./route");
    await POST(makeRequest(VALID_BODY));
    expect(checkRateLimit).toHaveBeenCalledWith(
      "DELETE:biz-1:owner-uid",
      expect.objectContaining({ failClosedOnStorageError: true }),
    );
  });

  it("fails closed when limiter storage errors (503, deletion does NOT run)", async () => {
    checkRateLimit.mockRejectedValue(new Error("turso down"));
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });

  it("does not consume the bucket for non-owners (limiter never called)", async () => {
    vi.doMock("@/lib/firebaseAdmin", () => ({
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
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
