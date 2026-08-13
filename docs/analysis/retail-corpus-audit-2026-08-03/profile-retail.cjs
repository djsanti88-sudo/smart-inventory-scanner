#!/usr/bin/env node
"use strict";

// Read-only, streaming quality profiler for the local retail corpus.
// Usage: node profile-retail.cjs [db-path] [output-json]

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..", "..", "..");
const dbPath = path.resolve(process.argv[2] || path.join(root, "src", "server", "knowledge.generated.db"));
const outputPath = path.resolve(process.argv[3] || path.join(__dirname, "retail-profile.json"));

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

const startedAt = new Date().toISOString();
const timings = {};
function timed(label, fn) {
  const start = performance.now();
  const result = fn();
  timings[label] = Number(((performance.now() - start) / 1000).toFixed(3));
  return result;
}

function gtinValid(code) {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  if (/^(\d)\1+$/.test(code)) return false;
  const digits = [...code].map(Number);
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10 === digits.at(-1);
}

const sentinels = new Set(["unknown", "n/a", "na", "null", "none", "undefined", "-", "?", "not available"]);
const exampleBlocklist = new Set([
  "012345678905", "4006381333931", "5901234123457",
  "0012345670121", "0012345674020", "0012345674037",
]);
const testPattern = /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;

const result = {
  generated_at: startedAt,
  database: {
    path: path.relative(root, dbPath).replaceAll("\\", "/"),
    bytes: fs.statSync(dbPath).size,
    integrity_check: timed("integrity_check", () => db.pragma("integrity_check", { simple: true })),
    schema: timed("schema", () => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = 'retail' OR name LIKE 'idx_retail%' ORDER BY type, name").all()),
  },
  table: {},
  fields: {},
  barcode: {
    length_distribution: {},
    digit_rows: 0,
    non_digit_rows: 0,
    accepted_gtin_length_rows: 0,
    checksum_valid_rows: 0,
    checksum_invalid_rows: 0,
    repeated_digit_rows: 0,
    leading_zero_rows: 0,
    example_blocklist_rows: 0,
  },
  text_quality: {},
  mojibake_samples: [],
  suspected_test_rows: [],
  distributions: {},
  duplicate_shapes: {},
  timings_seconds: timings,
};

result.table = timed("table_summary", () => db.prepare(`
  SELECT
    COUNT(*) AS rows,
    COUNT(DISTINCT barcode) AS distinct_barcodes,
    SUM(CASE WHEN barcode IS NULL OR trim(barcode) = '' THEN 1 ELSE 0 END) AS missing_barcode,
    SUM(CASE WHEN product_name IS NULL OR trim(product_name) = '' THEN 1 ELSE 0 END) AS missing_product_name,
    SUM(CASE WHEN brand IS NULL OR trim(brand) = '' THEN 1 ELSE 0 END) AS missing_brand,
    SUM(CASE WHEN category IS NULL OR trim(category) = '' THEN 1 ELSE 0 END) AS missing_category,
    SUM(CASE WHEN trim(brand) != '' AND trim(category) != '' THEN 1 ELSE 0 END) AS rows_with_brand_and_category,
    SUM(CASE WHEN trim(brand) = '' AND trim(category) = '' THEN 1 ELSE 0 END) AS rows_missing_brand_and_category,
    SUM(CASE WHEN lower(trim(category)) IN ('undefined','unknown','n/a','na','none','null','not found','not available','other','miscellaneous') THEN 1 ELSE 0 END) AS category_nonblank_sentinel_rows
  FROM retail
`).get());

for (const field of ["product_name", "brand", "category"]) {
  result.fields[field] = timed(`field_${field}`, () => db.prepare(`
    SELECT
      COUNT(DISTINCT ${field}) AS distinct_exact,
      SUM(CASE WHEN ${field} IS NULL THEN 1 ELSE 0 END) AS null_rows,
      SUM(CASE WHEN ${field} IS NOT NULL AND trim(${field}) = '' THEN 1 ELSE 0 END) AS blank_rows,
      SUM(CASE WHEN ${field} != trim(${field}) THEN 1 ELSE 0 END) AS outer_whitespace_rows,
      SUM(CASE WHEN instr(${field}, '  ') > 0 THEN 1 ELSE 0 END) AS repeated_space_rows,
      SUM(CASE WHEN instr(${field}, char(10)) > 0 OR instr(${field}, char(13)) > 0 OR instr(${field}, char(9)) > 0 THEN 1 ELSE 0 END) AS control_whitespace_rows,
      SUM(CASE WHEN instr(${field}, '�') > 0 THEN 1 ELSE 0 END) AS replacement_character_rows,
      SUM(CASE WHEN instr(lower(${field}), '&amp;') > 0 OR instr(lower(${field}), '&quot;') > 0 OR instr(lower(${field}), '&#') > 0 THEN 1 ELSE 0 END) AS html_entity_rows,
      SUM(CASE WHEN lower(trim(${field})) IN ('unknown','n/a','na','null','none','undefined','-','?','not available') THEN 1 ELSE 0 END) AS sentinel_rows,
      MIN(length(${field})) AS min_length,
      MAX(length(${field})) AS max_length,
      AVG(length(${field})) AS avg_length
    FROM retail
  `).get());
}

const text = {
  name_equals_brand_normalized_rows: 0,
  name_equals_category_normalized_rows: 0,
  numeric_only_product_name_rows: 0,
  short_product_name_rows: 0,
  very_long_product_name_rows: 0,
  lowercase_product_name_rows: 0,
  uppercase_product_name_rows: 0,
  multi_brand_delimiter_rows: 0,
  test_marker_rows: 0,
  three_character_product_name_rows: 0,
};

const perFieldStreamQuality = Object.fromEntries(["product_name", "brand", "category"].map((field) => [field, {
  c0_control_rows: 0,
  mojibake_sequence_rows: 0,
}]))

const iterator = db.prepare("SELECT barcode, product_name, brand, category FROM retail").iterate();
timed("stream_all_rows", () => {
  for (const row of iterator) {
    const code = String(row.barcode ?? "");
    const name = String(row.product_name ?? "");
    const brand = String(row.brand ?? "");
    const category = String(row.category ?? "");
    result.barcode.length_distribution[code.length] = (result.barcode.length_distribution[code.length] || 0) + 1;
    const digits = /^\d+$/.test(code);
    if (digits) result.barcode.digit_rows++;
    else result.barcode.non_digit_rows++;
    if ([8, 12, 13, 14].includes(code.length) && digits) {
      result.barcode.accepted_gtin_length_rows++;
      if (gtinValid(code)) result.barcode.checksum_valid_rows++;
      else result.barcode.checksum_invalid_rows++;
    }
    if (/^(\d)\1+$/.test(code)) result.barcode.repeated_digit_rows++;
    if (code.length > 1 && code.startsWith("0")) result.barcode.leading_zero_rows++;
    if (exampleBlocklist.has(code)) result.barcode.example_blocklist_rows++;

    const norm = (value) => value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    const normalizedName = norm(name);
    const normalizedBrand = norm(brand);
    const normalizedCategory = norm(category);
    if (normalizedBrand && normalizedName === normalizedBrand) text.name_equals_brand_normalized_rows++;
    if (normalizedCategory && normalizedName === normalizedCategory) text.name_equals_category_normalized_rows++;
    if (/^\d+$/.test(name.trim())) text.numeric_only_product_name_rows++;
    if (name.trim().length < 3) text.short_product_name_rows++;
    if ([...name.trim()].length === 3) text.three_character_product_name_rows++;
    if (name.length > 250) text.very_long_product_name_rows++;
    if (/[a-z]/.test(name) && name === name.toLocaleLowerCase("en-US")) text.lowercase_product_name_rows++;
    if (/[A-Z]/.test(name) && name === name.toLocaleUpperCase("en-US")) text.uppercase_product_name_rows++;
    if (/[,;|]/.test(brand)) text.multi_brand_delimiter_rows++;

    const testLike = exampleBlocklist.has(code) || testPattern.test(name) || testPattern.test(brand);
    if (testLike) {
      text.test_marker_rows++;
      if (result.suspected_test_rows.length < 50) {
        result.suspected_test_rows.push({ barcode: code, product_name: name, brand, category });
      }
    }

    for (const [field, value] of [["product_name", name], ["brand", brand], ["category", category]]) {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
        perFieldStreamQuality[field].c0_control_rows++;
      }
      // Narrow heuristic for UTF-8 bytes decoded as Latin-1. Standalone letters such as â/Ã are valid.
      const mojibakeSequence = /(?:[ÃÂ][\u0080-\u00BF]|â[\u0080-\u00BF\u2000-\u206F€]|ð[\u0080-\u00BF\u2000-\u206F])/u;
      if (mojibakeSequence.test(value)) {
        perFieldStreamQuality[field].mojibake_sequence_rows++;
        if (result.mojibake_samples.length < 50) {
          result.mojibake_samples.push({ barcode: code, field, value });
        }
      }
    }
  }
});
result.text_quality = text;
result.stream_field_quality = perFieldStreamQuality;

