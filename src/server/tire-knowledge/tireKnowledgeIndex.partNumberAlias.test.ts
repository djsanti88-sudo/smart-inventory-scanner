import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// Task A4: tire_product_part_number_aliases fallback. Boss/distributor data teaches a part-number
// alias that the canonical tires/tire_part_numbers tables never store (e.g. BH1600974 -> the same
// product whose own manufacturer_part_number is 1600974). This suite proves:
//   1. An affix-style alias resolves to its canonical product, via BOTH the local-SQLite path and
//      the Turso path, but ONLY after the canonical tire_part_numbers/tires lookup already missed.
//   2. An ambiguous alias (the normalized key maps to more than one distinct canonical_product_id)
//      returns null - never guesses by picking a row.
//   3. Existing exact lookups (raw part number already on `tires.manufacturer_part_number`) are
//      unchanged - the alias table is never consulted when the canonical lookup already hit.

const mockGetKnowledgeDb = vi.fn();
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => mockGetKnowledgeDb(),
  __resetKnowledgeDbForTests: () => {},
}));

const mockGetRetailTursoClient = vi.fn();
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  getTursoClient: () => mockGetRetailTursoClient(),
}));

import {
  lookupByExactBarcode,
  lookupByExactPartNumber,
  __resetTireKnowledgeCacheForTests,
} from "@/server/tire-knowledge/tireKnowledgeIndex";

beforeEach(() => {
  vi.clearAllMocks();
  __resetTireKnowledgeCacheForTests();
});

/** Minimal real schema (tires + tire_product_part_number_aliases) matching the working DB's actual
 *  column shapes, backed by a genuine in-memory better-sqlite3 connection (never a faked SQL mock). */
