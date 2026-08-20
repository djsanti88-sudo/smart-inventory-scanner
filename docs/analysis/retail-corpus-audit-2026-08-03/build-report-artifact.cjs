#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dir = __dirname;
const profile = JSON.parse(fs.readFileSync(path.join(dir, "retail-profile.json"), "utf8"));
const sourceProfile = JSON.parse(fs.readFileSync(path.join(dir, "retail-source-profile.json"), "utf8"));
const pilotProfile = JSON.parse(fs.readFileSync(path.join(dir, "retail-pilot-profile.json"), "utf8"));

const total = profile.table.rows;
const pct = (value, denominator = total) => value / denominator;
const categorySentinels = profile.table.category_nonblank_sentinel_rows;
const effectiveMissingCategory = profile.table.missing_category + categorySentinels;
const sourceTotal = sourceProfile.counts.rows;
const generatedAt = new Date().toISOString();

const completeness = [
  { field: "Product name", missing_rows: profile.table.missing_product_name, missing_rate: pct(profile.table.missing_product_name), present_rows: total - profile.table.missing_product_name, total_rows: total },
  { field: "Brand", missing_rows: profile.table.missing_brand, missing_rate: pct(profile.table.missing_brand), present_rows: total - profile.table.missing_brand, total_rows: total },
  { field: "Category (raw blank)", missing_rows: profile.table.missing_category, missing_rate: pct(profile.table.missing_category), present_rows: total - profile.table.missing_category, total_rows: total },
  { field: "Category (blank + sentinel)", missing_rows: effectiveMissingCategory, missing_rate: pct(effectiveMissingCategory), present_rows: total - effectiveMissingCategory, total_rows: total },
];

const sourceCoverage = [
  { field: "Country", available_rows: sourceProfile.counts.rows_with_countries_en, coverage_rate: pct(sourceProfile.counts.rows_with_countries_en, sourceTotal), source_rows: sourceTotal },
  { field: "Image URL", available_rows: sourceProfile.counts.rows_with_image_url, coverage_rate: pct(sourceProfile.counts.rows_with_image_url, sourceTotal), source_rows: sourceTotal },
  { field: "Quantity", available_rows: sourceProfile.counts.rows_with_quantity, coverage_rate: pct(sourceProfile.counts.rows_with_quantity, sourceTotal), source_rows: sourceTotal },
];

const qualityFlags = [
  { finding: "Category sentinel values", affected_rows: categorySentinels, classification: "Safe normalization", action: "Map to missing; preserve raw value", priority: "P0" },
  { finding: "Repeated spaces in product name", affected_rows: profile.fields.product_name.repeated_space_rows, classification: "Safe display cleanup", action: "Collapse whitespace in normalized display field", priority: "P0" },
  { finding: "Repeated spaces in brand", affected_rows: profile.fields.brand.repeated_space_rows, classification: "Safe display cleanup", action: "Collapse whitespace in normalized display field", priority: "P0" },
  { finding: "HTML entities in product name", affected_rows: profile.fields.product_name.html_entity_rows, classification: "Safe decode with round-trip", action: "Decode in normalized field; retain raw", priority: "P0" },
  { finding: "Narrow double-encoding sequences", affected_rows: profile.stream_field_quality.product_name.mojibake_sequence_rows + profile.stream_field_quality.brand.mojibake_sequence_rows + profile.stream_field_quality.category.mojibake_sequence_rows, classification: "Safe only after round-trip proof", action: "Repair normalized field; preserve raw bytes/value", priority: "P0" },
  { finding: "Numeric-only product names", affected_rows: profile.text_quality.numeric_only_product_name_rows, classification: "Review", action: "Do not promote without exact source evidence", priority: "P1" },
  { finding: "Three-character product names", affected_rows: profile.text_quality.three_character_product_name_rows, classification: "Review", action: "Language-aware review; do not blanket-delete", priority: "P1" },
  { finding: "Comma/semicolon-delimited brand values", affected_rows: profile.text_quality.multi_brand_delimiter_rows, classification: "Structure, not a fill", action: "Parse to brand assertions; keep original ordering", priority: "P1" },
  { finding: "Heuristic test/demo marker", affected_rows: profile.text_quality.test_marker_rows, classification: "Review only", action: "Exact blocklist is hard gate; contextual test terms need adjudication", priority: "P0" },
  { finding: "Exact known example barcode", affected_rows: profile.barcode.example_blocklist_rows, classification: "Safe quarantine", action: "Exclude from serving corpus with reason/evidence", priority: "P0" },
];

