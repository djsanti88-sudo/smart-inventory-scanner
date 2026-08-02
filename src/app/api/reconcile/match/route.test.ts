// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

// Task 7: POST /api/reconcile/match - runs matchExpectedRow server-side against the local tire
// corpus. NO keys, NO paid calls, NO external network: the only data dependency is the
// tire-knowledge index, mocked here entirely (same isolation style as the route tests around
// /api/ai-lookup - no test may touch a real backend).

vi.mock("server-only", () => ({}));

const authMocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  memberGet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: authMocks.verifyIdToken }),
  getAdminDb: () => ({
    doc: () => ({ get: authMocks.memberGet }),
  }),
}));

vi.mock("@/services/security/aiSpendGuard", () => ({
  checkRateLimit: (...args: unknown[]) => authMocks.checkRateLimit(...args),
  intEnv: (value: string | undefined, fallback: number) => Number(value) || fallback,
}));

vi.mock("@/server/upc/storage", () => ({
  ladderStorage: vi.fn().mockResolvedValue({}),
}));

const mockLookupAll = vi.fn();
const mockBySize = vi.fn();
vi.mock("@/server/tire-knowledge/tireKnowledgeIndex", () => ({
  lookupAllByPartNumber: (key: string) => mockLookupAll(key),
  candidatesBySizeToken: (token: string) => mockBySize(token),
}));

const mockRetailLookup = vi.fn();
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  lookupRetailBarcodeAsync: (code: string) => mockRetailLookup(code),
}));

import { POST } from "@/app/api/reconcile/match/route";

const CORPUS_ROW = {
  canonical_product_uid: "uid-1",
  brand: "Cooper", brand_normalized: "cooper",
  model: "Discoverer AT3", model_normalized: "discoverer at3",
  size: "265/70R17", raw_size_text: "P265/70R17",
  load_index: "113", speed_rating: "S", load_range: "SL",
  type: "all_season", season: "all_season",
  manufacturer_part_number: "90000027117",
  barcode: "029142869870", barcode_type: "upc_a",
  confidence: "verified_2src", current_status: "active", usable_for: "sale",
  field_completeness_score: "1.0", missing_fields: "", source_count: 2,
};

// This is the deterministic two-row import contract used by the browser spec.  It
// deliberately lives in the route test's mocked corpus rather than assuming a
// generated database exists in every CI worker.
const FALKEN_IMPORT_ROW = {
  ...CORPUS_ROW,
  canonical_product_uid: "falken-28030703",
  brand: "Falken", brand_normalized: "falken",
  model: "Wildpeak A/T3W", model_normalized: "wildpeak at3w",
  size: "LT275/70R18", raw_size_text: "LT275/70R18",
  manufacturer_part_number: "28030703",
  barcode: "848983006493",
};

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/reconcile/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function liveRequest(
  body: Record<string, unknown>,
  contentLength?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/reconcile/match", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(contentLength ? { "content-length": contentLength } : {}),
      ...headers,
    },
    body: JSON.stringify({ businessId: "biz-1", idToken: "firebase-token", ...body }),
  });
}

function validRow(over: Record<string, unknown> = {}) {
  return {
    externalId: "90000027117",
    partNumbers: ["90000027117"],
    brand: "Cooper",
    sizeText: "265/70R17",
    qty: 4,
    raw: {},
    ...over,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "mock");
  vi.stubEnv("IS_E2E", "");
  vi.clearAllMocks();
  authMocks.verifyIdToken.mockResolvedValue({ uid: "u1" });
  authMocks.memberGet.mockResolvedValue({ exists: true });
  authMocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  mockLookupAll.mockResolvedValue([]);
  mockBySize.mockResolvedValue([]);
  mockRetailLookup.mockResolvedValue(null);
});

