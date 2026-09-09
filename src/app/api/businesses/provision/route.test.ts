import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  provisionBusiness: vi.fn(),
}));

vi.mock("@/sync-database/cloud/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({ __db: true }),
}));

vi.mock("@/users-businesses/provisioning/provisioning", () => ({
  provisionBusiness: (...args: unknown[]) => mocks.provisionBusiness(...args),
}));

import { POST } from "./route";

function request(body: unknown, token = "firebase-token"): Request {
  return new Request("http://localhost/api/businesses/provision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.verifyIdToken.mockReset().mockResolvedValue({
    uid: "user-1",
    email: "owner@example.com",
    name: "Owner",
  });
  mocks.provisionBusiness.mockReset().mockResolvedValue({
    status: "ready",
    businessId: "business-1",
  });
});

describe("POST /api/businesses/provision", () => {
  it("rejects a request without a bearer token", async () => {
    const response = await POST(request({ mode: "ensure_default" }, ""));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid token without provisioning", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("invalid token"));
    const response = await POST(request({ mode: "ensure_default" }));
    expect(response.status).toBe(401);
    expect(mocks.provisionBusiness).not.toHaveBeenCalled();
  });

  it("derives identity from the verified token", async () => {
    const response = await POST(request({
      mode: "ensure_default",
      preferredBusinessId: "business-2",
    }));
    expect(response.status).toBe(200);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith("firebase-token");
    expect(mocks.provisionBusiness).toHaveBeenCalledWith(
      { __db: true },
      { uid: "user-1", email: "owner@example.com", name: "Owner" },
      { mode: "ensure_default", preferredBusinessId: "business-2" },
    );
  });

  it("accepts a bounded named-business request with an idempotency ID", async () => {
    const response = await POST(request({
      mode: "create_named",
      name: "Main Street Auto",
      requestId: "d99dc2a5-f99f-41cc-9383-9470b66148e4",
    }));
    expect(response.status).toBe(200);
    expect(mocks.provisionBusiness).toHaveBeenCalledWith(
      { __db: true },
      expect.objectContaining({ uid: "user-1" }),
      {
        mode: "create_named",
        name: "Main Street Auto",
        requestId: "d99dc2a5-f99f-41cc-9383-9470b66148e4",
      },
    );
  });

  it.each([
    [{ mode: "create_named", name: "", requestId: "request-1" }],
    [{ mode: "create_named", name: "x".repeat(101), requestId: "request-1" }],
    [{ mode: "create_named", name: "Valid", requestId: "" }],
    [{ mode: "ensure_default", preferredBusinessId: "bad/path" }],
    [{ mode: "unknown" }],
  ])("rejects invalid input without provisioning", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.provisionBusiness).not.toHaveBeenCalled();
  });

  it("returns a stable failure shape without leaking server details", async () => {
    mocks.provisionBusiness.mockRejectedValue(new Error("private credential path"));
    const response = await POST(request({ mode: "ensure_default" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "failed",
      reason: "workspace_unavailable",
    });
  });
});
