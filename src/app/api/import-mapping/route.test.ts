// src/app/api/import-mapping/route.test.ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getMemory = vi.fn();
const putMemory = vi.fn();
vi.mock("@/server/importMappingMemory", () => ({
  getImportMappingMemory: (...args: unknown[]) => getMemory(...args),
  putImportMappingMemory: (...args: unknown[]) => putMemory(...args),
}));
// isLiveAuth is mutable per-test so the live-mode Authorization-header tests below can flip it on
// without affecting the existing mock-mode tests (which rely on the default `false`).
let liveAuth = false;
vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => liveAuth }));
const verifyIdToken = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => verifyIdToken(...args) }),
  getAdminDb: () => ({ doc: vi.fn(() => ({ get: async () => ({ exists: true }) })) }),
}));

import { GET, PUT } from "@/app/api/import-mapping/route";

beforeEach(() => {
  vi.clearAllMocks();
  liveAuth = false;
  getMemory.mockResolvedValue(null);
  putMemory.mockResolvedValue(undefined);
});

describe("/api/import-mapping", () => {
  it("returns a remembered mapping for the requested account and signature", async () => {
    getMemory.mockResolvedValue({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const request = new Request(
      "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mapping: { partNumber: 0, quantity: 4 } });
  });

  it("returns null when no mapping is remembered", async () => {
    const request = new Request(
      "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
    );
    const response = await GET(request as never);
    await expect(response.json()).resolves.toEqual({ mapping: null });
  });

  it("writes a mapping only through PUT", async () => {
    const request = new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        businessId: "biz-a",
        sourceSignature: "source-1",
        mapping: { partNumber: 0, quantity: 4 },
      }),
    });
    const response = await PUT(request as never);
    expect(response.status).toBe(200);
    expect(putMemory).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
    }));
  });

  it("rejects missing scope and oversized bodies before storage", async () => {
    const missing = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      body: JSON.stringify({ mapping: {} }),
    }) as never);
    expect(missing.status).toBe(400);

    const oversized = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      headers: { "content-length": String(32 * 1024 + 1) },
      body: "{}",
    }) as never);
    expect(oversized.status).toBe(413);
    expect(putMemory).not.toHaveBeenCalled();
  });

  // Security fix (P4 ultra-review HIGH, Finding 1): the ID token must never ride the URL query
  // string (server/proxy access logs would capture it). GET now reads it from the Authorization
  // header instead of ?idToken=, mirroring how PUT already receives auth in the body.
  describe("GET auth token transport (live mode)", () => {
    beforeEach(() => {
      liveAuth = true;
    });

    it("authorizes a valid token supplied via the Authorization header", async () => {
      verifyIdToken.mockResolvedValue({ uid: "user-1" });
      getMemory.mockResolvedValue({
        businessId: "biz-a",
        sourceSignature: "source-1",
        mapping: { partNumber: 0, quantity: 4 },
        updatedAt: "2026-07-20T12:00:00.000Z",
      });
      const request = new Request(
        "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
        { headers: { Authorization: "Bearer good-token" } },
      );
      const response = await GET(request as never);
      expect(response.status).toBe(200);
      expect(verifyIdToken).toHaveBeenCalledWith("good-token");
      await expect(response.json()).resolves.toMatchObject({ mapping: { partNumber: 0, quantity: 4 } });
    });

    it("accepts a lowercase 'bearer' scheme case-insensitively", async () => {
      verifyIdToken.mockResolvedValue({ uid: "user-1" });
      const request = new Request(
        "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
        { headers: { Authorization: "bearer good-token" } },
      );
      const response = await GET(request as never);
      expect(response.status).toBe(200);
      expect(verifyIdToken).toHaveBeenCalledWith("good-token");
    });

    it("rejects a missing Authorization header in live mode with 401", async () => {
      const request = new Request(
        "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
      );
      const response = await GET(request as never);
      expect(response.status).toBe(401);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it("ignores a token placed in the query string instead of the header (must not authorize)", async () => {
      // Even if a caller (old client, proxy replay, etc.) still puts idToken on the URL, the route
      // must not read it from there - only the Authorization header authorizes.
      const request = new Request(
        "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1&idToken=good-token",
      );
      const response = await GET(request as never);
      expect(response.status).toBe(401);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });
  });
});
