// Test-only mock of @libsql/client that succeeds for every table with a small deterministic
// row set. Used to prove the write-to-temp-then-rename fix does not break the happy path.
const TABLE_COLUMNS = {
  tires: [
    "barcode", "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized",
    "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season",
    "manufacturer_part_number", "barcode_type", "confidence", "current_status", "usable_for",
    "field_completeness_score", "missing_fields", "source_count", "model_display",
  ],
  tire_part_numbers: ["normalized_part_number", "canonical_product_uid"],
  tire_barcode_aliases: ["barcode", "barcode_type", "canonical_product_id", "source_table", "alias_confidence"],
};

export function createClient() {
  return {
    async execute(sql) {
      if (sql.includes("FROM tires")) {
        return {
          columns: TABLE_COLUMNS.tires,
          rows: [{
            barcode: "999888777001", canonical_product_uid: "MOCK-U1", brand: "MockBrand",
            brand_normalized: "mockbrand", model: "MockModel", model_normalized: "mockmodel",
            size: "1", raw_size_text: "1", load_index: null, speed_rating: null, load_range: null,
            type: null, season: null, manufacturer_part_number: null, barcode_type: "upc",
            confidence: null, current_status: null, usable_for: null,
            field_completeness_score: null, missing_fields: null, source_count: 0, model_display: null,
          }],
        };
      }
      if (sql.includes("FROM tire_part_numbers")) {
        return { columns: TABLE_COLUMNS.tire_part_numbers, rows: [] };
      }
      if (sql.includes("FROM tire_barcode_aliases")) {
        return {
          columns: TABLE_COLUMNS.tire_barcode_aliases,
          rows: [{ barcode: "999888777001", barcode_type: "upc", canonical_product_id: "MOCK-U1", source_table: "mock", alias_confidence: 100 }],
        };
      }
      return { columns: [], rows: [] };
    },
  };
}