describe("POST /api/reconcile/match - auth and extraction bounds", () => {
  it("returns 401 before any corpus lookup when live auth has no token", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");

    const res = await POST(makeRequest({ businessId: "biz-1", rows: [validRow()] }));

    expect(res.status).toBe(401);
    expect(mockLookupAll).not.toHaveBeenCalled();
  });

  it("returns 413 before parsing when declared content length exceeds the request limit", async () => {
    const res = await POST(liveRequest({ rows: [validRow()] }, String(1024 * 1024)));

    expect(res.status).toBe(413);
    expect(authMocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("allows a member's small authenticated request", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");

    const res = await POST(liveRequest({ rows: [validRow()] }));

    expect(res.status).toBe(200);
    expect(authMocks.verifyIdToken).toHaveBeenCalledWith("firebase-token");
  });

  it("uses one fixed limiter bucket for mock-mode reconcile requests", async () => {
    const res = await POST(makeRequest({ businessId: "caller-controlled", rows: [validRow()] }));

    expect(res.status).toBe(200);
    expect(authMocks.checkRateLimit).toHaveBeenCalledWith(
      "RECONCILE:mock",
      expect.objectContaining({ limit: 30, windowMs: 60_000, failClosedOnStorageError: true }),
    );
  });

  it("returns 429 when the authenticated caller exceeds the route limit", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
    authMocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const res = await POST(liveRequest({ rows: [validRow()] }));

    expect(res.status).toBe(429);
  });

  it("fails closed with 503 when limiter storage is unavailable after authorization", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
    authMocks.checkRateLimit.mockRejectedValueOnce(new Error("storage unavailable"));

    const res = await POST(liveRequest({ rows: [validRow()] }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Rate limiting is temporarily unavailable. Try again shortly." });
    expect(authMocks.verifyIdToken).toHaveBeenCalledWith("firebase-token");
    expect(authMocks.memberGet).toHaveBeenCalledTimes(1);
    expect(authMocks.checkRateLimit).toHaveBeenCalledWith(
      "RECONCILE:biz-1:u1",
      expect.objectContaining({ limit: 30, windowMs: 60_000, failClosedOnStorageError: true }),
    );
    expect(mockLookupAll).not.toHaveBeenCalled();
    expect(mockBySize).not.toHaveBeenCalled();
  });

  it("keeps an authenticated member in one limiter bucket when forwarded headers rotate", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");

    const first = await POST(liveRequest(
      { rows: [validRow()] },
      undefined,
      { "x-forwarded-for": "198.51.100.1" },
    ));
    const second = await POST(liveRequest(
      { rows: [validRow()] },
      undefined,
      { "x-forwarded-for": "198.51.100.2", "x-real-ip": "198.51.100.3" },
    ));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(authMocks.checkRateLimit).toHaveBeenCalledTimes(2);
    expect(authMocks.checkRateLimit.mock.calls[0][0]).toBe("RECONCILE:biz-1:u1");
    expect(authMocks.checkRateLimit.mock.calls[1][0]).toBe("RECONCILE:biz-1:u1");
  });

  it("never honors the E2E bypass in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
    vi.stubEnv("IS_E2E", "1");
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTH_BYPASS", "1");

    const res = await POST(makeRequest({ businessId: "biz-1", rows: [validRow()] }));

    expect(res.status).toBe(401);
    expect(authMocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("only returns the reviewed response DTO keys recursively", async () => {
    const res = await POST(makeRequest({ rows: [validRow()] }));
    const body = await res.json();
    const allowed = new Set([
      "matches", "row", "externalId", "partNumbers", "brand", "model", "sizeText", "specs", "barcode", "name", "category", "qty",
      "status", "reason", "candidate", "uid", "sizeToken", "partNumber", "confidence", "matchBasis", "candidates", "linkageSuggestion", "viaAffixCore",
      "retailCatalogMatch", "productName", "familyLabel",
    ]);
    const assertAllowed = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(assertAllowed);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          expect(allowed.has(key)).toBe(true);
          assertAllowed(child);
        }
      }
    };
    assertAllowed(body);
  });
});

describe("POST /api/reconcile/match - validation (400 on garbage)", () => {
  it("non-JSON body -> 400", async () => {
    const res = await POST(makeRequest("this is not json"));
    expect(res.status).toBe(400);
  });

  it("missing rows -> 400", async () => {
    const res = await POST(makeRequest({ nope: true }));
    expect(res.status).toBe(400);
  });

  it("rows not an array -> 400", async () => {
    const res = await POST(makeRequest({ rows: "many" }));
    expect(res.status).toBe(400);
  });

  it("a row missing partNumbers -> 400", async () => {
    const res = await POST(makeRequest({ rows: [{ externalId: "x", qty: 1, raw: {} }] }));
    expect(res.status).toBe(400);
  });

  it("a row with non-numeric qty -> 400", async () => {
    const res = await POST(makeRequest({ rows: [validRow({ qty: "four" })] }));
    expect(res.status).toBe(400);
  });

  it("no backend lookup runs when validation fails", async () => {
    await POST(makeRequest({ rows: "garbage" }));
    expect(mockLookupAll).not.toHaveBeenCalled();
    expect(mockBySize).not.toHaveBeenCalled();
  });
});

