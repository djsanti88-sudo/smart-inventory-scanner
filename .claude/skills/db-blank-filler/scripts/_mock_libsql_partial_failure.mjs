// Test-only mock of @libsql/client that succeeds on the FIRST table copy (tires) then throws on
// the SECOND (tire_part_numbers), simulating a network drop or crash mid-transfer. Used only by
// turso_snapshot.test.mjs via an ESM resolution hook (_mock_libsql_loader.mjs); never imported by
// the real turso_snapshot.mjs and never touches live Turso.
let calls = 0;
export function createClient() {
  return {
    async execute() {
      calls++;
      if (calls === 1) {
        return {
          columns: [
            "barcode", "canonical_product_uid", "brand", "brand_normalized", "model",
            "model_normalized", "size", "raw_size_text", "load_index", "speed_rating",
            "load_range", "type", "season", "manufacturer_part_number", "barcode_type",
            "confidence", "current_status", "usable_for", "field_completeness_score",
            "missing_fields", "source_count", "model_display",
          ],
          rows: [{
            barcode: "123456789012", canonical_product_uid: "U1", brand: "B", brand_normalized: "b",
            model: "M", model_normalized: "m", size: "1", raw_size_text: "1", load_index: null,
            speed_rating: null, load_range: null, type: null, season: null,
            manufacturer_part_number: null, barcode_type: "upc", confidence: null,
            current_status: null, usable_for: null, field_completeness_score: null,
            missing_fields: null, source_count: 0, model_display: null,
          }],
        };
      }
      throw new Error("SIMULATED_NETWORK_DROP_MID_TRANSFER");
    },
  };
}
