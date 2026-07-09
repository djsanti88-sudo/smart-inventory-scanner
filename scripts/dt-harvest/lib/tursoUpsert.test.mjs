import { describe, it, expect } from "vitest";
import {
  TIRES_COLUMNS,
  normPartKey,
  rowToTursoValues,
  buildUpsertStatements,
  readTursoCredsFromEnvFile,
} from "./tursoUpsert.mjs";

describe("normPartKey", () => {
  it("strips spaces/dashes and uppercases, matching tireKnowledgeIndex.ts's normPartKey", () => {
    expect(normPartKey(" ab-12 34 ")).toBe("AB1234");
    expect(normPartKey("")).toBe("");
    expect(normPartKey(undefined)).toBe("");
  });
});

describe("rowToTursoValues", () => {
  it("maps a corpus row onto TIRES_COLUMNS order, using the passed barcodeKey for the barcode column", () => {
    const row = {
      canonical_product_uid: "uid-1",
      brand: "Bridgestone",
      brand_normalized: "bridgestone",
      model: "Alenza",
      model_normalized: "alenza",
      size: "225/65R17",
      raw_size_text: "225/65R17",
      load_index: "102",
      speed_rating: "H",
      load_range: "",
      type: "",
      season: "",
      manufacturer_part_number: "MPN-1",
      barcode: "092971302481",
      barcode_type: "upc",
      confidence: "verified_1src_strong",
      current_status: "active_retail",
      usable_for: "auto_count_candidate",
      field_completeness_score: "",
      missing_fields: "",
      source_count: 1,
      source: "discounttire", // extra field, not in TIRES_COLUMNS — must be ignored, not error
    };

    const values = rowToTursoValues("092971302481", row);

    expect(values).toHaveLength(TIRES_COLUMNS.length);
    const asObj = Object.fromEntries(TIRES_COLUMNS.map((c, i) => [c, values[i]]));
    expect(asObj.barcode).toBe("092971302481");
    expect(asObj.brand).toBe("Bridgestone");
    expect(asObj.source_count).toBe(1);
    expect(typeof asObj.source_count).toBe("number");
  });

  it("null/undefined fields become empty string, missing source_count becomes 0", () => {
    const values = rowToTursoValues("123", { brand: null, model: undefined });
    const asObj = Object.fromEntries(TIRES_COLUMNS.map((c, i) => [c, values[i]]));
    expect(asObj.brand).toBe("");
    expect(asObj.model).toBe("");
    expect(asObj.source_count).toBe(0);
  });
});

describe("buildUpsertStatements", () => {
  it("builds one tires statement per row, and a tire_part_numbers statement only when manufacturer_part_number is present", () => {
    const newlyAdded = new Map([
      ["111", { brand: "A", canonical_product_uid: "uid-a", manufacturer_part_number: "PN-1", source_count: 0 }],
      ["222", { brand: "B", canonical_product_uid: "uid-b", manufacturer_part_number: "", source_count: 0 }],
    ]);

    const { tireStatements, partNumberStatements } = buildUpsertStatements(newlyAdded);

    expect(tireStatements).toHaveLength(2);
    expect(tireStatements[0].sql).toMatch(/INSERT OR REPLACE INTO tires/);
    expect(tireStatements[0].args[0]).toBe("111");

    expect(partNumberStatements).toHaveLength(1);
    expect(partNumberStatements[0].sql).toMatch(/INSERT OR REPLACE INTO tire_part_numbers/);
    expect(partNumberStatements[0].args).toEqual(["PN1", "uid-a"]);
  });

  it("returns empty statement arrays for an empty map", () => {
    const { tireStatements, partNumberStatements } = buildUpsertStatements(new Map());
    expect(tireStatements).toEqual([]);
    expect(partNumberStatements).toEqual([]);
  });
});

describe("readTursoCredsFromEnvFile", () => {
  it("parses TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from a simple KEY=value env file", () => {
    const fakeReadFileSync = () => 'TURSO_DATABASE_URL="libsql://example.turso.io"\nTURSO_AUTH_TOKEN=abc123\nOTHER=1\n';
    const creds = readTursoCredsFromEnvFile(fakeReadFileSync, ".env.local");
    expect(creds).toEqual({ url: "libsql://example.turso.io", authToken: "abc123" });
  });

  it("returns null when TURSO_DATABASE_URL is absent", () => {
    const fakeReadFileSync = () => "OTHER=1\n";
    expect(readTursoCredsFromEnvFile(fakeReadFileSync, ".env.local")).toBeNull();
  });

  it("returns null when the file cannot be read", () => {
    const fakeReadFileSync = () => {
      throw new Error("ENOENT");
    };
    expect(readTursoCredsFromEnvFile(fakeReadFileSync, ".env.local")).toBeNull();
  });
});
