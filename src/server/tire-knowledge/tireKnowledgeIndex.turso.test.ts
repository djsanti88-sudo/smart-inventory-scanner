import { describe, it, expect, beforeEach, vi } from "vitest";

// Tire corpus on Turso (docs/superpowers/specs/2026-07-09-tire-corpus-on-turso.md section 3).
// When local SQLite is unavailable (the Vercel case), tireKnowledgeIndex queries Turso instead of
// falling straight to the in-memory JSON. Mirrors src/server/upc/storage.test.ts's mock style:
// an in-memory fake Turso client, NEVER a live connection.

// Mock the SQLite accessor: tests toggle this per-suite to force "SQLite present" vs "SQLite absent".
const mockGetKnowledgeDb = vi.fn();
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => mockGetKnowledgeDb(),
  __resetKnowledgeDbForTests: () => {},
}));

// Mock the shared Turso client getter reused from retail-knowledge.
const mockGetRetailTursoClient = vi.fn();
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  getTursoClient: () => mockGetRetailTursoClient(),
}));

import {
  lookupByExactBarcode,
  lookupByExactPartNumber,
  __resetTireKnowledgeCacheForTests,
} from "@/server/tire-knowledge/tireKnowledgeIndex";

const TIRE_ROW = {
  canonical_product_uid: "uid-1",
  brand: "cooper",
  brand_normalized: "cooper",
  model: "Discoverer",
  model_normalized: "discoverer",
  size: "265/70R17",
  raw_size_text: "P265/70R17",
  load_index: "113",
  speed_rating: "S",
  load_range: "SL",
  type: "all_season",
  season: "all_season",
  manufacturer_part_number: "90000027117",
  barcode: "029142869870",
  barcode_type: "upc_a",
  confidence: "verified_2src",
  current_status: "active",
  usable_for: "sale",
  field_completeness_score: "1.0",
  missing_fields: "",
  source_count: 2, // stored as a number in Turso rows too, but code must coerce defensively
};