function topValues(field, limit = 30) {
  return db.prepare(`
    SELECT ${field} AS value, COUNT(*) AS rows
    FROM retail
    GROUP BY ${field}
    ORDER BY rows DESC, value
    LIMIT ?
  `).all(limit);
}
result.distributions.top_brands = timed("top_brands", () => topValues("brand"));
result.distributions.top_categories = timed("top_categories", () => topValues("category"));
result.distributions.top_product_names = timed("top_product_names", () => topValues("product_name"));
result.distributions.category_sentinels = timed("category_sentinels", () => db.prepare(`
  SELECT lower(trim(category)) AS value, COUNT(*) AS rows
  FROM retail
  WHERE lower(trim(category)) IN ('undefined','uncategorized','unknown','n/a','na','null','none','undefined','-','?','not available')
  GROUP BY lower(trim(category))
  ORDER BY rows DESC, value
`).all());
result.distributions.top_exact_identities = timed("top_exact_identities", () => db.prepare(`
  SELECT product_name, brand, category, COUNT(*) AS rows
  FROM retail
  GROUP BY product_name, brand, category
  HAVING COUNT(*) > 1
  ORDER BY rows DESC, product_name, brand, category
  LIMIT 30
`).all());

result.duplicate_shapes.same_exact_identity = timed("same_exact_identity", () => db.prepare(`
  SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(n), 0) AS rows_in_groups, COALESCE(MAX(n), 0) AS largest_group
  FROM (
    SELECT COUNT(*) AS n
    FROM retail
    GROUP BY product_name, brand, category
    HAVING COUNT(*) > 1
  )
`).get());

