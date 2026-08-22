import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Task 3: route unit tests for POST /api/catalog-review/[id] (approve/reject a pending catalogEntries
// doc). Mocks the Admin SDK the same way src/app/api/account/delete/route.test.ts does.

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  docExists: true,
  updateCalls: [] as Array<{ path: string; payload: Record<string, unknown> }>,
  setCalls: [] as Array<{ path: string; payload: Record<string, unknown>; opts?: Record<string, unknown> }>,
  queriedPaths: [] as string[],
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => {
    function makeDoc(path: string) {
      mocks.queriedPaths.push(path);
      return {
        __path: path,
        get: async () => ({ exists: mocks.docExists }),
        update: async (payload: Record<string, unknown>) => {
          mocks.updateCalls.push({ path, payload });
        },
        set: async (payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
          mocks.setCalls.push({ path, payload, opts });
        },
        collection: (subName: string) => ({
          doc: (subId: string) => makeDoc(`${path}/${subName}/${subId}`),
        }),
      };
    }
    return {
      collection: (path: string) => ({
        doc: (id: string) => makeDoc(`${path}/${id}`),
      }),
      batch: () => {
        const ops: Array<{ kind: "update" | "set"; path: string; payload: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
        return {
          update: (ref: { __path: string }, payload: Record<string, unknown>) => {
            ops.push({ kind: "update", path: ref.__path, payload });
          },
          set: (ref: { __path: string }, payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
            ops.push({ kind: "set", path: ref.__path, payload, opts });
          },
          commit: async () => {
            for (const op of ops) {
              if (op.kind === "update") mocks.updateCalls.push({ path: op.path, payload: op.payload });
              else mocks.setCalls.push({ path: op.path, payload: op.payload, opts: op.opts });
            }
          },
        };
      },
    };
  },
}));

vi.mock("@/server/decode/storage", () => ({
  decodeStorage: async () => ({} as never),
}));

vi.mock("@/services/security/aiSpendGuard", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  intEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    arrayUnion: (...values: unknown[]) => ({ __op: "arrayUnion", values }),
    increment: (n: number) => ({ __op: "increment", n }),
  },
}));

import { POST } from "@/app/api/catalog-review/[id]/route";

function actionRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/catalog-review/gtin_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const VALID_BODY = { idToken: "firebase-token", action: "approve" as const };

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "owner-uid", email: "owner@example.com" });
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  mocks.docExists = true;
  mocks.updateCalls = [];
  mocks.setCalls = [];
  mocks.queriedPaths = [];
  vi.stubEnv("PLATFORM_OWNER_UIDS", "owner-uid");
  vi.stubEnv("PLATFORM_OWNER_EMAILS", "");
});

describe("POST /api/catalog-review/[id] request validation", () => {
  it("rejects a missing id with 400", async () => {
    const response = await POST(actionRequest(VALID_BODY), ctx(""));
    expect(response.status).toBe(400);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const request = new NextRequest("http://localhost:3000/api/catalog-review/gtin_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await POST(request, ctx("gtin_1"));
    expect(response.status).toBe(400);
  });

  it("rejects an action that is not approve/reject with 400", async () => {
    const response = await POST(actionRequest({ idToken: "t", action: "delete" }), ctx("gtin_1"));
    expect(response.status).toBe(400);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("rejects an oversized catalog entry id with 400", async () => {
    const response = await POST(actionRequest({ idToken: "t", action: "approve" }), ctx("x".repeat(257)));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/Catalog entry id is too long/i);
  });
});

describe("POST /api/catalog-review/[id] rate limit", () => {
  it("returns 429 when rate limit is exceeded", async () => {
    mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: false, retryAfterMs: 900 });
    const response = await POST(actionRequest({ idToken: "t", action: "approve" }), ctx("gtin_1"));
    expect(response.status).toBe(429);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload.reasonCode).toBe("rate_limited");
    expect(payload.error).toMatch(/Too many requests/i);
  });

  // Cross-route rate-limit bucket isolation (ported from the preserved worktree fix,
  // .claude/worktrees/agent-a47380b0deaa5e8d2): this route used to call checkRateLimit(ip, ...)
  // with the BARE client IP, sharing one bucket with every other route calling checkRateLimit
  // with the same bare IP (ai-lookup POST, catalog-dispute POST, catalog-review GET) - a burst
  // on one route could 429 an unrelated route for the same client IP even though each route
  // defines its own distinct rate-limit env var. The key must carry a route-family prefix so
  // route A's traffic can never burn route B's limit.
  it("keys the rate limit with a route-family prefix, not the bare client IP", async () => {
    await POST(actionRequest({ idToken: "t", action: "approve" }), ctx("gtin_1"));
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    const [key] = mocks.checkRateLimit.mock.calls[0] as [string, unknown];
    expect(key).toMatch(/^CATALOG_REVIEW_ID:/);
  });
});

