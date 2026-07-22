import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Task 3: route unit tests for GET /api/catalog-review (list pending catalogEntries).
// Mocks the Admin SDK the same way src/app/api/account/delete/route.test.ts does - no live
// Firestore/emulator involved.

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  entries: [] as Array<{ id: string; data: Record<string, unknown> }>,
  cursorDocs: {} as Record<string, { exists: boolean; data?: Record<string, unknown> }>,
  queriedPaths: [] as string[],
}));

function makeQuery(pageSize: number) {
  return {
    orderBy: () => makeQuery(pageSize),
    where: () => makeQuery(pageSize),
    limit: (n: number) => ({
      get: async () => ({
        docs: mocks.entries.slice(0, n).map((e) => ({ id: e.id, data: () => e.data })),
      }),
    }),
    startAfter: () => makeQuery(pageSize),
  };
}

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    collection: (path: string) => {
      mocks.queriedPaths.push(path);
      return makeQuery(0);
    },
  }),
}));

import { GET } from "@/app/api/catalog-review/route";

function listRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/catalog-review${query}`, {
    headers: { Authorization: "Bearer good-token" },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "owner-uid", email: "owner@example.com" });
  mocks.entries = [
    { id: "gtin_1", data: { verificationStatus: "pending", normalizedBarcode: "111", name: "Widget", firstSeenAt: "2026-07-20T00:00:00.000Z" } },
    { id: "gtin_2", data: { verificationStatus: "pending", normalizedBarcode: "222", name: "Gadget", firstSeenAt: "2026-07-19T00:00:00.000Z" } },
  ];
  mocks.queriedPaths = [];
  vi.stubEnv("PLATFORM_OWNER_UIDS", "owner-uid");
  vi.stubEnv("PLATFORM_OWNER_EMAILS", "");
});

describe("GET /api/catalog-review auth", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const request = new NextRequest("http://localhost:3000/api/catalog-review");
    const response = await GET(request);
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid/expired token with 401", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Invalid token"));
    const response = await GET(listRequest());
    expect(response.status).toBe(401);
  });

  it("returns 503 when server auth is not configured", async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error("Could not load the default credentials"));
    const response = await GET(listRequest());
    expect(response.status).toBe(503);
  });

  it("rejects a non-platform-owner caller with 403", async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: "customer-uid", email: "customer@example.com" });
    const response = await GET(listRequest());
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error).toMatch(/platform owner/i);
  });
});

describe("GET /api/catalog-review success path", () => {
  it("returns pending entries for a platform owner", async () => {
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0].id).toBe("gtin_1");
    expect(mocks.queriedPaths).toContain("catalogEntries");
  });

  it("honors a custom pageSize query param, capped at the max", async () => {
    const response = await GET(listRequest("?pageSize=1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(1);
  });

  it("returns an honest empty list with no error when there are no pending entries", async () => {
    mocks.entries = [];
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toEqual([]);
    expect(payload.nextCursor).toBeNull();
  });
});
