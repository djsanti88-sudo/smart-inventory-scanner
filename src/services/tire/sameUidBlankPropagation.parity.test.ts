import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTireSize } from "@/services/tire/tireSizeNormalizer";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
const temporaryDirectories: string[] = [];

function nodeNormalize(value: string): string | null {
  const source = "import('./scripts/tire-db-repair/12_same_uid_blank_propagation.mjs').then(m=>process.stdout.write(m.normalizeSize(process.argv[1])))";
  const out = execFileSync(process.execPath, ["-e", source, value], { cwd: process.cwd(), encoding: "utf8" }).trim();
  return out || null;
}

function runSameUidBlankPropagation(dbPath: string) {
  const source = "import('./scripts/tire-db-repair/12_same_uid_blank_propagation.mjs').then(({runSameUidBlankPropagation})=>process.stdout.write(JSON.stringify(runSameUidBlankPropagation({dbPath:process.argv[1],execute:true}))))";
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, dbPath], { cwd: process.cwd(), encoding: "utf8" }));
}

function createRepairFixture(filename: string) {
  const dir = mkdtempSync(join(tmpdir(), "same-uid-normalizer-"));
  temporaryDirectories.push(dir);
  const db = new Database(join(dir, filename));
  db.exec(`
    CREATE TABLE tires (barcode TEXT PRIMARY KEY, canonical_product_uid TEXT, brand TEXT, model TEXT, size TEXT, manufacturer_part_number TEXT);
    CREATE TABLE canonical_tire_products (canonical_product_id TEXT PRIMARY KEY, brand TEXT, model TEXT, size TEXT);
    CREATE TABLE remaining_blank_fill_audit (audit_id INTEGER PRIMARY KEY, action TEXT, trust_color TEXT, confidence_score INTEGER, canonical_product_uid TEXT, barcode TEXT, previous_value TEXT, new_value TEXT, candidate_count INTEGER, candidate_values TEXT, reason TEXT, created_at TEXT);
    CREATE TABLE provenance (id INTEGER PRIMARY KEY, product_id TEXT, barcode TEXT, source_name TEXT, source_ref TEXT, sheet TEXT, row TEXT, batch_id TEXT, imported_at TEXT, evidence_level TEXT, license_note TEXT, content_hash TEXT);
    CREATE TABLE tire_part_numbers (id INTEGER PRIMARY KEY, canonical_product_uid TEXT, part_number TEXT, normalized_part_number TEXT);
    CREATE TABLE tire_product_part_number_aliases (canonical_product_id TEXT, normalized_part_number TEXT, display_part_number TEXT, source TEXT, trust_color TEXT, confidence_score INTEGER, is_unambiguous INTEGER);
    CREATE TABLE tire_barcode_aliases (barcode TEXT PRIMARY KEY, barcode_type TEXT, canonical_product_id TEXT NOT NULL, source_table TEXT, alias_confidence TEXT);
    INSERT INTO canonical_tire_products VALUES ('U1','','','');
    INSERT INTO tires VALUES ('donor','U1','Fortune Tires','Tormenta R/T','35x12.50r17','PN1'), ('blank','U1','','','','PN1');
    INSERT INTO provenance (id,barcode,content_hash) VALUES (1,'donor','p1');
    INSERT INTO tire_part_numbers (canonical_product_uid,part_number,normalized_part_number) VALUES ('U1','PN1','PN1');
    INSERT INTO tire_product_part_number_aliases VALUES ('U1','PN1','PN1','test','green',100,1);
    INSERT INTO tire_barcode_aliases VALUES ('donor','upc','U1','tires','verified'), ('blank','upc','U1','tires','verified');
  `);
  return db;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("same-UID repair size normalizer parity", () => {
  it("propagates a unique donor into a distinct repaired seven-table fixture and audits each child fill", () => {
    const source = createRepairFixture("source.db");
    const repaired = createRepairFixture("repaired.db");
    try {
      const tableNames = ["tires", "canonical_tire_products", "remaining_blank_fill_audit", "provenance", "tire_part_numbers", "tire_product_part_number_aliases", "tire_barcode_aliases"];
      for (const db of [source, repaired]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row: { name: string }) => row.name)).toEqual(expect.arrayContaining(tableNames));
      }
      expect(source.prepare("SELECT brand, model, size FROM tires WHERE barcode='blank'").get()).toEqual({ brand: "", model: "", size: "" });
      const result = runSameUidBlankPropagation(repaired.name);
      expect(result.executed).toBe(true);
      expect(result.plan.childChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ uid: "U1", barcode: "blank", field: "brand", value: "Fortune Tires", donorBarcode: "donor" }),
        expect.objectContaining({ uid: "U1", barcode: "blank", field: "model", value: "Tormenta R/T", donorBarcode: "donor" }),
        expect.objectContaining({ uid: "U1", barcode: "blank", field: "size", value: "35x12.50r17", donorBarcode: "donor" }),
      ]));
      expect(repaired.prepare("SELECT brand, model, size FROM tires WHERE barcode='blank'").get()).toEqual({ brand: "Fortune Tires", model: "Tormenta R/T", size: "35x12.50r17" });
      expect(repaired.prepare("SELECT brand, model, size FROM canonical_tire_products WHERE canonical_product_id='U1'").get()).toEqual({ brand: "Fortune Tires", model: "Tormenta R/T", size: "35x12.50r17" });
      expect(repaired.prepare("SELECT action, canonical_product_uid, barcode, previous_value, new_value, candidate_count FROM remaining_blank_fill_audit ORDER BY audit_id").all()).toEqual([
        { action: "backfill_from_same_canonical_uid_unique_value_v1:brand", canonical_product_uid: "U1", barcode: "blank", previous_value: "", new_value: "Fortune Tires", candidate_count: 1 },
        { action: "backfill_from_same_canonical_uid_unique_value_v1:model", canonical_product_uid: "U1", barcode: "blank", previous_value: "", new_value: "Tormenta R/T", candidate_count: 1 },
        { action: "backfill_from_same_canonical_uid_unique_value_v1:size", canonical_product_uid: "U1", barcode: "blank", previous_value: "", new_value: "35x12.50r17", candidate_count: 1 },
      ]);
      const donorSizes = source.prepare(`SELECT DISTINCT s.size FROM tires t JOIN tires s ON s.canonical_product_uid=t.canonical_product_uid WHERE TRIM(COALESCE(t.size,''))='' AND TRIM(COALESCE(s.size,''))<>'' ORDER BY s.size`).all().map((row: { size: string }) => row.size);
      for (const value of [...donorSizes, "not a tire", "35X12.50R17JUNK", "235/40R19XL", "265/70R17", "245/65-17", "99X12.50R20", "11R99"]) {
        expect(nodeNormalize(value), value).toBe(normalizeTireSize(value));
      }
    } finally {
      source.close();
      repaired.close();
    }
  });
});
