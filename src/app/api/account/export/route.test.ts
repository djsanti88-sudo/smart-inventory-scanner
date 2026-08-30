import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// D1 (Phase 6): account export route tests. Mocks the Admin SDK the same way
// src/app/api/share/route.test.ts does - no live Firestore/emulator involved.

// Fix 1: route.ts now calls checkRateLimit(..., { storage: await decodeStorage() }) on the live
// path. Redirect decodeStorage() at a per-process tmp dir (same pattern as
// src/app/api/ai-lookup/route.test.ts:21-34) so the durable rate-limit counter never pollutes the
// real repo working tree (.ladder-kv.json) across test runs.
vi.mock("@/decoding/server/pipeline/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/decoding/server/pipeline/storage")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-export-route-test-${process.pid}`);
  return {
    ...actual,
    decodeStorage: async () => actual.fileDecodeStorage(tmpLadderDir),
  };
});

type FakeDoc = { id: string; data: Record<string, unknown> } | null;

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  memberGet: vi.fn(),
  checkRateLimit: vi.fn(),
  // businessId -> collectionName -> array of {id, data}
  tenantData: {} as Record<string, Record<string, Array<{ id: string; data: Record<string, unknown> }>>>,
  businessDoc: null as FakeDoc,
  memberRows: [] as Array<{ id: string; data: Record<string, unknown> }>,
  profileDoc: null as FakeDoc,
  queriedPaths: [] as string[],
}));

vi.mock("@/decoding/limits/aiSpendGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/decoding/limits/aiSpendGuard")>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  };
});

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
            const result = await mocks.memberGet();
            return { exists: result.exists, data: () => ({ role: result.role }) };
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
import { __resetForTest } from "@/decoding/limits/aiSpendGuard";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-export-route-test-${process.pid}`);

function exportRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/account/export", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  __resetForTest();
  fs.rmSync(tmpLadderDir, { recursive: true, force: true });
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
  vi.stubEnv("IS_E2E", "");
  vi.stubEnv("ACCOUNT_EXPORT_MAX_DOCS", "");
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "u1" });
  mocks.memberGet.mockReset().mockResolvedValue({ exists: true, role: "owner" });
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
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
  it.each(["viewer", "counter"])("returns exactly 403 for a %s before reading tenant collections", async (role) => {
    mocks.memberGet.mockResolvedValue({ exists: true, role });

    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("collections");
    expect(mocks.queriedPaths).toEqual(["businessMembers/biz-1_u1"]);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("allows a %s to export the full tenant bundle including auditLog", async (role) => {
    mocks.memberGet.mockResolvedValue({ exists: true, role });
    mocks.tenantData["biz-1"].auditLog = [{ id: "a1", data: { action: "exported" } }];

    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).collections.auditLog).toBeDefined();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "EXPORT:biz-1:u1",
      expect.objectContaining({ limit: 10, windowMs: 60_000, failClosedOnStorageError: true }),
    );
  });

  it("rejects live-mode export without an ID token", async () => {
    const response = await POST(exportRequest({ businessId: "biz-1" }));
    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403 and does not leak collection data", async () => {
    mocks.memberGet.mockResolvedValue(false);
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload).not.toHaveProperty("collections");
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("returns 401 without a businessId in live mode with no token", async () => {
    const response = await POST(exportRequest({}));
    expect(response.status).toBe(401);
  });

  // Fix 1 (ultra-review finding): export MIRRORS delete's auth-bypass refusal (delete/route.ts:83-85).
  // Nothing in the UI calls this route yet (D1 shipped the route only), so refusing loses nothing,
  // and it closes an unthrottled anonymous-read hole in mock mode (the deployed default).
  it.each([
    ["IS_E2E", "live", "1"],
    ["mock auth mode", "mock", ""],
  ])("refuses with 403 in authBypass mode (%s) - never serves the demo bundle to an anonymous caller", async (_label, authMode, isE2e) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    vi.stubEnv("IS_E2E", isE2e);

    const response = await POST(exportRequest({}));
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Account export requires a signed-in member." });
    expect(payload).not.toHaveProperty("collections");
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
    // No Firestore path was ever touched - the refusal happens before any data access.
    expect(mocks.queriedPaths).toEqual([]);
  });

  it("in authBypass mode never honors a caller-supplied businessId either - still 403, no query", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "mock");
    vi.stubEnv("IS_E2E", "");

    const response = await POST(exportRequest({ businessId: "victim-biz" }));
    expect(response.status).toBe(403);
    expect(mocks.queriedPaths).toEqual([]);
  });
});

