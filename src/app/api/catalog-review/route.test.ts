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
  checkRateLimit: vi.fn(),
}));

// The mock honestly applies == where clauses so the route's two review-queue shapes (legacy
// "pending" vs ladder-written "verified"/ladder_verified_strong) return DIFFERENT slices of
// mocks.entries, the way real Firestore would. orderBy/startAfter are honest too: startAfter
// rejects a cursor snapshot missing the orderBy field (the real Admin SDK throws "Field ... is
// missing in the provided DocumentSnapshot") and pagination resumes after the cursor doc in
// field order, so cross-applying one stream's cursor to the other stream fails here exactly
// like production.
type MockCursorSnap = { id: string; data: () => Record<string, unknown> | undefined };

function makeQuery(
  filters: Array<[string, unknown]> = [],
  orderField: string | null = null,
  after: MockCursorSnap | null = null,
) {
  const matches = (e: { data: Record<string, unknown> }) =>
    filters.every(([field, value]) => e.data[field] === value);
  const query = {
    orderBy: (field: string) => makeQuery(filters, field, after),
    where: (field: string, _op: string, value: unknown) => makeQuery([...filters, [field, value]], orderField, after),
    limit: (n: number) => ({
      get: async () => {
        const isLadder = filters.some(([field, value]) => field === "provenanceTier" && value === "ladder_verified_strong");
        const isPending = filters.some(([field, value]) => field === "verificationStatus" && value === "pending");
        if (isLadder && mocks.queryErrors.ladder) throw mocks.queryErrors.ladder;
        if (isPending && mocks.queryErrors.pending) throw mocks.queryErrors.pending;
        let list = mocks.entries.filter(matches);
        if (orderField) {
          const field = orderField;
          list = [...list].sort((a, b) => String(b.data[field] ?? "").localeCompare(String(a.data[field] ?? "")));
        }
        if (after) {
          const idx = list.findIndex((e) => e.id === after.id);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        return {
          docs: list.slice(0, n).map((e) => ({ id: e.id, data: () => e.data })),
        };
      },
    }),
    startAfter: (snap: MockCursorSnap) => {
      if (orderField && (snap.data() ?? {})[orderField] === undefined) {
        throw new Error(`Field "${orderField}" is missing in the provided DocumentSnapshot.`);
      }
      return makeQuery(filters, orderField, snap);
    },
  };
  return query;
}

function makeDocRef(id: string) {
  return {
    get: async () => {
      const found = mocks.entries.find((e) => e.id === id);
      return found
        ? { exists: true, id: found.id, data: () => found.data }
        : { exists: false, id, data: () => undefined };
    },
  };
}

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({
    collection: (path: string) => {
      mocks.queriedPaths.push(path);
      return { ...makeQuery(), doc: makeDocRef };
    },
  }),
}));

vi.mock("@/decoding/server/pipeline/storage", () => ({
  decodeStorage: async () => ({} as never),
}));

