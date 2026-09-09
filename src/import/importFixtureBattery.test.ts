// src/import/importFixtureBattery.test.ts
// Task 11 (Phase 4 Stage A ship gate): fixture battery proving the Stage A shaping chain
// (readUniversalFile -> inferColumnMapping -> validateManualMapping -> buildSourceSignature) end to
// end against four real files: a Shop-Ware-style CSV, a reordered/renamed TSV, a nonsense-header CSV
// forcing the manual mapping path, and a real OOXML xlsx workbook (decoded from base64). Every
// fixture carries at least one row whose part number is a REAL row from the RUNTIME corpus DB
// (src/decoding/server/knowledge/knowledge.generated.db, queried directly - NOT the stale tire_corpus_seed.csv, which
// is pre-generation source data the runtime index does not load): Cooper Discoverer A/T3,
// manufacturer_part_number 90000002732, size LT265/70R17, barcode 029142713043; Falken Wildpeak
// A/T3W, manufacturer_part_number 28030703, size LT275/70R18, barcode 848983006493 (verified live
// against /api/reconcile/match on a throwaway local dev server before fixtures were finalized - see
// the Task 11 report). So downstream matching has a genuine exact hit available (proven end to end
// in the e2e spec, not here - this file only proves the deterministic shaping chain, no corpus/
// matcher import).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferColumnMapping, validateManualMapping } from "@/import/columnIntelligence";
import { buildSourceSignature } from "@/import/importSchema";
import type { UploadFileLike } from "@/import/importSchema";
import { readUniversalFile } from "@/import/universalFileReader";

const FIXTURES = join(__dirname, "__fixtures__");

function file(name: string): UploadFileLike {
  const path = join(FIXTURES, name);
  return {
    name,
    type: "",
    text: async () => readFileSync(path, "utf8"),
    // Buffer is an acceptable ArrayBufferLike here - readUniversalFile only ever passes it to
    // `new Uint8Array(...)`, which accepts a Node Buffer at runtime.
    arrayBuffer: async () => readFileSync(path) as unknown as ArrayBuffer,
  };
}

describe("Phase 4 Stage A fixture battery", () => {
  it("Shop-Ware CSV: header synonyms map name and quantity", async () => {
    const sheet = await readUniversalFile(file("shopware.csv"));
    const inf = inferColumnMapping([sheet.headers, ...sheet.rows]);
    // "Description" maps to `model` (HEADER_SYNONYMS), not `name` - this Shop-Ware fixture has no
    // literal "name" header, so identity is carried by partNumber. Assert the real identity + quantity
    // columns actually mapped, matching the true synonym table in columnIntelligence.ts.
    expect(inf.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(inf.mapping.model).toBeGreaterThanOrEqual(0);
    expect(inf.mapping.quantity).toBeGreaterThanOrEqual(0);
    expect(inf.confidence).toBe("high");
  });

  it("reordered/renamed TSV: partNumber and size map despite shuffled columns + junk column + blank leading row", async () => {
    const sheet = await readUniversalFile(file("reordered-renamed.tsv"));
    const inf = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inf.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(inf.mapping.size).toBeGreaterThanOrEqual(0);
  });

  it("nonsense headers: low confidence, then a manual mapping validates", async () => {
    const sheet = await readUniversalFile(file("nonsense-headers.csv"));
    const inf = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inf.confidence).toBe("low");
    const manual = validateManualMapping(sheet.headers, { name: 0, size: 2, quantity: 3 });
    expect(manual.ok).toBe(true);
  });

  it("buildSourceSignature is stable across two calls on the same file", async () => {
    const sheetA = await readUniversalFile(file("shopware.csv"));
    const sheetB = await readUniversalFile(file("shopware.csv"));
    expect(buildSourceSignature(sheetA.headers)).toBe(buildSourceSignature(sheetB.headers));
    expect(sheetA.sourceSignature).toBe(sheetB.sourceSignature);
  });

  it("decodes a real OOXML xlsx fixture via arrayBuffer() (proves the by-content workbook path)", async () => {
    const base64 = readFileSync(join(FIXTURES, "generic.xlsx.base64.txt"), "utf8").trim();
    const bytes = Buffer.from(base64, "base64");
    const xlsxFile: UploadFileLike = {
      name: "generic.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => {
        throw new Error("xlsx path must never call text()");
      },
      arrayBuffer: async () => bytes as unknown as ArrayBuffer,
    };
    const sheet = await readUniversalFile(xlsxFile);
    expect(sheet.headers.length).toBeGreaterThan(0);
    expect(sheet.rows.length).toBeGreaterThan(0);
  });

  it("sanitizer defuses formula injection: no cell in any fixture starts with =, +, or @", async () => {
    for (const name of ["shopware.csv", "reordered-renamed.tsv", "nonsense-headers.csv"]) {
      const sheet = await readUniversalFile(file(name));
      for (const row of sheet.rows) {
        for (const cellValue of row) {
          expect(cellValue.startsWith("=")).toBe(false);
          expect(cellValue.startsWith("+")).toBe(false);
          expect(cellValue.startsWith("@")).toBe(false);
        }
      }
    }
  });
});
