import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// D2 (Phase 6): account deletion route tests. Mocks the Admin SDK the same way
// src/app/api/account/export/route.test.ts does - no live Firestore/emulator involved.

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  memberGet: vi.fn(),
  memberData: {} as Record<string, unknown>,
  memberRows: [] as Array<{ id: string; deleted: boolean }>,
  recursiveDelete: vi.fn(),
  queriedPaths: [] as string[],
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    doc: (path: string) => {
      mocks.queriedPaths.push(path);
      return {
        get: async () => {
          if (path.startsWith("businessMembers/")) {
            const exists = await mocks.memberGet();
            return exists ? { exists: true, data: () => mocks.memberData } : { exists: false };
          }
          return { exists: false };
        },
        // used as the businessRef passed to recursiveDelete
        path,
      };
    },
    collection: (path: string) => {
      mocks.queriedPaths.push(path);
      if (path === "businessMembers") {
        return {
          where: (field: string, _op: string, value: string) => {
            mocks.queriedPaths.push(`businessMembers?${field}=${value}`);
            return {
              get: async () => ({
                docs: mocks.memberRows.map((r) => ({
                  id: r.id,
                  ref: {
                    delete: async () => {
                      r.deleted = true;
                    },
                  },
                })),
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected collection path in test mock: ${path}`);
    },
    recursiveDelete: mocks.recursiveDelete,
  }),
}));

import { POST } from "@/app/api/account/delete/route";

function deleteRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
  vi.stubEnv("IS_E2E", "");
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "u1" });
  mocks.memberGet.mockReset().mockResolvedValue(true);
  mocks.memberData = { businessId: "biz-1", userId: "u1", role: "owner" };
  mocks.memberRows = [{ id: "biz-1_u1", deleted: false }];
  mocks.recursiveDelete.mockReset().mockResolvedValue(undefined);
  mocks.queriedPaths = [];
});

const VALID_BODY = {
  businessId: "biz-1",
  idToken: "firebase-token",
  confirmPhrase: "DELETE MY ACCOUNT",
};

describe("POST /api/account/delete authentication and authorization", () => {
  it("refuses deletion outright in mock/authBypass mode, even with a valid-looking body", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "mock");
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error).toMatch(/signed-in owner/i);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("refuses deletion outright when IS_E2E=1, even in live auth mode", async () => {
    vi.stubEnv("IS_E2E", "1");
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(403);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("rejects without an ID token", async () => {
    const response = await POST(deleteRequest({ businessId: "biz-1", confirmPhrase: "DELETE MY ACCOUNT" }));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects a non-owner member with 403 and deletes nothing", async () => {
    mocks.memberData = { businessId: "biz-1", userId: "u1", role: "counter" };
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error).toMatch(/owner/i);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
    expect(mocks.memberRows[0].deleted).toBe(false);
  });

  it("rejects a viewer role with 403 and deletes nothing", async () => {
    mocks.memberData = { businessId: "biz-1", userId: "u1", role: "viewer" };
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(403);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403 and deletes nothing", async () => {
    mocks.memberGet.mockResolvedValue(false);
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(403);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("rejects a wrong confirm phrase with 400 and deletes nothing, even for a verified owner", async () => {
    const response = await POST(
      deleteRequest({ businessId: "biz-1", idToken: "firebase-token", confirmPhrase: "delete my account" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
    expect(mocks.memberRows[0].deleted).toBe(false);
  });

  it("rejects a missing confirm phrase with 400 and deletes nothing", async () => {
    const response = await POST(deleteRequest({ businessId: "biz-1", idToken: "firebase-token" }));
    expect(response.status).toBe(400);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/delete legacy live-mode resolution", () => {
  it("treats legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 (AUTH_MODE unset) as live: deletion proceeds past the mode gate", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_REQUIRE_LOGIN", "1");
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ deleted: true, businessId: "biz-1" });
    expect(mocks.recursiveDelete).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/account/delete success path", () => {
  it("calls recursiveDelete on businesses/{businessId} and deletes only that business's member rows", async () => {
    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ deleted: true, businessId: "biz-1" });

    expect(mocks.recursiveDelete).toHaveBeenCalledTimes(1);
    const deletedRef = mocks.recursiveDelete.mock.calls[0][0];
    expect(deletedRef.path).toBe("businesses/biz-1");

    expect(mocks.memberRows[0].deleted).toBe(true);

    // Only this business's members were queried - the where() clause scoped to biz-1.
    expect(mocks.queriedPaths).toContain("businessMembers?businessId=biz-1");
    // catalogEntries/retailCatalogEntries never touched by any path.
    for (const path of mocks.queriedPaths) {
      expect(path).not.toContain("catalogEntries");
    }
  });

  it("never queries or deletes another tenant's paths", async () => {
    await POST(deleteRequest(VALID_BODY));
    for (const path of mocks.queriedPaths) {
      expect(path).not.toContain("biz-2");
      expect(path).not.toContain("victim");
    }
  });
});