vi.mock("@/decoding/limits/aiSpendGuard", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  intEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
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
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
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

describe("GET /api/catalog-review rate limit and query length guards", () => {
  it("returns 429 when request-rate limit is exhausted", async () => {
    mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: false, retryAfterMs: 1200 });
    const response = await GET(listRequest());
    expect(response.status).toBe(429);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload.reasonCode).toBe("rate_limited");
    expect(payload.error).toMatch(/Too many requests/i);
  });

  // Cross-route rate-limit bucket isolation (ported from the preserved worktree fix,
  // .claude/worktrees/agent-a47380b0deaa5e8d2): this route used to call checkRateLimit(ip, ...)
  // with the BARE client IP, sharing one bucket with every other route calling checkRateLimit
  // with the same bare IP (ai-lookup POST, catalog-dispute POST, catalog-review/[id] POST) - a
  // burst on one route could 429 an unrelated route for the same client IP even though each
  // route defines its own distinct rate-limit env var. The key must carry a route-family
  // prefix so route A's traffic can never burn route B's limit.
  it("keys the rate limit with a route-family prefix, not the bare client IP", async () => {
    await GET(listRequest());
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    const [key] = mocks.checkRateLimit.mock.calls[0] as [string, unknown];
    expect(key).toMatch(/^CATALOG_REVIEW:/);
  });

  it("rejects a barcode query that exceeds the max length", async () => {
    const response = await GET(listRequest(`?barcode=${"b".repeat(65)}`));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/barcode query is too long/i);
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

// Cursor fix: the two queue queries order by DIFFERENT fields (pending -> firstSeenAt,
// ladder -> updatedAt) and any given doc carries only one of them, so one shared cursor doc
// snapshot cross-applied to both queries makes the real Admin SDK throw ("Field ... is missing
// in the provided DocumentSnapshot") as soon as the client follows nextCursor. The route must
// keep a per-stream cursor packed inside one opaque nextCursor token, applying each stream's
// cursor only to its own query, with no skipped or duplicated entries across pages.
describe("GET /api/catalog-review pagination cursor", () => {
  beforeEach(() => {
    mocks.entries = [
      { id: "p1", data: { verificationStatus: "pending", normalizedBarcode: "1", name: "P1", firstSeenAt: "2026-07-21T06:00:00.000Z" } },
      { id: "l1", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "2", name: "L1", updatedAt: "2026-07-21T05:00:00.000Z" } },
      { id: "p2", data: { verificationStatus: "pending", normalizedBarcode: "3", name: "P2", firstSeenAt: "2026-07-21T04:00:00.000Z" } },
      { id: "l2", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "4", name: "L2", updatedAt: "2026-07-21T03:00:00.000Z" } },
      { id: "p3", data: { verificationStatus: "pending", normalizedBarcode: "5", name: "P3", firstSeenAt: "2026-07-21T02:00:00.000Z" } },
      { id: "l3", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "6", name: "L3", updatedAt: "2026-07-21T01:00:00.000Z" } },
    ];
  });

  it("pages through a mixed pending + ladder queue newest-first with no throw, skip, or duplicate", async () => {
    const page1 = await GET(listRequest("?pageSize=2"));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.entries.map((e: { id: string }) => e.id)).toEqual(["p1", "l1"]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await GET(listRequest(`?pageSize=2&cursor=${encodeURIComponent(body1.nextCursor)}`));
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.entries.map((e: { id: string }) => e.id)).toEqual(["p2", "l2"]);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await GET(listRequest(`?pageSize=2&cursor=${encodeURIComponent(body2.nextCursor)}`));
    expect(page3.status).toBe(200);
    const body3 = await page3.json();
    expect(body3.entries.map((e: { id: string }) => e.id)).toEqual(["p3", "l3"]);
    expect(body3.nextCursor).toBeNull();
  });

  it("keeps advancing a stream that emitted nothing on the current page (cursor carries forward)", async () => {
    // Page 1 of size 3 emits p1, l1, p2 - the ladder stream's l2/l3 are sliced off; page 2 must
    // still resume the ladder stream from l1, not restart it from the top.
    const page1 = await GET(listRequest("?pageSize=3"));
    const body1 = await page1.json();
    expect(body1.entries.map((e: { id: string }) => e.id)).toEqual(["p1", "l1", "p2"]);
    const page2 = await GET(listRequest(`?pageSize=3&cursor=${encodeURIComponent(body1.nextCursor)}`));
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.entries.map((e: { id: string }) => e.id)).toEqual(["l2", "p3", "l3"]);
    expect(body2.nextCursor).toBeNull();
  });

  it("never skips an upgraded legacy doc that carries BOTH firstSeenAt and updatedAt", async () => {
    // masterAppend.ts upserts with merge:true, so a legacy "pending" doc a strong ladder decode
    // upgrades keeps its old firstSeenAt while gaining a fresh updatedAt. The ladder query orders
    // by updatedAt, so the merged sort must key that doc by updatedAt too - keying it by its stale
    // firstSeenAt pushes it below its cursor position and page 2's startAfter skips it forever.
    mocks.entries = [
      { id: "lx", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "7", name: "Upgraded", firstSeenAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z" } },
      { id: "ly", data: { verificationStatus: "verified", provenanceTier: "ladder_verified_strong", normalizedBarcode: "8", name: "Fresh", updatedAt: "2026-07-21T00:00:00.000Z" } },
    ];
    const page1 = await GET(listRequest("?pageSize=1"));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    // Query order (updatedAt desc) puts lx first; the merged sort must agree.
    expect(body1.entries.map((e: { id: string }) => e.id)).toEqual(["lx"]);
    const page2 = await GET(listRequest(`?pageSize=1&cursor=${encodeURIComponent(body1.nextCursor)}`));
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.entries.map((e: { id: string }) => e.id)).toEqual(["ly"]);
    expect(body2.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the first page instead of erroring", async () => {
    const response = await GET(listRequest("?pageSize=2&cursor=not-a-real-cursor"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries.map((e: { id: string }) => e.id)).toEqual(["p1", "l1"]);
  });
});
