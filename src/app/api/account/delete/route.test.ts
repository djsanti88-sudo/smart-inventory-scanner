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

vi.mock("@/users-businesses/account/accountDeleteRateLimit", () => ({
  checkAccountDeleteRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0, remaining: 99 })),
}));
vi.mock("@/decoding/server/log", () => ({ logServerEvent: vi.fn() }));

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

describe("POST /api/account/delete request body shape guard", () => {
  it("rejects an array JSON body with 400 and deletes nothing", async () => {
    const response = await POST(deleteRequest([]));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/invalid request body/i);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("rejects a null JSON body with 400 and deletes nothing", async () => {
    const response = await POST(deleteRequest(null));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/invalid request body/i);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });

  it("rejects a bare string JSON body with 400 and deletes nothing", async () => {
    const response = await POST(deleteRequest("just a string"));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/invalid request body/i);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });
});

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

describe("POST /api/account/delete partial-failure retryability", () => {
  it("member-delete failure after the tree delete returns 500 with a retry-safe message, and a retry finishes the deletion", async () => {
    // FIRST call: recursiveDelete (business tree) succeeds, but the member-row delete throws. The tree
    // is gone; the owner's membership row survives (so the operation is safely retryable). The caller
    // must be told to RETRY, not that they are stuck in an unrecoverable half-state.
    mocks.recursiveDelete.mockResolvedValueOnce(undefined);
    let memberDeleteShouldFail = true;
    mocks.memberRows = [
      {
        id: "biz-1_u1",
        get deleted(): boolean {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (this as any)._deleted ?? false;
        },
        set deleted(v: boolean) {
          if (memberDeleteShouldFail) throw new Error("simulated member-row delete failure");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any)._deleted = v;
        },
      } as unknown as { id: string; deleted: boolean },
    ];

    const firstResponse = await POST(deleteRequest(VALID_BODY));
    expect(firstResponse.status).toBe(500);
    const firstPayload = await firstResponse.json();
    expect(firstPayload.error).toMatch(/retry/i);
    expect(firstPayload.error).not.toMatch(/contact support/i);
    // The business tree WAS deleted on the first attempt.
    expect(mocks.recursiveDelete).toHaveBeenCalledTimes(1);

    // SECOND call (the retry): the owner membership still exists (role check still passes), the tree
    // delete no-ops on the already-gone tree, and the member rows now delete cleanly -> 200 deleted:true.
    memberDeleteShouldFail = false;
    const secondResponse = await POST(deleteRequest(VALID_BODY));
    expect(secondResponse.status).toBe(200);
    const secondPayload = await secondResponse.json();
    expect(secondPayload).toEqual({ deleted: true, businessId: "biz-1" });
    expect(mocks.memberRows[0].deleted).toBe(true);
    expect(mocks.recursiveDelete).toHaveBeenCalledTimes(2);
  });

  // S2 (deep review 2026-08-09): the test above only ever had ONE member row (the owner's), so it could
  // not detect the real defect - with the old concurrent Promise.all, a multi-member business whose
  // NON-owner row failed could still have had the owner's own row deleted, which makes the advertised
  // retry impossible (the retry 403s on "Not a member of this business" and the residual rows are
  // stranded forever). This test kills that order dependence: authorization is wired to the LIVE state
  // of the owner row, exactly as Firestore would behave on a retry.
  it("a non-owner member-row failure leaves the OWNER row intact, so the retry re-authorizes and purges everything", async () => {
    let otherDeleteShouldFail = true;
    const state = { owner: false, other: false };
    mocks.memberRows = [
      {
        id: "biz-1_u2", // a NON-owner member row - the one that fails on the first attempt
        get deleted(): boolean {
          return state.other;
        },
        set deleted(v: boolean) {
          if (otherDeleteShouldFail) throw new Error("simulated non-owner member-row delete failure");
          state.other = v;
        },
      } as unknown as { id: string; deleted: boolean },
      {
        id: "biz-1_u1", // the CALLER's own owner row - must be deleted LAST, only after the others
        get deleted(): boolean {
          return state.owner;
        },
        set deleted(v: boolean) {
          state.owner = v;
        },
      } as unknown as { id: string; deleted: boolean },
    ];
    // Authorization now reflects reality: once the owner's own row is gone, the caller is no longer a
    // member and every retry would 403. This is what made the old "Retry" copy a lie.
    mocks.memberGet.mockReset().mockImplementation(async () => !state.owner);

    const first = await POST(deleteRequest(VALID_BODY));
    expect(first.status).toBe(500);
    expect((await first.json()).error).toMatch(/retry/i);
    // THE INVARIANT: the failure did not consume the authorization anchor.
    expect(state.owner).toBe(false);
    expect(state.other).toBe(false);

    otherDeleteShouldFail = false;
    const second = await POST(deleteRequest(VALID_BODY));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deleted: true, businessId: "biz-1" });
    // Everything is now gone - no stranded residual rows.
    expect(state.other).toBe(true);
    expect(state.owner).toBe(true);
  });
});

describe("POST /api/account/delete revoked-session hardening (S1)", () => {
  it("verifies the ID token with checkRevoked=true (irreversible action, one extra round-trip is fine)", async () => {
    await POST(deleteRequest(VALID_BODY));
    expect(mocks.verifyIdToken).toHaveBeenCalledWith("firebase-token", true);
  });

  it("refuses a REVOKED session with 401 and honest copy, deleting nothing", async () => {
    const revoked = Object.assign(new Error("The Firebase ID token has been revoked."), {
      code: "auth/id-token-revoked",
    });
    mocks.verifyIdToken.mockReset().mockRejectedValue(revoked);

    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload.error).toMatch(/revoked/i);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
    expect(mocks.memberRows[0].deleted).toBe(false);
  });

  it("refuses a DISABLED account with 401 and deletes nothing", async () => {
    mocks.verifyIdToken
      .mockReset()
      .mockRejectedValue(Object.assign(new Error("user record is disabled"), { code: "auth/user-disabled" }));

    const response = await POST(deleteRequest(VALID_BODY));
    expect(response.status).toBe(401);
    expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  });
});