const opportunities = [
  { priority: "P0", action: "Add row- and field-level provenance plus a UNIQUE barcode constraint", records: total, trust_rule: "Required for every serving row", expected_result: "Auditable merges and deterministic lookup" },
  { priority: "P0", action: "Normalize category sentinels to missing", records: categorySentinels, trust_rule: "Exact value mapping; raw retained", expected_result: "Honest completeness and cleaner taxonomy" },
  { priority: "P0", action: "Regenerate after splitting hard example rules from contextual review rules", records: profile.text_quality.test_marker_rows, trust_rule: "Only exact/degenerate codes auto-quarantine", expected_result: "Remove known poison without suppressing legitimate test products" },
  { priority: "P1", action: "Create partial-identity review rows for excluded valid GTINs with brand and category", records: sourceProfile.counts.excluded_name_rows_with_brand_and_category, trust_rule: "Suggested/review only; never deterministic known", expected_result: "Recover evidence without fabricating a product name" },
  { priority: "P1", action: "Retain localized category as a source assertion", records: sourceProfile.counts.included_rows_local_category_rescue, trust_rule: "Source-backed raw label; taxonomy mapping separately reviewed", expected_result: "Small direct completeness gain" },
  { priority: "P1", action: "Adjudicate and import new Barcode Lookup pilot rows", records: pilotProfile.counts.new_barcode_rows, trust_rule: "License gate plus exact-code evidence; resolve overlaps first", expected_result: "Adds non-food retail coverage" },
  { priority: "P1", action: "Preserve country, image, and quantity evidence in the backing model", records: sourceProfile.counts.rows_with_countries_en, trust_rule: "Copy exact source fields; no inference", expected_result: "Richer UI and better review prioritization" },
  { priority: "P2", action: "Version a canonical taxonomy map over raw categories", records: profile.fields.category.distinct_exact, trust_rule: "Map reviewed source labels; never overwrite raw category", expected_result: "Stable reporting and category navigation" },
];

const headline = [{
  rows: total,
  valid_gtin_rate: profile.barcode.checksum_valid_rows / total,
  brand_missing_rate: pct(profile.table.missing_brand),
  category_missing_rate: pct(effectiveMissingCategory),
  excluded_valid_gtins: sourceProfile.counts.excluded_missing_or_short_name_rows,
}];