describe("POST /api/reconcile/match - matching through the mocked local corpus", () => {
  it("keeps the two-row universal-import fixture deterministic: Falken matches and WIDGET-100 is unmatched", async () => {
    mockLookupAll.mockImplementation(async (key: string) => (key === "28030703" ? [FALKEN_IMPORT_ROW] : []));

    const response = await POST(makeRequest({ rows: [
      validRow({ externalId: "28030703", partNumbers: ["28030703"], brand: "Falken", model: "Wildpeak A/T3W", sizeText: "LT275/70R18" }),
      // Give the otherwise unknown row a tire signal. Without one the matcher
      // correctly classifies it as non_tire, which is a different contract.
      validRow({ externalId: "WIDGET-100", partNumbers: ["WIDGET-100"], brand: "Acme", model: "Widget tire", sizeText: undefined }),
    ] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.matches).toMatchObject([
      { status: "matched", matchBasis: "part_number_exact", candidate: { uid: "falken-28030703", brand: "Falken" } },
      { status: "unmatched" },
    ]);
  });

  it("PN hit corroborated by brand + size -> matched, with linkageSuggestion carried through", async () => {
    mockLookupAll.mockImplementation(async (key: string) => (key === "90000027117" ? [CORPUS_ROW] : []));

    const res = await POST(makeRequest({ rows: [validRow()] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].status).toBe("matched");
    expect(body.matches[0].candidate.uid).toBe("uid-1");
    expect(body.matches[0].linkageSuggestion).toEqual({
      barcode: "029142869870",
      partNumber: "90000027117",
    });
  });

  it("passes the NORMALIZED part-number key to the index (matcher normalizes, dep does not)", async () => {
    await POST(makeRequest({ rows: [validRow({ partNumbers: ["9000 002-7117"] })] }));
    expect(mockLookupAll).toHaveBeenCalledWith("90000027117");
  });

  it("PN miss but exact size + brand + model identity -> matched via the size rung", async () => {
    mockBySize.mockImplementation(async (token: string) => (token === "265/70R17" ? [CORPUS_ROW] : []));

    const res = await POST(
      makeRequest({ rows: [validRow({ partNumbers: ["UNKNOWN-PN"], model: "Discoverer AT3" })] }),
    );
    const body = await res.json();
    expect(body.matches[0].status).toBe("matched");
    expect(body.matches[0].candidate.uid).toBe("uid-1");
  });

  it("no hit anywhere -> honest unmatched with a reason", async () => {
    const res = await POST(makeRequest({ rows: [validRow({ partNumbers: ["NOPE"] })] }));
    const body = await res.json();
    expect(body.matches[0].status).toBe("unmatched");
    expect(body.matches[0].reason).toBeTruthy();
  });

  it("adds exact retail-corpus evidence to a non-tire barcode row", async () => {
    mockRetailLookup.mockResolvedValue({
      productName: "Sparkling Water",
      brand: "Acme",
      category: "Beverages",
      barcode: "012345678905",
    });
    const res = await POST(makeRequest({ rows: [validRow({
      externalId: "012345678905",
      partNumbers: ["012345678905"],
      brand: "Acme",
      model: "Sparkling Water",
      sizeText: undefined,
      specs: "Beverages",
      barcode: "012345678905",
    })] }));
    const body = await res.json();
    expect(mockRetailLookup).toHaveBeenCalledWith("012345678905");
    expect(body.matches[0].retailCatalogMatch).toEqual({
      productName: "Sparkling Water",
      brand: "Acme",
      category: "Beverages",
      barcode: "012345678905",
    });
  });
});

describe("POST /api/reconcile/match - distributor-affix core lookup", () => {
  it("pre-fetches the numeric core so an affixed row PN resolves via a core-keyed corpus row", async () => {
    // Corpus stores the bare core "90000027117"; the shop row carries an affixed "COOP-90000027117".
    mockLookupAll.mockImplementation(async (key: string) =>
      key === "90000027117" ? [CORPUS_ROW] : [],
    );
    const res = await POST(makeRequest({ rows: [validRow({ partNumbers: ["COOP-90000027117"] })] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.matches[0].status).toBe("matched");
    // The core key was pre-fetched (not only the raw affixed key).
    expect(mockLookupAll).toHaveBeenCalledWith("90000027117");
  });
});