function buildRealDb(options: {
  tires: Array<{ canonical_product_uid: string; manufacturer_part_number: string; barcode: string; brand?: string }>;
  aliases?: Array<{ canonical_product_id: string; normalized_part_number: string; display_part_number: string }>;
}) {
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
    );
    CREATE TABLE tire_product_part_number_aliases (
      canonical_product_id TEXT NOT NULL,
      normalized_part_number TEXT NOT NULL,
      display_part_number TEXT NOT NULL,
      source TEXT NOT NULL,
      trust_color TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      is_unambiguous INTEGER NOT NULL,
      PRIMARY KEY (canonical_product_id, normalized_part_number)
    );
  `);
  const insertTire = db.prepare(`
    INSERT INTO tires (barcode, canonical_product_uid, manufacturer_part_number, brand)
    VALUES (@barcode, @canonical_product_uid, @manufacturer_part_number, @brand)
  `);
  for (const row of options.tires) insertTire.run({ brand: "", ...row });

  const insertAlias = db.prepare(`
    INSERT INTO tire_product_part_number_aliases
      (canonical_product_id, normalized_part_number, display_part_number, source, trust_color, confidence_score, is_unambiguous)
    VALUES (@canonical_product_id, @normalized_part_number, @display_part_number, 'boss_source:test', 'green', 100, 1)
  `);
  for (const row of options.aliases ?? []) insertAlias.run(row);

  return db;
}

describe("lookupByExactPartNumber - part-number ALIAS table fallback (Task A4, real SQLite path)", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("affix alias (BH1600974 -> canonical 1600974) resolves via the alias table after the canonical lookup misses", () => {
    db = buildRealDb({
      tires: [{ barcode: "8848116009744", canonical_product_uid: "TIRE_AAA", manufacturer_part_number: "1600974" }],
      aliases: [{ canonical_product_id: "TIRE_AAA", normalized_part_number: "BH1600974", display_part_number: "BH1600974" }],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    return lookupByExactPartNumber("BH1600974").then((row) => {
      expect(row).not.toBeNull();
      expect(row!.canonical_product_uid).toBe("TIRE_AAA");
      expect(row!.manufacturer_part_number).toBe("1600974");
    });
  });

  it("a second real-world alias shape (F28847017 -> canonical 28847017) also resolves", () => {
    db = buildRealDb({
      tires: [{ barcode: "029142800001", canonical_product_uid: "TIRE_BBB", manufacturer_part_number: "28847017" }],
      aliases: [{ canonical_product_id: "TIRE_BBB", normalized_part_number: "F28847017", display_part_number: "F28847017" }],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    return lookupByExactPartNumber("F28847017").then((row) => {
      expect(row).not.toBeNull();
      expect(row!.canonical_product_uid).toBe("TIRE_BBB");
    });
  });

  it("ambiguous alias (same normalized key -> two different products) returns null, never guesses", () => {
    db = buildRealDb({
      tires: [
        { barcode: "029142800002", canonical_product_uid: "TIRE_CCC", manufacturer_part_number: "555000" },
        { barcode: "029142800003", canonical_product_uid: "TIRE_DDD", manufacturer_part_number: "666000" },
      ],
      aliases: [
        { canonical_product_id: "TIRE_CCC", normalized_part_number: "AMBIG123", display_part_number: "AMBIG123" },
        { canonical_product_id: "TIRE_DDD", normalized_part_number: "AMBIG123", display_part_number: "AMBIG123" },
      ],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    return lookupByExactPartNumber("AMBIG123").then((row) => {
      expect(row).toBeNull();
    });
  });

  it("ambiguous canonical manufacturer part number returns null instead of selecting the first product", async () => {
    db = buildRealDb({
      tires: [
        { barcode: "029142800007", canonical_product_uid: "TIRE_PN_A", manufacturer_part_number: "DUP-100" },
        { barcode: "029142800008", canonical_product_uid: "TIRE_PN_B", manufacturer_part_number: "dup 100" },
      ],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    await expect(lookupByExactPartNumber("DUP100")).resolves.toBeNull();
  });

  it("a unique canonical manufacturer part number remains suggested and its barcode stays exact", async () => {
    db = buildRealDb({
      tires: [{ barcode: "029142800009", canonical_product_uid: "TIRE_PN_UNIQUE", manufacturer_part_number: "UNIQUE-100" }],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    await expect(lookupByExactPartNumber("unique 100")).resolves.toMatchObject({ canonical_product_uid: "TIRE_PN_UNIQUE" });
    await expect(lookupByExactBarcode("029142800009")).resolves.toMatchObject({ canonical_product_uid: "TIRE_PN_UNIQUE" });
  });

  it("a part number with no canonical hit and no alias hit returns null", () => {
    db = buildRealDb({
      tires: [{ barcode: "029142800004", canonical_product_uid: "TIRE_EEE", manufacturer_part_number: "111222" }],
      aliases: [],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    return lookupByExactPartNumber("NOTHING-HERE-999").then((row) => {
      expect(row).toBeNull();
    });
  });

  it("existing exact lookup (raw part number already on tires.manufacturer_part_number) is UNCHANGED: canonical hit wins, alias table never consulted", async () => {
    db = buildRealDb({
      tires: [{ barcode: "029142800005", canonical_product_uid: "TIRE_FFF", manufacturer_part_number: "90000027117" }],
      // An alias row exists for the SAME normalized key but points at a DIFFERENT product. If the
      // canonical lookup did not win outright (first-hit-wins per backend), this would prove the
      // alias fallback incorrectly overrode a valid canonical hit.
      aliases: [{ canonical_product_id: "TIRE_WRONG", normalized_part_number: "90000027117", display_part_number: "90000027117" }],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    const aliasTableSpy = vi.spyOn(db, "prepare");
    const row = await lookupByExactPartNumber("90000027117");

    expect(row).not.toBeNull();
    expect(row!.canonical_product_uid).toBe("TIRE_FFF");
    // The alias table SQL must never even be prepared/queried once the canonical key already hit.
    expect(aliasTableSpy.mock.calls.some((call) => String(call[0]).includes("tire_product_part_number_aliases"))).toBe(false);
    aliasTableSpy.mockRestore();
  });

  it("existing affix-core corpus fallback (H1021561 -> corpus's own bare-core 1021561) still resolves without touching the alias table", async () => {
    // This is the PRE-EXISTING tirePartNumberVariants affix-core mechanism (RC1/RC2), which must
    // keep working unchanged now that an alias-table fallback has been added after it.
    db = buildRealDb({
      tires: [{ barcode: "029142800006", canonical_product_uid: "TIRE_GGG", manufacturer_part_number: "1021561" }],
      aliases: [],
    });
    mockGetKnowledgeDb.mockReturnValue(db);

    const row = await lookupByExactPartNumber("H1021561");
    expect(row).not.toBeNull();
    expect(row!.canonical_product_uid).toBe("TIRE_GGG");
  });
});

// -------------------------------------------------------------------------------------------
// Turso path (SQLite absent) - same three properties, mirroring tireKnowledgeIndex.turso.test.ts's
// fake-client style.
// -------------------------------------------------------------------------------------------
function fakeTursoClient(options: {
  partNumberToUid?: Record<string, string | string[]>;
  aliasKeyToUids?: Record<string, string[]>;
  tiresByUid?: Record<string, Record<string, unknown>>;
}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  return {
    calls,
    async execute({ sql, args }: { sql: string; args: unknown[] }) {
      calls.push({ sql, args });
      if (sql.includes("FROM tire_product_part_number_aliases")) {
        const [key] = args as [string];
        const uids = options.aliasKeyToUids?.[key] ?? [];
        return { rows: uids.map((uid) => ({ canonical_product_id: uid })) };
      }
      if (sql.includes("FROM tire_part_numbers")) {
        const [key] = args as [string];
        const mapped = options.partNumberToUid?.[key];
        const uids = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
        return { rows: uids.map((canonical_product_uid) => ({ canonical_product_uid })) };
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

const TIRE_ROW = {
  canonical_product_uid: "TIRE_TURSO_1",
  brand: "blackhawk",
  brand_normalized: "blackhawk",
  model: "Agility UHP AS",
  model_normalized: "agility_uhp_as",
  size: "215/45R17",
  raw_size_text: "215/45R17",
  load_index: "91",
  speed_rating: "W",
  load_range: "",
  type: "all_season",
  season: "all_season",
  manufacturer_part_number: "1600974",
  barcode: "8848116009744",
  barcode_type: "ean",
  confidence: "verified_2src",
  current_status: "active",
  usable_for: "sale",
  field_completeness_score: "1.0",
  missing_fields: "",
  source_count: 1,
};

describe("lookupByExactPartNumber - part-number ALIAS table fallback (Task A4, Turso path)", () => {
  beforeEach(() => {
    mockGetKnowledgeDb.mockReturnValue(null); // force the Turso path
  });

  it("affix alias resolves via Turso only after the canonical tire_part_numbers lookup misses", async () => {
    const client = fakeTursoClient({
      partNumberToUid: {}, // canonical lookup misses on every candidate key
      aliasKeyToUids: { BH1600974: ["TIRE_TURSO_1"] },
      tiresByUid: { TIRE_TURSO_1: TIRE_ROW },
    });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("BH1600974");

    expect(row).not.toBeNull();
    expect(row!.canonical_product_uid).toBe("TIRE_TURSO_1");
    // Proves ordering: the canonical tire_part_numbers query ran BEFORE the alias query.
    const partNumberCallIndex = client.calls.findIndex((c) => c.sql.includes("FROM tire_part_numbers"));
    const aliasCallIndex = client.calls.findIndex((c) => c.sql.includes("FROM tire_product_part_number_aliases"));
    expect(partNumberCallIndex).toBeGreaterThanOrEqual(0);
    expect(aliasCallIndex).toBeGreaterThan(partNumberCallIndex);
  });

  it("ambiguous alias on Turso (key maps to two distinct products) returns null, never guesses", async () => {
    const client = fakeTursoClient({
      partNumberToUid: {},
      aliasKeyToUids: { AMBIGTURSO: ["TIRE_TURSO_1", "TIRE_TURSO_2"] },
      tiresByUid: { TIRE_TURSO_1: TIRE_ROW },
    });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("AMBIGTURSO");
    expect(row).toBeNull();
  });

  it("ambiguous canonical manufacturer part number on Turso returns null instead of selecting the first product", async () => {
    const client = fakeTursoClient({
      partNumberToUid: { DUPTURSO: ["TIRE_TURSO_1", "TIRE_TURSO_2"] },
      tiresByUid: { TIRE_TURSO_1: TIRE_ROW },
    });
    mockGetRetailTursoClient.mockResolvedValue(client);

    await expect(lookupByExactPartNumber("DUPTURSO")).resolves.toBeNull();
  });

  it("canonical tire_part_numbers hit on Turso wins outright; alias table never queried", async () => {
    const client = fakeTursoClient({
      partNumberToUid: { "90000027117": "TIRE_TURSO_1" },
      aliasKeyToUids: { "90000027117": ["TIRE_WRONG"] },
      tiresByUid: { TIRE_TURSO_1: { ...TIRE_ROW, manufacturer_part_number: "90000027117" } },
    });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("90000027117");

    expect(row).not.toBeNull();
    expect(row!.canonical_product_uid).toBe("TIRE_TURSO_1");
    expect(client.calls.some((c) => c.sql.includes("FROM tire_product_part_number_aliases"))).toBe(false);
  });

  it("no canonical hit and no alias hit on Turso falls through to null (never throws)", async () => {
    // The key is verified absent (raw AND affix-core) from the committed corpus JSON, so the
    // post-Turso JSON-fallback tier cannot mask a miss - the result must be exactly null.
    const client = fakeTursoClient({ partNumberToUid: {}, aliasKeyToUids: {} });
    mockGetRetailTursoClient.mockResolvedValue(client);

    const row = await lookupByExactPartNumber("ZZ-NOT-A-REAL-PART-999");
    expect(row).toBeNull();
  });
});