result.duplicate_shapes.zero_stripped_barcode = timed("zero_stripped_barcode", () => db.prepare(`
  SELECT COUNT(*) AS collision_groups, COALESCE(SUM(n), 0) AS rows_in_groups, COALESCE(MAX(n), 0) AS largest_group
  FROM (
    SELECT COUNT(*) AS n
    FROM retail
    GROUP BY CASE WHEN ltrim(barcode, '0') = '' THEN '0' ELSE ltrim(barcode, '0') END
    HAVING COUNT(*) > 1
  )
`).get());

result.duplicate_shapes.zero_stripped_conflicting_identity = timed("zero_stripped_conflicting_identity", () => db.prepare(`
  SELECT COUNT(*) AS conflicting_groups, COALESCE(SUM(n), 0) AS rows_in_groups
  FROM (
    SELECT COUNT(*) AS n, COUNT(DISTINCT product_name || char(31) || brand || char(31) || category) AS identities
    FROM retail
    GROUP BY CASE WHEN ltrim(barcode, '0') = '' THEN '0' ELSE ltrim(barcode, '0') END
    HAVING COUNT(*) > 1 AND identities > 1
  )
`).get());

result.duplicate_shapes.brand_name_spans_categories = timed("brand_name_spans_categories", () => db.prepare(`
  SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS rows_in_groups, COALESCE(MAX(category_count), 0) AS max_categories
  FROM (
    SELECT COUNT(*) AS n, COUNT(DISTINCT category) AS category_count
    FROM retail
    GROUP BY lower(trim(product_name)), lower(trim(brand))
    HAVING COUNT(DISTINCT category) > 1
  )
`).get());

result.finished_at = new Date().toISOString();
result.elapsed_seconds = Number(((Date.parse(result.finished_at) - Date.parse(startedAt)) / 1000).toFixed(3));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
db.close();
console.log(JSON.stringify({ output: outputPath, rows: result.table.rows, elapsed_seconds: result.elapsed_seconds }, null, 2));
