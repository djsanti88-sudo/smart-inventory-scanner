import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// Review finding I-1 (whole-branch review, feat/shopware-reconcile-pn-fill):
// getStmtAllPartNumber does `WHERE manufacturer_part_number = ?` against the RAW stored column,
// but the reconcile caller (src/app/api/reconcile/match/route.ts) feeds an ALREADY-NORMALIZED key
// (normPartKey: spaces + hyphens stripped, uppercased). The local SQLite `tires` table stores the
// manufacturer_part_number RAW (hyphens/spaces intact), so any corpus row whose PN contains a
// hyphen or space silently misses on this backend, even though Turso and the JSON fallback (both
// normalized) hit correctly. This test uses a REAL in-memory better-sqlite3 database (not a faked
// SQL-string mock) so it actually exercises the WHERE clause and would have caught the bug.

const mockGetKnowledgeDb = vi.fn();
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => mockGetKnowledgeDb(),
  __resetKnowledgeDbForTests: () => {},
}));

const mockGetRetailTursoClient = vi.fn();
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  getTursoClient: () => mockGetRetailTursoClient(),
}));

import { lookupAllByPartNumber, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";

/** Minimal real tires table matching scripts/build-knowledge-db.mjs's schema (columns this
 *  module's SELECT * relies on), backed by a genuine in-memory better-sqlite3 connection. */
function buildRealTiresDb(rows: Array<{ canonical_product_uid: string; manufacturer_part_number: string; barcode: string }>) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tires (
      barcode TEXT NOT NULL,
      canonical_product_uid TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      brand_normalized TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      model_normalized TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '',
      raw_size_text TEXT NOT NULL DEFAULT '',
      load_index TEXT NOT NULL DEFAULT '',
      speed_rating TEXT NOT NULL DEFAULT '',
      load_range TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      season TEXT NOT NULL DEFAULT '',
      manufacturer_part_number TEXT NOT NULL DEFAULT '',
      barcode_type TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT '',
      current_status TEXT NOT NULL DEFAULT '',
      usable_for TEXT NOT NULL DEFAULT '',
      field_completeness_score TEXT NOT NULL DEFAULT '',
      missing_fields TEXT NOT NULL DEFAULT '',
      source_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  const insert = db.prepare(`
    INSERT INTO tires (barcode, canonical_product_uid, manufacturer_part_number)
    VALUES (@barcode, @canonical_product_uid, @manufacturer_part_number)
  `);
  for (const row of rows) insert.run(row);
  db.exec("CREATE INDEX idx_tire_part_number ON tires(manufacturer_part_number)");
  return db;
}

describe("lookupAllByPartNumber against a REAL SQLite backend (I-1 regression)", () => {
  let db: Database.Database | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTireKnowledgeCacheForTests();
  });

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("matches a HYPHENATED manufacturer_part_number when called with the normalized (hyphen-stripped) key", async () => {
    // Corpus stores the PN raw, hyphen intact (as scripts/build-knowledge-db.mjs writes it).
    db = buildRealTiresDb([
      { barcode: "029142869870", canonical_product_uid: "uid-hyphenated", manufacturer_part_number: "TBAT-I0041295" },
    ]);
    mockGetKnowledgeDb.mockReturnValue(db);

    // The caller (route.ts / identityMatcher) normalizes with normPartKey BEFORE calling this:
    // normPartKey("TBAT-I0041295") === "TBATI0041295".
    const normalizedKey = "TBATI0041295";

    const rows = await lookupAllByPartNumber(normalizedKey);

    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_product_uid).toBe("uid-hyphenated");
  });

  it("still matches a plain (no-hyphen) manufacturer_part_number (no regression on the common case)", async () => {
    db = buildRealTiresDb([
      { barcode: "029142869871", canonical_product_uid: "uid-plain", manufacturer_part_number: "90000027117" },
    ]);
    mockGetKnowledgeDb.mockReturnValue(db);

    const rows = await lookupAllByPartNumber("90000027117");
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_product_uid).toBe("uid-plain");
  });

  it("matches a manufacturer_part_number containing a SPACE the same way", async () => {
    db = buildRealTiresDb([
      { barcode: "029142869872", canonical_product_uid: "uid-spaced", manufacturer_part_number: "TBAT I0041295" },
    ]);
    mockGetKnowledgeDb.mockReturnValue(db);

    const rows = await lookupAllByPartNumber("TBATI0041295");
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_product_uid).toBe("uid-spaced");
  });

  it("returns ALL matching rows, never just the first (no LIMIT), even after normalization", async () => {
    db = buildRealTiresDb([
      { barcode: "029142869873", canonical_product_uid: "uid-a", manufacturer_part_number: "TBAT-I0041295" },
      { barcode: "029142869874", canonical_product_uid: "uid-b", manufacturer_part_number: "tbat-i0041295" },
    ]);
    mockGetKnowledgeDb.mockReturnValue(db);

    const rows = await lookupAllByPartNumber("TBATI0041295");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.canonical_product_uid).sort()).toEqual(["uid-a", "uid-b"]);
  });
});
