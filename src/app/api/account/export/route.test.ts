import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// D1 (Phase 6): account export route tests. Mocks the Admin SDK the same way
// src/app/api/share/route.test.ts does - no live Firestore/emulator involved.

type FakeDoc = { id: string; data: Record<string, unknown> } | null;

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  memberGet: vi.fn(),
  // businessId -> collectionName -> array of {id, data}
  tenantData: {} as Record<string, Record<string, Array<{ id: string; data: Record<string, unknown> }>>>,
  businessDoc: null as FakeDoc,
  memberRows: [] as Array<{ id: string; data: Record<string, unknown> }>,
  profileDoc: null as FakeDoc,
  queriedPaths: [] as string[],
}));

function makeQuerySnap(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
  };
}

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    doc: (path: string) => {
      mocks.queriedPaths.push(path);
      // businesses/{businessId}/{collection}/{docId} is not used directly (we use .collection()
      // for subcollections); this handles businessMembers/{id}, businesses/{id}, userProfiles/{id}.
      return {
        get: async () => {
          if (path.startsWith(`${"businessMembers"}/`)) {
            return { exists: await mocks.memberGet() };
          }
          if (path.startsWith("businesses/")) {
            const doc = mocks.businessDoc;
            return doc
              ? { exists: true, id: doc.id, data: () => doc.data }
              : { exists: false };
          }
          if (path.startsWith("userProfiles/")) {
            const doc = mocks.profileDoc;
            return doc
              ? { exists: true, id: doc.id, data: () => doc.data }
              : { exists: false };
          }
          return { exists: false };
        },
      };
    },
    collection: (path: string) => {
      mocks.queriedPaths.push(path);
      // businesses/{businessId}/{collectionName} subcollection walk.
      const subMatch = path.match(/^businesses\/([^/]+)\/(.+)$/);
      if (subMatch) {
        const [, businessId, collectionName] = subMatch;
        const rows = mocks.tenantData[businessId]?.[collectionName] ?? [];
        return {
          limit: (n: number) => ({
            get: async () => makeQuerySnap(rows.slice(0, n)),
          }),
        };
      }
      if (path === "businessMembers") {
        return {
          where: () => ({
            limit: (n: number) => ({
              get: async () => makeQuerySnap(mocks.memberRows.slice(0, n)),
            }),
          }),
        };
      }
      throw new Error(`Unexpected collection path in test mock: ${path}`);
    },
  }),
}));

import { POST } from "@/app/api/account/export/route";

function exportRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/account/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
  vi.stubEnv("IS_E2E", "");
  vi.stubEnv("ACCOUNT_EXPORT_MAX_DOCS", "");
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "u1" });
  mocks.memberGet.mockReset().mockResolvedValue(true);
  mocks.queriedPaths = [];
  mocks.tenantData = {
    "biz-1": {
      products: [{ id: "p1", data: { businessId: "biz-1", name: "Widget" } }],
      aliases: [],
      countSessions: [],
      inventoryCounts: [],
      scanEvents: [{ id: "s1", data: { businessId: "biz-1", code: "012345678905" } }],
      unknownCodeReviews: [],
      settings: [],
      shopOverrides: [],
      auditLog: [],
    },
    "biz-2": {
      products: [{ id: "p-other", data: { businessId: "biz-2", name: "Should never appear" } }],
      aliases: [],
      countSessions: [],
      inventoryCounts: [],
      scanEvents: [],
      unknownCodeReviews: [],
      settings: [],
      shopOverrides: [],
      auditLog: [],
    },
  };
  mocks.businessDoc = { id: "biz-1", data: { name: "Test Shop" } };
  mocks.memberRows = [{ id: "biz-1_u1", data: { businessId: "biz-1", userId: "u1", role: "owner" } }];
  mocks.profileDoc = { id: "u1", data: { email: "owner@example.com" } };
});

