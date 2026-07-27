import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUserByEmail: vi.fn(),
  createUser: vi.fn(),
  memberGet: vi.fn(),
  set: vi.fn(),
  doc: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mocks.verifyIdToken(...args),
    getUserByEmail: (...args: unknown[]) => mocks.getUserByEmail(...args),
    createUser: (...args: unknown[]) => mocks.createUser(...args),
  }),
  getAdminDb: () => ({
    doc: (...args: unknown[]) => mocks.doc(...args),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TIME" },
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/businesses/members", {
    method: "POST",
    headers: {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "owner-1" });
  mocks.getUserByEmail.mockReset().mockRejectedValue({ code: "auth/user-not-found" });
  mocks.createUser.mockReset().mockResolvedValue({ uid: "staff-1", email: "tech@example.com" });
  mocks.memberGet.mockReset().mockResolvedValue({ exists: true, data: () => ({ role: "owner" }) });
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.doc.mockReset().mockImplementation((path: string) => ({
    path,
    get: path === "businessMembers/biz-1_owner-1" ? mocks.memberGet : vi.fn(),
    set: mocks.set,
  }));
});

describe("POST /api/businesses/members", () => {
  it("owner-created staff are created in Firebase Auth and linked to the business membership", async () => {
    const response = await POST(request({
      businessId: "biz-1",
      email: " Tech@Example.com ",
      name: "Tech One",
      role: "counter",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      uid: "staff-1",
      email: "tech@example.com",
      role: "counter",
      createdAuthUser: true,
    });
    expect(mocks.createUser).toHaveBeenCalledWith({
      email: "tech@example.com",
      displayName: "Tech One",
      emailVerified: false,
      disabled: false,
    });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      authUserId: "staff-1",
      email: "tech@example.com",
      name: "Tech One",
    }), { merge: true });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz-1",
      userId: "staff-1",
      role: "counter",
    }), { merge: true });
  });

  it("links an existing Firebase Auth user instead of creating a duplicate", async () => {
    mocks.getUserByEmail.mockResolvedValue({ uid: "existing-1", email: "tech@example.com" });

    const response = await POST(request({ businessId: "biz-1", email: "tech@example.com", role: "viewer" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      uid: "existing-1",
      createdAuthUser: false,
    });
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz-1",
      userId: "existing-1",
      role: "viewer",
    }), { merge: true });
  });

  it("can set a temporary password so a newly created Firebase user can sign in", async () => {
    const response = await POST(request({
      businessId: "biz-1",
      email: "tech@example.com",
      name: "Tech One",
      password: "TempPass123!",
      role: "counter",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      uid: "staff-1",
      createdAuthUser: true,
      passwordSet: true,
    });
    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "tech@example.com",
      password: "TempPass123!",
    }));
  });

  it("rejects non-owner callers before touching Firebase Auth", async () => {
    mocks.memberGet.mockResolvedValue({ exists: true, data: () => ({ role: "counter" }) });

    const response = await POST(request({ businessId: "biz-1", email: "tech@example.com", role: "counter" }));

    expect(response.status).toBe(403);
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });
});