describe("POST /api/account/export rate limiting (live path)", () => {
  it("does not consume durable rate-limit state before authenticating the caller", async () => {
    vi.stubEnv("ACCOUNT_EXPORT_RATE_LIMIT", "1");
    vi.stubEnv("ACCOUNT_EXPORT_RATE_WINDOW_MS", "60000");

    const anonymous = await POST(exportRequest({ businessId: "biz-1" }));
    expect(anonymous.status).toBe(401);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();

    const authenticated = await POST(exportRequest({ businessId: "biz-1", idToken: "firebase-token" }));
    expect(authenticated.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("keeps an authenticated member in one limiter bucket when forwarded headers rotate", async () => {
    vi.stubEnv("ACCOUNT_EXPORT_RATE_LIMIT", "1");
    vi.stubEnv("ACCOUNT_EXPORT_RATE_WINDOW_MS", "60000");
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });

    const first = await POST(exportRequest(
      { businessId: "biz-1", idToken: "firebase-token" },
      { "x-forwarded-for": "198.51.100.1" },
    ));
    expect(first.status).toBe(200);

    const second = await POST(exportRequest(
      { businessId: "biz-1", idToken: "firebase-token" },
      { "x-forwarded-for": "198.51.100.2", "x-real-ip": "198.51.100.3" },
    ));
    expect(second.status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.checkRateLimit.mock.calls[0][0]).toBe("EXPORT:biz-1:u1");
    expect(mocks.checkRateLimit.mock.calls[1][0]).toBe("EXPORT:biz-1:u1");
  });

  it("allows a normal request through under the default limit", async () => {
    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    expect(response.status).toBe(200);
  });

  it("blocks with 429 + Retry-After once the member limit is exhausted", async () => {
    vi.stubEnv("ACCOUNT_EXPORT_RATE_LIMIT", "1");
    vi.stubEnv("ACCOUNT_EXPORT_RATE_WINDOW_MS", "60000");
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });

    const first = await POST(exportRequest({ businessId: "biz-1", idToken: "firebase-token" }));
    expect(first.status).toBe(200);

    const second = await POST(exportRequest({ businessId: "biz-1", idToken: "firebase-token" }));
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    const payload = await second.json();
    expect(payload.error).toBeTruthy();
    expect(typeof payload.retryAfterMs).toBe("number");
    expect(payload.retryAfterMs).toBeGreaterThan(0);
  });

  it("fails closed with 503 when limiter storage is unavailable after authorization", async () => {
    const storageMod = await import("@/decoding/server/pipeline/storage");
    vi.spyOn(storageMod, "decodeStorage").mockRejectedValueOnce(new Error("storage unavailable"));

    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Rate limiting is temporarily unavailable. Try again shortly." });
    // Authorization still precedes rate limiting, but no tenant collection is read after the limiter fails.
    expect(mocks.queriedPaths).toEqual(["businessMembers/biz-1_u1"]);
  });
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

  // Fix (Gemini Pro review, real minor bug): a document whose stored data() payload itself contains
  // an "id" field must never overwrite the authoritative Firestore doc id (d.id) in the export. The
  // old spread order `{ id: d.id, ...d.data() }` let payload.id win; the fix flips it to
  // `{ ...d.data(), id: d.id }` so d.id always wins.
  it("never lets a document's own data.id field overwrite the true Firestore doc id", async () => {
    mocks.tenantData["biz-1"].products = [
      { id: "real-doc-id", data: { businessId: "biz-1", name: "Widget", id: "PAYLOAD-ID" } },
    ];

    const response = await POST(
      exportRequest({ businessId: "biz-1", idToken: "firebase-token" }),
    );
    const payload = await response.json();

    expect(payload.collections.products.docs[0].id).toBe("real-doc-id");
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
