import Database from "better-sqlite3";
import type { TireKnowledgeRow } from "@/server/tire-knowledge/tireKnowledgeIndex";

export type TireKnowledgeDbFixtureRow = Pick<
  TireKnowledgeRow,
  | "canonical_product_uid"
  | "brand"
  | "brand_normalized"
  | "model"
  | "model_normalized"
  | "size"
  | "barcode"
  | "barcode_type"
  | "confidence"
  | "current_status"
  | "usable_for"
  | "field_completeness_score"
  | "source_count"
> & Partial<Omit<TireKnowledgeRow,
  | "canonical_product_uid"
  | "brand"
  | "brand_normalized"
  | "model"
  | "model_normalized"
  | "size"
  | "barcode"
  | "barcode_type"
  | "confidence"
  | "current_status"
  | "usable_for"
  | "field_completeness_score"
  | "source_count"
>>;

const columns = [
  "barcode", "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized", "model_display",
  "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season", "manufacturer_part_number",
  "barcode_type", "confidence", "current_status", "usable_for", "field_completeness_score", "missing_fields", "source_count",
] as const;

/** A test-owned, in-memory mirror of the production tires columns read by TireKnowledgeRow. */
export function createTireKnowledgeDbFixture(rows: TireKnowledgeDbFixtureRow[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tires (
      barcode TEXT NOT NULL PRIMARY KEY,
      canonical_product_uid TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '', brand_normalized TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', model_normalized TEXT NOT NULL DEFAULT '', model_display TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '', raw_size_text TEXT NOT NULL DEFAULT '',
      load_index TEXT NOT NULL DEFAULT '', speed_rating TEXT NOT NULL DEFAULT '', load_range TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '', season TEXT NOT NULL DEFAULT '', manufacturer_part_number TEXT NOT NULL DEFAULT '',
      barcode_type TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT '', current_status TEXT NOT NULL DEFAULT '',
      usable_for TEXT NOT NULL DEFAULT '', field_completeness_score TEXT NOT NULL DEFAULT '', missing_fields TEXT NOT NULL DEFAULT '',
      source_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(`INSERT INTO tires (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`);
  for (const row of rows) {
    insert.run({
      ...Object.fromEntries(columns.map((column) => [column, column === "source_count" ? 0 : ""])),
      ...row,
    });
  }
  return db;
}

export function closeTireKnowledgeDbFixture(database: Database.Database): void {
  database.close();
}
