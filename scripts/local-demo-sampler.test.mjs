import assert from "node:assert/strict";
import test from "node:test";

import {
  mapDatabaseRow,
  paddingEquivalenceKey,
  sampleTireRows,
} from "./local-demo-sampler.mjs";

function checkDigit(body) {
  let sum = 0;
  for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(body[index]) * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

function barcodeFor(index, ean = false) {
  const body = `${ean ? "2" : "7"}${String(index).padStart(ean ? 11 : 10, "0")}`;
  return `${body}${checkDigit(body)}`;
}

function row(index, patch = {}) {
  return {
    barcode: barcodeFor(index, patch.barcode_type === "ean"),
    barcode_type: "upc",
    canonical_product_uid: `TIRE_${String(index).padStart(5, "0")}`,
    brand: `Brand ${index % 17}`,
    model: `Model ${index}`,
    model_display: "",
    size: "225/65R17",
    load_index: "102",
    speed_rating: "H",
    manufacturer_part_number: "",
    type: "passenger",
    season: "all season",
    source_count: 2,
    confidence: "verified_2src",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    field_completeness_score: 90,
    ...patch,
  };
}

function fixtureRows() {
  const rows = [];
  for (let index = 0; index < 250; index += 1) {
    rows.push(row(index, { manufacturer_part_number: `REP-${Math.floor(index / 2)}` }));
  }
  for (let index = 250; index < 300; index += 1) rows.push(row(index, { manufacturer_part_number: `UNIQUE-${index}` }));
  for (let index = 300; index < 600; index += 1) rows.push(row(index, { season: "winter" }));
  for (let index = 600; index < 900; index += 1) rows.push(row(index, { size: "LT265/70R17" }));
  for (let index = 900; index < 1200; index += 1) rows.push(row(index, { source_count: 5 }));
  for (let index = 1200; index < 1500; index += 1) rows.push(row(index, { confidence: "verified_1src_strong" }));
  for (let index = 1500; index < 1800; index += 1) rows.push(row(index, { field_completeness_score: 70 }));
  for (let index = 1800; index < 2100; index += 1) rows.push(row(index, { source_count: 3 }));
  for (let index = 2100; index < 2400; index += 1) rows.push(row(index, { barcode_type: "ean" }));
  for (let index = 2400; index < 3000; index += 1) rows.push(row(index));
  return rows;
}

test("sampler deterministically creates the complete immutable 30-batch allocation", () => {
  const input = fixtureRows();
  const one = sampleTireRows(input, { seed: "scanbin-local-tire-demo-v1" });
  const two = sampleTireRows(input, { seed: "scanbin-local-tire-demo-v1" });
  const changedSeed = sampleTireRows(input, { seed: "another-seed" });

  assert.deepEqual(one, two);
  assert.notDeepEqual(one.map((entry) => entry.barcode), changedSeed.map((entry) => entry.barcode));
  assert.equal(one.length, 3000);
  assert.equal(new Set(one.map((entry) => entry.barcode)).size, 3000);
  assert.equal(new Set(one.map((entry) => entry.canonicalProductUid)).size, 3000);
  assert.equal(new Set(one.map((entry) => paddingEquivalenceKey(entry.barcode))).size, 3000);
  assert.deepEqual([...new Set(one.map((entry) => entry.agent))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (let agent = 1; agent <= 10; agent += 1) assert.equal(one.filter((entry) => entry.agent === agent).length, 300);
  for (let batch = 1; batch <= 30; batch += 1) assert.equal(one.filter((entry) => entry.batch === batch).length, 100);
  assert.deepEqual(Object.fromEntries([...new Set(one.map((entry) => entry.stratum))].map((stratum) => [stratum, one.filter((entry) => entry.stratum === stratum).length])), {
    mpn_repeated: 250, mpn_unique: 50, winter_or_all_terrain: 300, size_lt_or_flotation: 300,
    source_count_5plus: 300, verified_1src_strong: 300, completeness_70_or_lower: 300,
    source_count_3: 300, barcode_ean13: 300, barcode_upc: 300, remaining_brand_size_diversity: 300,
  });
});

test("sampler maps database columns and fails closed on invalid or insufficient input", () => {
  assert.deepEqual(mapDatabaseRow(row(1, { model_display: "Display", field_completeness_score: 0.7 })), {
    barcode: barcodeFor(1), barcodeType: "upc", canonicalProductUid: "TIRE_00001", brand: "Brand 1",
    model: "Display", size: "225/65R17", loadIndex: "102", speedRating: "H", manufacturerPartNumber: "",
    type: "passenger", season: "all season", sourceCount: 2, confidence: "verified_2src",
    currentStatus: "active_retail", usableFor: "auto_count_candidate", fieldCompletenessScore: 70,
  });
  assert.equal(paddingEquivalenceKey(`0${barcodeFor(2)}`), barcodeFor(2));
  assert.throws(() => sampleTireRows(fixtureRows().slice(1), { seed: "scanbin-local-tire-demo-v1" }), /requires|Need 3000/i);
  const rejected = [
    row(3001, { barcode_type: "gtin14", barcode: `10${barcodeFor(3)}` }),
    row(3002, { usable_for: "review_candidate" }),
    row(3003, { source_count: 1 }),
    row(3004, { brand: "" }),
    row(3005, { barcode: "700000000000" }),
  ];
  assert.throws(() => sampleTireRows([...fixtureRows().slice(0, 2995), ...rejected], { seed: "scanbin-local-tire-demo-v1" }), /requires|Need 3000/i);
});