/** In-memory fake Turso client. Tracks executed SQL for assertions, never a live connection. */
function fakeTursoClient(options: {
  tiresByBarcode?: Record<string, typeof TIRE_ROW>;
  tiresByUid?: Record<string, typeof TIRE_ROW>;
  partNumberToUid?: Record<string, string>;
  throwOnExecute?: boolean;
}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  return {
    calls,
    async execute({ sql, args }: { sql: string; args: unknown[] }) {
      calls.push({ sql, args });
      if (options.throwOnExecute) throw new Error("simulated Turso network error");
      if (sql.includes("FROM tires WHERE barcode")) {
        const [key] = args as [string];
        const row = options.tiresByBarcode?.[key];
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM tire_part_numbers")) {
        const [key] = args as [string];
        const uid = options.partNumberToUid?.[key];
        return { rows: uid ? [{ canonical_product_uid: uid }] : [] };
      }
      if (sql.includes("FROM tires WHERE canonical_product_uid")) {
        const [uid] = args as [string];
        const row = options.tiresByUid?.[uid];
        return { rows: row ? [row] : [] };
      }
      throw new Error(`fakeTursoClient: unhandled SQL: ${sql}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTireKnowledgeCacheForTests();
});

describe("tireKnowledgeIndex - Turso lookup path (SQLite absent, the Vercel case)", () => {
  it("(a) SQLite present -> Turso NOT queried; SQLite result returned", async () => {
    const sqliteRow = { ...TIRE_ROW, barcode: "111111111111" };
    const stmt = { get: vi.fn(() => sqliteRow) };
    mockGetKnowledgeDb.mockReturnValue({ prepare: () => stmt });

    const row = await lookupByExactBarcode("111111111111");

    expect(row).toEqual(sqliteRow);
    expect(mockGetRetailTursoClient).not.toHaveBeenCalled();
  });

  it("(b) SQLite absent + Turso has the barcode -> Turso row returned, mapped correctly (source_count numeric)", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({ tiresByBarcode: { "029142869870": TIRE_ROW } });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactBarcode("029142869870");

    expect(row).not.toBeNull();
    expect(row!.brand).toBe("cooper");
    expect(row!.barcode).toBe("029142869870");
    expect(row!.source_count).toBe(2);
    expect(typeof row!.source_count).toBe("number");
  });

  it("normalizes scanner separators before querying Turso", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({ tiresByBarcode: { "029142869870": TIRE_ROW } });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactBarcode("0 29142-869870");
    expect(row?.brand).toBe("cooper");
  });

  it("(c) SQLite absent + Turso miss -> null", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({ tiresByBarcode: {} });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactBarcode("000000000000");
    expect(row).toBeNull();
  });

  it("(d) part-number two-step via Turso returns the right row", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({
      partNumberToUid: { "90000027117": "uid-1" },
      tiresByUid: { "uid-1": TIRE_ROW },
    });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("90000027117");

    expect(row).not.toBeNull();
    expect(row!.brand).toBe("cooper");
    expect(row!.canonical_product_uid).toBe("uid-1");
    // proves the two-step: both queries actually ran
    expect(client.calls.some((c) => c.sql.includes("tire_part_numbers"))).toBe(true);
    expect(client.calls.some((c) => c.sql.includes("canonical_product_uid = ?"))).toBe(true);
  });

  it("part-number miss (no matching normalized_part_number) -> null, second query never issued", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({ partNumberToUid: {} });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("NOT-A-PART");
    expect(row).toBeNull();
    expect(client.calls.some((c) => c.sql.includes("FROM tires WHERE canonical_product_uid"))).toBe(false);
  });

  it("(e) Turso client throws -> returns null (fail-safe), no throw", async () => {
    // Use a code NOT present in the committed JSON fixture so a post-Turso-failure JSON
    // fallback hit can't mask a real Turso throw (the JSON fallback only runs after Turso fails).
    mockGetKnowledgeDb.mockReturnValue(null);
    const client = fakeTursoClient({ throwOnExecute: true });
    mockGetRetailTursoClient.mockResolvedValue(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(lookupByExactBarcode("000000000000")).resolves.toBeNull();
    await expect(lookupByExactPartNumber("NOT-A-REAL-PART")).resolves.toBeNull();
    expect(warn).toHaveBeenCalled(); // logs a one-time warn, like retail does

    warn.mockRestore();
  });

  it("Turso client unavailable (no creds) -> returns null, falls through gracefully", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    mockGetRetailTursoClient.mockResolvedValue(null);

    expect(await lookupByExactBarcode("000000000000")).toBeNull();
    expect(await lookupByExactPartNumber("NOT-A-REAL-PART")).toBeNull();
  });

  it("(f) __resetTireKnowledgeCacheForTests resets the Turso client/stmt cache too", async () => {
    mockGetKnowledgeDb.mockReturnValue(null);
    const client1 = fakeTursoClient({ tiresByBarcode: { "029142869870": TIRE_ROW } });
    mockGetRetailTursoClient.mockResolvedValueOnce(client1);

    await lookupByExactBarcode("029142869870");
    expect(mockGetRetailTursoClient).toHaveBeenCalledTimes(1);

    // Without a reset, the client should stay cached (no second getTursoClient() call).
    const client2 = fakeTursoClient({ tiresByBarcode: { "029142869870": TIRE_ROW } });
    mockGetRetailTursoClient.mockResolvedValueOnce(client2);
    await lookupByExactBarcode("029142869870");
    expect(mockGetRetailTursoClient).toHaveBeenCalledTimes(1); // still cached, not re-fetched

    // After a reset, the getter must be called again (cache cleared).
    __resetTireKnowledgeCacheForTests();
    mockGetRetailTursoClient.mockResolvedValueOnce(client2);
    await lookupByExactBarcode("029142869870");
    expect(mockGetRetailTursoClient).toHaveBeenCalledTimes(2);
  });
});
