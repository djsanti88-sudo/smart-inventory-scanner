// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

// Task 7: POST /api/reconcile/match - runs matchExpectedRow server-side against the local tire
// corpus. NO keys, NO paid calls, NO external network: the only data dependency is the
// tire-knowledge index, mocked here entirely (same isolation style as the route tests around
// /api/ai-lookup - no test may touch a real backend).

vi.mock("server-only", () => ({}));

const mockLookupAll = vi.fn();
const mockBySize = vi.fn();
vi.mock("@/server/tire-knowledge/tireKnowledgeIndex", () => ({
  lookupAllByPartNumber: (key: string) => mockLookupAll(key),
  candidatesBySizeToken: (token: string) => mockBySize(token),
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

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/reconcile/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
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
  vi.clearAllMocks();
  mockLookupAll.mockResolvedValue([]);
  mockBySize.mockResolvedValue([]);
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