describe("POST /api/catalog-review/[id] auth", () => {
  it("rejects a missing idToken with 401", async () => {
    const response = await POST(actionRequest({ action: "approve" }), ctx("gtin_1"));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid token with 401", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Invalid token"));
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_1"));
    expect(response.status).toBe(401);
  });

  it("returns 503 when server auth is not configured", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Could not load the default credentials"));
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_1"));
    expect(response.status).toBe(503);
  });

  it("rejects a non-platform-owner caller with 403 and performs no mutation", async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: "customer-uid", email: "customer@example.com" });
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_1"));
    expect(response.status).toBe(403);
    expect(mocks.updateCalls).toHaveLength(0);
  });
});

describe("POST /api/catalog-review/[id] not found", () => {
  it("returns 404 when the entry does not exist", async () => {
    mocks.docExists = false;
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_missing"));
    expect(response.status).toBe(404);
    expect(mocks.updateCalls).toHaveLength(0);
  });
});

describe("POST /api/catalog-review/[id] approve mutation shape", () => {
  it("sets verificationStatus verified, provenanceTier human_verified, verifiedBy on the PUBLIC parent doc, and writes auditLog to the LOCKED moderation subcollection doc (never the parent)", async () => {
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, id: "gtin_1", verificationStatus: "verified" });

    expect(mocks.updateCalls).toHaveLength(1);
    const call = mocks.updateCalls[0];
    expect(call.path).toBe("catalogEntries/gtin_1");
    expect(call.payload.verificationStatus).toBe("verified");
    expect(call.payload.provenanceTier).toBe("human_verified");
    expect(call.payload.verifiedBy).toBe("owner@example.com");
    // M1 spec 1: auditLog must NEVER be part of the public parent doc's update payload.
    expect(call.payload).not.toHaveProperty("auditLog");

    expect(mocks.setCalls).toHaveLength(1);
    const modCall = mocks.setCalls[0];
    expect(modCall.path).toBe("catalogEntries/gtin_1/moderation/log");
    expect(modCall.opts).toMatchObject({ merge: true });
    expect(modCall.payload.auditLog).toMatchObject({ __op: "arrayUnion" });
    const auditValues = (modCall.payload.auditLog as { values: Array<{ action: string; by: string }> }).values;
    expect(auditValues[0].action).toBe("approve");
    expect(auditValues[0].by).toBe("owner@example.com");
  });

  it("falls back to uid for verifiedBy when the token has no email", async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: "owner-uid", email: undefined });
    const response = await POST(actionRequest(VALID_BODY), ctx("gtin_1"));
    expect(response.status).toBe(200);
    expect(mocks.updateCalls[0].payload.verifiedBy).toBe("owner-uid");
  });
});

describe("POST /api/catalog-review/[id] reject mutation shape", () => {
  it("sets verificationStatus rejected, increments timesRejected on the PUBLIC parent doc, and writes auditLog to the LOCKED moderation subcollection doc (never the parent)", async () => {
    const response = await POST(actionRequest({ idToken: "t", action: "reject" }), ctx("gtin_1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, id: "gtin_1", verificationStatus: "rejected" });

    expect(mocks.updateCalls).toHaveLength(1);
    const call = mocks.updateCalls[0];
    expect(call.payload.verificationStatus).toBe("rejected");
    expect(call.payload.timesRejected).toMatchObject({ __op: "increment", n: 1 });
    // M1 spec 1: auditLog must NEVER be part of the public parent doc's update payload.
    expect(call.payload).not.toHaveProperty("auditLog");
    // Reject never sets provenanceTier/verifiedBy (those are approve-only fields).
    expect(call.payload.provenanceTier).toBeUndefined();

    expect(mocks.setCalls).toHaveLength(1);
    const modCall = mocks.setCalls[0];
    expect(modCall.path).toBe("catalogEntries/gtin_1/moderation/log");
    const auditValues = (modCall.payload.auditLog as { values: Array<{ action: string }> }).values;
    expect(auditValues[0].action).toBe("reject");
  });
});
