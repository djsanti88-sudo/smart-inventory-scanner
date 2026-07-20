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
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => false }));
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn() }),
  getAdminDb: () => ({ doc: vi.fn() }),
}));

import { GET, PUT } from "@/app/api/import-mapping/route";

beforeEach(() => {
  vi.clearAllMocks();
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
});
