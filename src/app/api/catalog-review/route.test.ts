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
  // Per-shape query failure injection (e.g. a missing composite index rejecting with
  // FAILED_PRECONDITION on real Firestore): "ladder" hits the provenanceTier query,
  // "pending" hits the legacy pending query.
  queryErrors: {} as { pending?: Error; ladder?: Error },
}));

// The mock honestly applies == where clauses so the route's two review-queue shapes (legacy
// "pending" vs ladder-written "verified"/ladder_verified_strong) return DIFFERENT slices of
// mocks.entries, the way real Firestore would.
function makeQuery(filters: Array<[string, unknown]> = []) {
  const matches = (e: { data: Record<string, unknown> }) =>
    filters.every(([field, value]) => e.data[field] === value);
  const query = {
    orderBy: () => makeQuery(filters),
    where: (field: string, _op: string, value: unknown) => makeQuery([...filters, [field, value]]),
    limit: (n: number) => ({
      get: async () => {
        const isLadder = filters.some(([field, value]) => field === "provenanceTier" && value === "ladder_verified_strong");
        const isPending = filters.some(([field, value]) => field === "verificationStatus" && value === "pending");
        if (isLadder && mocks.queryErrors.ladder) throw mocks.queryErrors.ladder;
        if (isPending && mocks.queryErrors.pending) throw mocks.queryErrors.pending;
        return {
          docs: mocks.entries.filter(matches).slice(0, n).map((e) => ({ id: e.id, data: () => e.data })),
        };
      },
    }),
    startAfter: () => makeQuery(filters),
  };
  return query;
}

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    collection: (path: string) => {
      mocks.queriedPaths.push(path);
      return makeQuery();
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
  mocks.queryErrors = {};
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

// Empty-queue seam fix: masterAppend.ts writes verificationStatus "verified" + provenanceTier
// "ladder_verified_strong" (never "pending"), so a pending-only GET left the owner approval queue
// permanently empty. The route must ALSO list ladder-written entries, tagged pendingKind
// "ladder_verified" so the client can tell them from legacy "pending" docs.
describe("GET /api/catalog-review ladder-verified queue", () => {
  it("lists ladder-written verified entries alongside pending ones, each tagged with pendingKind", async () => {
    mocks.entries = [
      { id: "gtin_1", data: { verificationStatus: "pending", normalizedBarcode: "111", name: "Widget", firstSeenAt: "2026-07-20T00:00:00.000Z" } },
      { id: "gtin_ladder", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "333", name: "Tire", updatedAt: "2026-07-21T00:00:00.000Z" } },
    ];
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(2);
    const byId = Object.fromEntries(payload.entries.map((e: { id: string; pendingKind: string }) => [e.id, e.pendingKind]));
    expect(byId["gtin_1"]).toBe("pending");
    expect(byId["gtin_ladder"]).toBe("ladder_verified");
  });

  it("does NOT list human_verified or rejected entries in the queue", async () => {
    mocks.entries = [
      { id: "gtin_human", data: { verificationStatus: "verified", provenanceTier: "human_verified", normalizedBarcode: "444", name: "Approved" } },
      { id: "gtin_rejected", data: { verificationStatus: "rejected", provenanceTier: "ladder_verified_strong", normalizedBarcode: "555", name: "Rejected" } },
    ];
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toEqual([]);
  });

  it("finds a ladder-written entry via barcode search, tagged ladder_verified", async () => {
    mocks.entries = [
      { id: "gtin_ladder", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "333", name: "Tire", updatedAt: "2026-07-21T00:00:00.000Z" } },
    ];
    const response = await GET(listRequest("?barcode=333"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].id).toBe("gtin_ladder");
    expect(payload.entries[0].pendingKind).toBe("ladder_verified");
  });
});

// Index-failure isolation: the ladder query (verificationStatus == "verified" + provenanceTier ==
// "ladder_verified_strong" + orderBy updatedAt) needs a Firestore composite index (declared in
// firestore.indexes.json); if it is missing, real Firestore rejects with FAILED_PRECONDITION. One
// shape's query failing must degrade that shape to an empty page, never 500 the whole listing -
// otherwise a missing index would also kill the previously working pending queue.
describe("GET /api/catalog-review query-failure isolation", () => {
  const indexError = new Error("9 FAILED_PRECONDITION: The query requires an index.");

  it("still returns pending entries when the ladder query fails (missing composite index)", async () => {
    mocks.queryErrors.ladder = indexError;
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.every((e: { pendingKind: string }) => e.pendingKind === "pending")).toBe(true);
  });

  it("still returns ladder entries when the pending query fails", async () => {
    mocks.entries = [
      { id: "gtin_ladder", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "333", name: "Tire", updatedAt: "2026-07-21T00:00:00.000Z" } },
    ];
    mocks.queryErrors.pending = indexError;
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].pendingKind).toBe("ladder_verified");
  });

  it("returns 500 when BOTH queries fail (no shape left to serve)", async () => {
    mocks.queryErrors.pending = indexError;
    mocks.queryErrors.ladder = indexError;
    const response = await GET(listRequest());
    expect(response.status).toBe(500);
  });
});