// Materialize the bounded report datasets in an in-memory SQLite snapshot, then select them back.
// This makes every widget source query literal, runnable SQL while preserving original profile paths.
const evidenceDb = new Database(":memory:");
function sqlType(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.every((value) => Number.isInteger(value))) return "INTEGER";
  if (present.every((value) => typeof value === "number")) return "REAL";
  return "TEXT";
}
function materialize(name, rows) {
  const fields = Object.keys(rows[0] || {});
  const quoted = (field) => `"${field.replaceAll('"', '""')}"`;
  evidenceDb.exec(`CREATE TABLE ${quoted(name)} (${fields.map((field) => `${quoted(field)} ${sqlType(rows.map((row) => row[field]))}`).join(", ")})`);
  const insert = evidenceDb.prepare(`INSERT INTO ${quoted(name)} (${fields.map(quoted).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`);
  evidenceDb.transaction((batch) => batch.forEach((row) => insert.run(fields.map((field) => row[field] ?? null))))(rows);
  return evidenceDb.prepare(`SELECT * FROM ${quoted(name)}`).all();
}
const datasets = {
  headline: materialize("headline", headline),
  completeness: materialize("completeness", completeness),
  source_coverage: materialize("source_coverage", sourceCoverage),
  quality_flags: materialize("quality_flags", qualityFlags),
  opportunities: materialize("opportunities", opportunities),
};
evidenceDb.close();

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Retail Corpus: Exact Quality Audit and Improvement Plan",
    description: "Read-only technical audit of the 4.0M-row local retail barcode corpus.",
    generatedAt,
    cards: [
      { id: "rows_card", description: "Serving rows in the retail table.", dataset: "headline", sourceId: "headline_sql", metrics: [{ label: "Retail rows", field: "rows", format: "number" }] },
      { id: "gtin_card", description: "Rows with unique, numeric, checksum-valid GTINs.", dataset: "headline", sourceId: "headline_sql", metrics: [{ label: "Valid unique GTIN rate", field: "valid_gtin_rate", format: "percent" }] },
      { id: "brand_gap_card", description: "Rows without a usable brand value.", dataset: "headline", sourceId: "headline_sql", metrics: [{ label: "Brand missing", field: "brand_missing_rate", format: "percent" }] },
      { id: "category_gap_card", description: "Rows with blank or sentinel category values.", dataset: "headline", sourceId: "headline_sql", metrics: [{ label: "Effective category missing", field: "category_missing_rate", format: "percent" }] },
      { id: "excluded_card", description: "Valid source GTINs excluded because product name was missing or shorter than three characters.", dataset: "headline", sourceId: "headline_sql", metrics: [{ label: "Excluded valid GTINs", field: "excluded_valid_gtins", format: "number" }] },
    ],
    charts: [
      {
        id: "missingness_chart",
        title: "Missing retail identity fields",
        subtitle: "Share of 4,047,273 serving rows; effective category treats nonblank sentinels as missing.",
        type: "bar",
        dataset: "completeness",
        sourceId: "completeness_sql",
        valueFormat: "percent",
        encodings: {
          x: { field: "field", type: "nominal", label: "Field" },
          y: { field: "missing_rate", type: "quantitative", label: "Missing share" },
          tooltip: [
            { field: "missing_rows", type: "quantitative", label: "Missing rows", format: "number" },
            { field: "present_rows", type: "quantitative", label: "Present rows", format: "number" },
          ],
        },
      },
      {
        id: "source_coverage_chart",
        title: "Useful evidence currently dropped from the serving table",
        subtitle: "Coverage across the 4,373,079-row retained Open Food Facts intermediate.",
        type: "bar",
        dataset: "source_coverage",
        sourceId: "source_coverage_sql",
        valueFormat: "percent",
        encodings: {
          x: { field: "field", type: "nominal", label: "Source field" },
          y: { field: "coverage_rate", type: "quantitative", label: "Available share" },
          tooltip: [{ field: "available_rows", type: "quantitative", label: "Available rows", format: "number" }],
        },
      },
    ],
    tables: [
      {
        id: "quality_flags_table",
        title: "Quality findings and safe handling",
        subtitle: "Counts can overlap; classification determines whether automation is allowed.",
        dataset: "quality_flags",
        sourceId: "quality_flags_sql",
        defaultSort: { field: "affected_rows", direction: "desc" },
        columns: [
          { field: "priority", label: "Priority", type: "text" },
          { field: "finding", label: "Finding", type: "text" },
          { field: "affected_rows", label: "Affected rows", format: "number" },
          { field: "classification", label: "Classification", type: "text" },
          { field: "action", label: "Handling", type: "text" },
        ],
      },
      {
        id: "opportunities_table",
        title: "Sequenced improvement backlog",
        subtitle: "P0 protects trust and reproducibility; P1 recovers evidence; P2 standardizes taxonomy.",
        dataset: "opportunities",
        sourceId: "opportunities_sql",
        defaultSort: { field: "priority", direction: "asc" },
        columns: [
          { field: "priority", label: "Priority", type: "text" },
          { field: "action", label: "Action", type: "text" },
          { field: "records", label: "Affected / addressable", format: "number" },
          { field: "trust_rule", label: "Trust rule", type: "text" },
          { field: "expected_result", label: "Expected result", type: "text" },
        ],
      },
    ],
    sources: [
      { id: "headline_sql", label: "Headline evidence snapshot", path: "docs/analysis/retail-corpus-audit-2026-08-03/retail-profile.json" },
      { id: "completeness_sql", label: "Completeness evidence snapshot", path: "docs/analysis/retail-corpus-audit-2026-08-03/retail-profile.json" },
      { id: "source_coverage_sql", label: "Retained-source coverage snapshot", path: "docs/analysis/retail-corpus-audit-2026-08-03/retail-source-profile.json" },
      { id: "quality_flags_sql", label: "Quality flags evidence snapshot", path: "docs/analysis/retail-corpus-audit-2026-08-03/retail-profile.json" },
      { id: "opportunities_sql", label: "Sequenced improvement evidence snapshot", path: "docs/analysis/retail-corpus-audit-2026-08-03/build-report-artifact.cjs" },
    ],
    blocks: [
      { id: "title", type: "markdown", body: "# Retail Corpus: Exact Quality Audit and Improvement Plan" },
      { id: "summary", type: "markdown", body: `## Technical summary\n\n**The barcode spine is excellent; the descriptive layer is not.** All ${total.toLocaleString("en-US")} serving rows have a unique numeric GTIN with a valid check digit, and the database integrity check passes. But ${(pct(profile.table.missing_brand) * 100).toFixed(2)}% lack brand, ${(pct(effectiveMissingCategory) * 100).toFixed(2)}% have no usable category after sentinel normalization, and only ${(pct(profile.table.rows_with_brand_and_category) * 100).toFixed(2)}% have both brand and a nonblank category. The serving schema also drops provenance and most source attributes.\n\n**Do not fill the large gaps from names or neighboring rows.** The retained source produces only ${sourceProfile.counts.included_rows_local_category_rescue.toLocaleString("en-US")} direct localized-category rescues among included rows. Instead, make the database evidence-first: retain raw source assertions, canonicalize into separate reviewed fields, and route unsupported values to partial/review status.\n\n**The highest-return program is P0 trust hardening, then P1 evidence recovery.** Add provenance and uniqueness constraints, clean deterministic text defects, repair the example/test quarantine policy, recover ${sourceProfile.counts.excluded_name_rows_with_brand_and_category.toLocaleString("en-US")} partial identities for review, and adjudicate ${pilotProfile.counts.new_barcode_rows.toLocaleString("en-US")} new non-food pilot rows.` },
      { id: "metrics", type: "metric-strip", cardIds: ["rows_card", "gtin_card", "brand_gap_card", "category_gap_card", "excluded_card"] },
      { id: "completeness_intro", type: "markdown", body: "## Metadata completeness is the binding constraint\n\nBrand and category—not barcode identity—are the major gaps. The effective category measure adds 36,278 nonblank sentinel values such as `Undefined` and `Null` to the raw blank count. Those values should be normalized to missing so dashboards and fill rates remain honest." },
      { id: "missingness", type: "chart", chartId: "missingness_chart" },
      { id: "barcode_core", type: "markdown", body: `## The barcode key is trustworthy today\n\nThe table contains ${total.toLocaleString("en-US")} distinct barcodes across EAN-8, EAN-13, and GTIN-14. Every row is numeric and passes GS1 Mod-10 validation; zero-stripped comparison finds no alias collisions. However, the database index is not declared \`UNIQUE\`. Enforce uniqueness in the schema and build gate so future multi-source imports cannot silently weaken this invariant.` },
      { id: "source_intro", type: "markdown", body: `## The source already contains useful evidence that serving drops\n\nThe four-column table discards high-coverage fields that can improve review and UX without guessing identity. Country exists for ${(pct(sourceProfile.counts.rows_with_countries_en, sourceTotal) * 100).toFixed(1)}% of retained source rows, an image URL for ${(pct(sourceProfile.counts.rows_with_image_url, sourceTotal) * 100).toFixed(1)}%, and quantity for ${(pct(sourceProfile.counts.rows_with_quantity, sourceTotal) * 100).toFixed(1)}%. Preserve these as source assertions; do not overwrite canonical fields directly.` },
      { id: "source_coverage", type: "chart", chartId: "source_coverage_chart" },
      { id: "quality_intro", type: "markdown", body: "## Clean deterministic defects; review ambiguous ones\n\nWhitespace collapse, HTML-entity decoding, sentinel normalization, and exact example-barcode quarantine are deterministic when raw evidence is retained. Numeric-only names, short names, multi-brand strings, and contextual words such as `test` require review. A blanket `test` rule would suppress legitimate diagnostic products and commercial `Test Kitchen` items." },
      { id: "quality_flags", type: "table", tableId: "quality_flags_table" },
      { id: "model", type: "markdown", body: "## Replace the four-field endpoint with an evidence-backed model\n\nKeep the fast serving table, but build it from five governed layers:\n\n1. **Raw observations:** exact source payload, source record ID/URL, source timestamp, fetch timestamp, locale, payload hash, and license.\n2. **Field assertions:** one row per GTIN, field, value, source, and evidence record; no early winner selection.\n3. **Canonical entities:** reviewed product, brand, and category IDs with aliases and versioned normalization.\n4. **Conflict/review queue:** competing names, brands, categories, and contextual poison signals with adjudication history.\n5. **Serving projection:** one deterministic barcode lookup row with explicit status (`known`, `suggested`, `partial`, `quarantined`) and evidence pointers.\n\nThis preserves lookup speed while making every fill explainable and reversible." },
      { id: "roadmap_intro", type: "markdown", body: "## Execute in trust-first order\n\nP0 changes prevent silent corruption and make current quality measurable. P1 recovers exact source evidence without promoting guesses. P2 makes categories usable for reporting and navigation. Each automated fill must be idempotent, provenance-preserving, and covered by a regression gate." },
      { id: "opportunities", type: "table", tableId: "opportunities_table" },
      { id: "methods", type: "markdown", body: "## Scope and methodology\n\nThe audit opened `src/server/knowledge.generated.db` read-only, ran SQLite integrity/schema/aggregate checks, and streamed all 4,047,273 retail rows through local check-digit and text-quality checks. It separately streamed all 4,373,079 rows of the retained Open Food Facts intermediate and reconciled the 319-row Barcode Lookup pilot. No database rows, generated corpus files, production systems, or paid/live APIs were changed or called." },
      { id: "limitations", type: "markdown", body: "## Limitations and robustness\n\nThe serving schema has no row-level provenance, locale, source-updated time, or confidence, so source freshness and field-level conflict rates cannot be reconstructed from the database alone. Repeated product labels across barcodes are not duplicate products and must not be bulk-deleted. The Barcode Lookup pilot adds only a small, quota-limited non-food sample and has 16 overlapping rows whose titles disagree with the corpus; they require evidence review and a licensing gate before import." },
      { id: "questions", type: "markdown", body: "## Further questions\n\n- Which source licenses permit production retention, redistribution, images, and derived canonical fields?\n- Which scan-miss segments matter most by shop type and geography? Use real miss telemetry—not random catalog breadth—to prioritize enrichment.\n- What minimum evidence makes a retail field `known` versus `suggested`? Lock this contract before adding sources.\n- Should partial identities be visible in the operator review queue, or only retained server-side until a product name is verified?" },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt,
    status: "ready",
    datasets,
  },
  sources: [
    {
      id: "headline_sql",
      query: {
        engine: "SQLite in-memory report evidence snapshot",
        language: "sql",
        description: "Selects headline fields materialized from the full serving-table and retained-source profiles.",
        sql: "SELECT rows, valid_gtin_rate, brand_missing_rate, category_missing_rate, excluded_valid_gtins FROM headline;",
        tables_used: ["headline", "src/server/knowledge.generated.db#retail", "data/retail-knowledge/retail_off.jsonl"],
        executed_at: generatedAt,
        filters: ["Full reviewed profile; no sample"],
        metric_definitions: {
          valid_gtin_rate: "Unique numeric 8-, 12-, 13-, or 14-digit barcode passing GS1 Mod-10 divided by all retail rows.",
          category_missing_rate: "Blank category plus recognized nonblank sentinel category values divided by all retail rows.",
        },
      },
    },
    {
      id: "completeness_sql",
      query: {
        engine: "SQLite in-memory report evidence snapshot",
        language: "sql",
        description: "Selects field-level missingness materialized from the full read-only retail profile.",
        sql: "SELECT field, missing_rows, missing_rate, present_rows, total_rows FROM completeness ORDER BY missing_rate ASC;",
        tables_used: ["completeness", "src/server/knowledge.generated.db#retail"],
        executed_at: generatedAt,
        filters: ["All 4,047,273 serving rows"],
      },
    },
    {
      id: "source_coverage_sql",
      query: {
        engine: "SQLite in-memory report evidence snapshot",
        language: "sql",
        description: "Selects source-field coverage materialized from the complete retained Open Food Facts intermediate profile.",
        sql: "SELECT field, available_rows, coverage_rate, source_rows FROM source_coverage ORDER BY coverage_rate DESC;",
        tables_used: ["source_coverage", "data/retail-knowledge/retail_off.jsonl"],
        executed_at: generatedAt,
        filters: ["All 4,373,079 retained source rows"],
      },
    },
    {
      id: "quality_flags_sql",
      query: {
        engine: "SQLite in-memory report evidence snapshot",
        language: "sql",
        description: "Selects reviewed quality flags materialized from the full retail profile.",
        sql: "SELECT priority, finding, affected_rows, classification, action FROM quality_flags ORDER BY affected_rows DESC;",
        tables_used: ["quality_flags", "src/server/knowledge.generated.db#retail"],
        executed_at: generatedAt,
      },
    },
    {
      id: "opportunities_sql",
      query: {
        engine: "SQLite in-memory report evidence snapshot",
        language: "sql",
        description: "Selects the sequenced improvement backlog synthesized from the three reviewed profile outputs and inspected generator/runtime code.",
        sql: "SELECT priority, action, records, trust_rule, expected_result FROM opportunities ORDER BY priority ASC, records DESC;",
        tables_used: ["opportunities", "retail-profile.json", "retail-source-profile.json", "retail-pilot-profile.json"],
        executed_at: generatedAt,
      },
    },
  ],
};

fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: path.join(dir, "artifact.json"), blocks: artifact.manifest.blocks.length, datasets: Object.keys(artifact.snapshot.datasets).length }, null, 2));
