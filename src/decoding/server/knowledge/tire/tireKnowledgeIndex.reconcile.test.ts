import { describe, it, expect, beforeEach, vi } from "vitest";

// Task 7 (Shop-Ware reconcile round): the two index helpers the /api/reconcile/match route builds
// MatcherDeps from. Mirrors the mock style of tireKnowledgeIndex.turso.test.ts - an in-memory fake
// Turso client and a fake SQLite handle, NEVER a live connection or the real 76k-row JSON.
//
// Contract under test (carry-forward review note from Task 5):
//  - lookupAllByPartNumber does a DIRECT keyed lookup with NO re-normalization (the matcher already
//    normalized the PN before calling the dep) and returns ALL hits, never LIMIT 1.
//  - candidatesBySizeToken returns every corpus row whose canonical (space-stripped, uppercased)
//    size equals the given token.

const mockGetKnowledgeDb = vi.fn();
vi.mock("@/decoding/server/knowledge/knowledgeDb", () => ({
  getKnowledgeDb: () => mockGetKnowledgeDb(),
  __resetKnowledgeDbForTests: () => {},
}));

const mockGetRetailTursoClient = vi.fn();
vi.mock("@/decoding/server/knowledge/retail/retailKnowledgeIndex", () => ({
  getTursoClient: () => mockGetRetailTursoClient(),
}));

import {
  lookupAllByPartNumber,
  candidatesBySizeToken,
  __resetTireKnowledgeCacheForTests,
} from "@/decoding/server/knowledge/tire/tireKnowledgeIndex";

const ROW_A = {
  canonical_product_uid: "uid-a",
  brand: "cooper", brand_normalized: "cooper",
  model: "Discoverer AT3", model_normalized: "discoverer at3",
  size: "265/70R17", raw_size_text: "P265/70R17",
  load_index: "113", speed_rating: "S", load_range: "SL",
  type: "all_season", season: "all_season",
  manufacturer_part_number: "90000027117",
  barcode: "029142869870", barcode_type: "upc_a",
  confidence: "verified_2src", current_status: "active", usable_for: "sale",
  field_completeness_score: "1.0", missing_fields: "", source_count: 2,
};
const ROW_B = {
  ...ROW_A,
  canonical_product_uid: "uid-b",
  brand: "mastercraft", brand_normalized: "mastercraft",
  model: "Courser AXT2", model_normalized: "courser axt2",
  barcode: "029142869871",
};

/** Fake better-sqlite3 handle: prepare() returns a stmt whose all() answers from the given rows. */
function fakeSqlite(rowsBySql: (sql: string, arg: string) => unknown[]) {
  const prepared: { sql: string; args: string[] }[] = [];
  return {
    prepared,
    prepare(sql: string) {
      return {
        all: (arg: string) => {
          prepared.push({ sql, args: [arg] });
          return rowsBySql(sql, arg);
        },
        get: (arg: string) => {
          prepared.push({ sql, args: [arg] });
          return rowsBySql(sql, arg)[0];
        },
      };
    },
  };
}

function fakeTursoClient(handler: (sql: string, args: unknown[]) => unknown[]) {
  const calls: { sql: string; args: unknown[] }[] = [];
  return {
    calls,
    async execute({ sql, args }: { sql: string; args: unknown[] }) {
      calls.push({ sql, args });
      return { rows: handler(sql, args) };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTireKnowledgeCacheForTests();
});

describe("lookupAllByPartNumber", () => {
  it("SQLite present: returns ALL rows for the key (never LIMIT 1)", async () => {
    const db = fakeSqlite((sql, arg) =>
      sql.includes("manufacturer_part_number") && arg === "90000027117" ? [ROW_A, ROW_B] : [],
    );
    mockGetKnowledgeDb.mockReturnValue(db);

    const rows = await lookupAllByPartNumber("90000027117");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.canonical_product_uid).sort()).toEqual(["uid-a", "uid-b"]);
    expect(mockGetRetailTursoClient).not.toHaveBeenCalled();
  });

  it("does NOT re-normalize the key: the exact caller-provided key reaches the query verbatim", async () => {
    const db = fakeSqlite(() => []);
    mockGetKnowledgeDb.mockReturnValue(db);

    await lookupAllByPartNumber("ab c-123"); // if re-normalized this would become ABC123
    const call = db.prepared.find((p) => p.sql.includes("manufacturer_part_number"));
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("ab c-123");
  });

  it("empty key -> [] without touching any backend", async () => {
    const db = fakeSqlite(() => [ROW_A]);
    mockGetKnowledgeDb.mockReturnValue(db);
    expect(await lookupAllByPartNumber("")).toEqual([]);
    expect(db.prepared).toHaveLength(0);
  });

  it("SQLite absent: Turso answers via the part-number join and ALL rows come back", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient((sql, args) =>
      sql.includes("tire_part_numbers") && args[0] === "90000027117" ? [ROW_A, ROW_B] : [],
    );
    mockGetRetailTursoClient.mockResolvedValue(client);

    const rows = await lookupAllByPartNumber("90000027117");
    expect(rows).toHaveLength(2);
    expect(rows[0].source_count).toBe(2);
    expect(typeof rows[0].source_count).toBe("number");
  });

  it("SQLite absent + Turso throws -> [] (fail-safe, never throws)", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    mockGetRetailTursoClient.mockResolvedValue({
      async execute() { throw new Error("simulated network error"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(lookupAllByPartNumber("NOPE-NOT-REAL")).resolves.toEqual([]);
    warn.mockRestore();
  });
});

describe("candidatesBySizeToken", () => {
  it("SQLite present: returns all rows whose canonical size equals the token", async () => {
    const db = fakeSqlite((sql, arg) =>
      sql.includes("size") && arg === "265/70R17" ? [ROW_A, ROW_B] : [],
    );
    mockGetKnowledgeDb.mockReturnValue(db);

    const rows = await candidatesBySizeToken("265/70R17");
    expect(rows).toHaveLength(2);
  });

  it("empty token -> [] without touching any backend", async () => {
    const db = fakeSqlite(() => [ROW_A]);
    mockGetKnowledgeDb.mockReturnValue(db);
    expect(await candidatesBySizeToken("")).toEqual([]);
    expect(db.prepared).toHaveLength(0);
  });

  it("SQLite absent: Turso answers the size query", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient((sql, args) =>
      sql.toLowerCase().includes("size") && args[0] === "265/70R17" ? [ROW_A] : [],
    );
    mockGetRetailTursoClient.mockResolvedValue(client);

    const rows = await candidatesBySizeToken("265/70R17");
    expect(rows).toHaveLength(1);
    expect(rows[0].brand).toBe("cooper");
  });

  it("SQLite absent + Turso throws -> [] (fail-safe, never throws)", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    mockGetRetailTursoClient.mockResolvedValue({
      async execute() { throw new Error("simulated network error"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A size shape that cannot exist in the committed JSON fixture, so the (correct) post-Turso
    // JSON fallback cannot mask the fail-safe path under test.
    await expect(candidatesBySizeToken("999/99R99")).resolves.toEqual([]);
    warn.mockRestore();
  });
});
