import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUserByEmail: vi.fn(),
  createUser: vi.fn(),
  memberGet: vi.fn(),
  targetMemberGet: vi.fn(),
  set: vi.fn(),
  doc: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/sync-database/cloud/firebaseAdmin", () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mocks.verifyIdToken(...args),
    getUserByEmail: (...args: unknown[]) => mocks.getUserByEmail(...args),
    createUser: (...args: unknown[]) => mocks.createUser(...args),
  }),
  getAdminDb: () => ({
    doc: (...args: unknown[]) => mocks.doc(...args),
    runTransaction: async (fn: (tx: {
      get: (ref: { get: () => unknown }) => unknown;
      set: (ref: { set: (data: unknown, opts: unknown) => unknown }, data: unknown, opts: unknown) => unknown;
    }) => unknown) => {
      mocks.runTransaction();
      return fn({
        get: (ref: { get: () => unknown }) => ref.get(),
        set: (ref: { set: (data: unknown, opts: unknown) => unknown }, data: unknown, opts: unknown) =>
          ref.set(data, opts),
      });
    },
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
  mocks.targetMemberGet.mockReset().mockResolvedValue({ exists: false, data: () => undefined });
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.doc.mockReset().mockImplementation((path: string) => {
    if (path === "businessMembers/biz-1_owner-1") {
      return { path, get: mocks.memberGet, set: mocks.set };
    }
    if (path.startsWith("businessMembers/")) {
      return { path, get: mocks.targetMemberGet, set: mocks.set };
    }
    return { path, get: vi.fn(), set: mocks.set };
  });
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

  it("rejects self-demotion when the caller targets their own owner membership", async () => {
    // caller owner-1's email resolves back to their own existing Auth user
    mocks.getUserByEmail.mockResolvedValue({ uid: "owner-1", email: "owner@example.com" });
    mocks.targetMemberGet.mockResolvedValue({ exists: true, data: () => ({ role: "owner" }) });

    const response = await POST(request({ businessId: "biz-1", email: "owner@example.com", role: "admin" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "cannot_change_owner_role" });
    expect(mocks.set).not.toHaveBeenCalled();
    // The guard must live INSIDE the transaction (atomic read+reject),
    // not as a separate pre-read followed by an unguarded write.
    expect(mocks.runTransaction).toHaveBeenCalled();
  });

  it("rejects demoting a different existing owner's membership", async () => {
    mocks.getUserByEmail.mockResolvedValue({ uid: "other-owner", email: "other-owner@example.com" });
    mocks.targetMemberGet.mockResolvedValue({ exists: true, data: () => ({ role: "owner" }) });

    const response = await POST(request({ businessId: "biz-1", email: "other-owner@example.com", role: "viewer" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "cannot_change_owner_role" });
    expect(mocks.set).not.toHaveBeenCalled();
    // The guard must live INSIDE the transaction (atomic read+reject),
    // not as a separate pre-read followed by an unguarded write.
    expect(mocks.runTransaction).toHaveBeenCalled();
  });

  it("allows role changes for an existing non-owner member", async () => {
    mocks.getUserByEmail.mockResolvedValue({ uid: "existing-1", email: "tech@example.com" });
    mocks.targetMemberGet.mockResolvedValue({ exists: true, data: () => ({ role: "viewer" }) });

    const response = await POST(request({ businessId: "biz-1", email: "tech@example.com", role: "admin" }));

    expect(response.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      userId: "existing-1",
      role: "admin",
    }), { merge: true });
  });

  it("does not silently trim a temporary password before validating or using it", async () => {
    const response = await POST(request({
      businessId: "biz-1",
      email: "tech@example.com",
      name: "Tech One",
      password: "  TempPass123!  ",
      role: "counter",
    }));

    expect(response.status).toBe(200);
    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "tech@example.com",
      password: "  TempPass123!  ",
    }));
  });
});
