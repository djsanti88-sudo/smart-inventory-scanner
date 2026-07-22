import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Task 3: route unit tests for POST /api/catalog-review/[id] (approve/reject a pending catalogEntries
// doc). Mocks the Admin SDK the same way src/app/api/account/delete/route.test.ts does.

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  docExists: true,
  updateCalls: [] as Array<{ path: string; payload: Record<string, unknown> }>,
  queriedPaths: [] as string[],
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    collection: (path: string) => ({
      doc: (id: string) => {
        const fullPath = `${path}/${id}`;
        mocks.queriedPaths.push(fullPath);
        return {
          get: async () => ({ exists: mocks.docExists }),
          update: async (payload: Record<string, unknown>) => {
            mocks.updateCalls.push({ path: fullPath, payload });
          },
        };
      },
    }),
  }),
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
  mocks.docExists = true;
  mocks.updateCalls = [];
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
  it("sets verificationStatus verified, provenanceTier human_verified, verifiedBy, and appends auditLog", async () => {
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
    expect(call.payload.auditLog).toMatchObject({ __op: "arrayUnion" });
    const auditValues = (call.payload.auditLog as { values: Array<{ action: string; by: string }> }).values;
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
  it("sets verificationStatus rejected, increments timesRejected, and appends auditLog", async () => {
    const response = await POST(actionRequest({ idToken: "t", action: "reject" }), ctx("gtin_1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, id: "gtin_1", verificationStatus: "rejected" });

    expect(mocks.updateCalls).toHaveLength(1);
    const call = mocks.updateCalls[0];
    expect(call.payload.verificationStatus).toBe("rejected");
    expect(call.payload.timesRejected).toMatchObject({ __op: "increment", n: 1 });
    const auditValues = (call.payload.auditLog as { values: Array<{ action: string }> }).values;
    expect(auditValues[0].action).toBe("reject");
    // Reject never sets provenanceTier/verifiedBy (those are approve-only fields).
    expect(call.payload.provenanceTier).toBeUndefined();
  });
});