describe("POST /api/account/export authentication", () => {
  it("rejects live-mode export without an ID token", async () => {
    const response = await POST(exportRequest({ businessId: "biz-1" }));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403 and does not leak collection data", async () => {
    mocks.memberGet.mockResolvedValue(false);
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload).not.toHaveProperty("collections");
  });

  it("returns 401 without a businessId in live mode with no token", async () => {
    const response = await POST(exportRequest({}));
    expect(response.status).toBe(401);
  });

  it.each([
    ["IS_E2E", "live", "1"],
    ["mock auth mode", "mock", ""],
  ])("bypasses auth via %s without calling Firebase Auth", async (_label, authMode, isE2e) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    vi.stubEnv("IS_E2E", isE2e);
    mocks.tenantData["demo-business"] = mocks.tenantData["biz-1"];
    mocks.businessDoc = { id: "demo-business", data: { name: "Demo" } };

    const response = await POST(exportRequest({}));
    expect(response.status).toBe(200);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
  });

  it.each([
    ["IS_E2E bypass", "live", "1"],
    ["mock auth mode", "mock", ""],
  ])(
    "in authBypass mode (%s) NEVER honors a caller-supplied businessId - exports only demo-business",
    async (_label, authMode, isE2e) => {
      vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
      vi.stubEnv("IS_E2E", isE2e);
      mocks.tenantData["victim-biz"] = {
        products: [{ id: "stolen", data: { businessId: "victim-biz", name: "Victim secret" } }],
        aliases: [], countSessions: [], inventoryCounts: [], scanEvents: [],
        unknownCodeReviews: [], settings: [], shopOverrides: [], auditLog: [],
      };
      mocks.tenantData["demo-business"] = mocks.tenantData["biz-1"];
      mocks.businessDoc = { id: "demo-business", data: { name: "Demo" } };

      const response = await POST(exportRequest({ businessId: "victim-biz" }));
      expect(response.status).toBe(200);
      const payload = await response.json();

      // The bundle is pinned to demo-business, never the attacker-chosen tenant.
      expect(payload.businessId).toBe("demo-business");
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("victim-biz");
      expect(serialized).not.toContain("Victim secret");
      // And no Firestore path for the victim tenant was ever queried.
      for (const path of mocks.queriedPaths) {
        expect(path).not.toContain("victim-biz");
      }
    },
  );
});

describe("POST /api/account/export data shape and tenant isolation", () => {
  it("returns only the member's own business docs, never another tenant's", async () => {
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.businessId).toBe("biz-1");
    expect(payload.collections.products.docs).toEqual([
      { id: "p1", businessId: "biz-1", name: "Widget" },
    ]);
    // Never any biz-2 doc anywhere in the bundle.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("biz-2");
    expect(serialized).not.toContain("Should never appear");
  });

  it("never includes master/shared collections (catalogEntries)", async () => {
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    const payload = await response.json();
    expect(payload.collections).not.toHaveProperty("catalogEntries");
    expect(payload.collections).not.toHaveProperty("retailCatalogEntries");
  });

  it("includes the businessMembers row scoped to this business and the caller's userProfile", async () => {
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    const payload = await response.json();
    expect(payload.collections.businessMembers.docs).toHaveLength(1);
    expect(payload.collections.businessMembers.docs[0].businessId).toBe("biz-1");
    expect(payload.collections.userProfiles.docs[0].id).toBe("u1");
  });

  it("sets a truncated flag per collection when the doc cap is hit, without silently dropping data", async () => {
    vi.stubEnv("ACCOUNT_EXPORT_MAX_DOCS", "1");
    mocks.tenantData["biz-1"].scanEvents = [
      { id: "s1", data: { businessId: "biz-1" } },
      { id: "s2", data: { businessId: "biz-1" } },
      { id: "s3", data: { businessId: "biz-1" } },
    ];

    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    const payload = await response.json();

    expect(payload.collections.scanEvents.truncated).toBe(true);
    expect(payload.collections.scanEvents.docs).toHaveLength(1);
    // A collection under the cap must NOT be marked truncated.
    expect(payload.collections.products.truncated).toBe(false);
  });
});
