import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { generateLocalDemoManifest, validateManifest } from "./generate-manifest.mjs";

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rehash(manifest, batches) {
  for (const batch of batches) {
    batch.batchSha256 = sha256(batch.rows);
    batch.expectedBarcodesSha256 = sha256(batch.rows.map((row) => row.barcode));
    batch.expectedCanonicalProductUidsSha256 = sha256(batch.rows.map((row) => row.canonicalProductUid));
  }
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  manifest.manifestSha256 = sha256(unsigned);
}

function checkDigit(body) {
  let sum = 0;
  for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) sum += Number(body[index]) * weight;
  return String((10 - (sum % 10)) % 10);
}

function barcode(index, ean = false) {
  const body = `${ean ? "2" : "7"}${String(index).padStart(ean ? 11 : 10, "0")}`;
  return `${body}${checkDigit(body)}`;
}

function fixtureDatabase({ forceSize, standardSize = "225/65R17" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "local-demo-manifest-"));
  const path = join(root, "knowledge.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE tires (
    barcode TEXT, barcode_type TEXT, canonical_product_uid TEXT, brand TEXT, model TEXT, model_display TEXT,
    size TEXT, load_index TEXT, speed_rating TEXT, manufacturer_part_number TEXT, type TEXT, season TEXT,
    source_count INTEGER, confidence TEXT, current_status TEXT, usable_for TEXT, field_completeness_score REAL
  )`);
  const insert = db.prepare(`INSERT INTO tires VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (index, patch = {}) => insert.run(
    patch.barcode ?? barcode(index, patch.barcode_type === "ean"), patch.barcode_type ?? "upc", `TIRE_${index}`,
    "Brand", `Model ${index}`, "", forceSize ?? patch.size ?? standardSize, "102", "H", patch.mpn ?? "", "passenger",
    patch.season ?? "all season", patch.sourceCount ?? 2, patch.confidence ?? "verified_2src", "active_retail",
    "auto_count_candidate", patch.completeness ?? 90,
  );
  db.transaction(() => {
    for (let index = 0; index < 250; index += 1) add(index, { mpn: `REP-${Math.floor(index / 2)}` });
    for (let index = 250; index < 300; index += 1) add(index, { mpn: `UNIQUE-${index}` });
    for (let index = 300; index < 600; index += 1) add(index, { season: "winter" });
    for (let index = 600; index < 900; index += 1) add(index, { size: "LT265/70R17" });
    for (let index = 900; index < 1200; index += 1) add(index, { sourceCount: 5 });
    for (let index = 1200; index < 1500; index += 1) add(index, { confidence: "verified_1src_strong" });
    for (let index = 1500; index < 1800; index += 1) add(index, { completeness: 70 });
    for (let index = 1800; index < 2100; index += 1) add(index, { sourceCount: 3 });
    for (let index = 2100; index < 2400; index += 1) add(index, { barcode_type: "ean" });
    for (let index = 2400; index < 3000; index += 1) add(index);
  })();
  db.close();
  return { root, path };
}

test("generator refuses a trusted pool that does not pass production countability", () => {
  const fixture = fixtureDatabase({ forceSize: "33125020" });
  assert.throws(
    () => generateLocalDemoManifest({
      databasePath: fixture.path,
      reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
      gitSha: "abc123def456",
      generatedAt: "2026-07-29T00:00:00.000Z",
    }),
    /stratum|eligible|requires/i,
  );
});

function sourceRows(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT * FROM tires").all();
  } finally {
    db.close();
  }
}

function corruptedResult(result, index, mutate) {
  const manifest = structuredClone(result.manifest);
  const batches = structuredClone(result.batches);
  mutate(manifest.rows[index]);
  mutate(batches[Math.floor(index / 100)].rows[index % 100]);
  rehash(manifest, batches);
  return { manifest, batches };
}

test("generator writes verified immutable batches before atomically activating the run", () => {
  const fixture = fixtureDatabase();
  const dbHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(result.manifest.total, 3000);
  assert.equal(result.manifest.databaseSha256, dbHash);
  assert.equal(result.manifest.batchCount, 30);
  assert.equal(result.batches.length, 30);
  for (const batch of result.batches) {
    assert.equal(batch.rows.length, 100);
    assert.match(batch.batchSha256, /^[a-f0-9]{64}$/);
    assert.match(batch.expectedBarcodesSha256, /^[a-f0-9]{64}$/);
    assert.match(batch.expectedCanonicalProductUidsSha256, /^[a-f0-9]{64}$/);
  }
  const pointer = JSON.parse(readFileSync(join(fixture.root, "reports", "local-tire-demo", "active-run.json"), "utf8"));
  assert.equal(pointer.databaseSha256, dbHash);
  assert.equal(pointer.manifestSha256, result.manifest.manifestSha256);
  assert.equal(pointer.runDirectory.includes(".."), false);
});

test("generator locks provider display size while anchoring the raw database bytes", () => {
  const compact = fixtureDatabase({ standardSize: "2856020" });
  const canonical = fixtureDatabase({ standardSize: "285/60R20" });
  const compactHash = createHash("sha256").update(readFileSync(compact.path)).digest("hex");
  const canonicalHash = createHash("sha256").update(readFileSync(canonical.path)).digest("hex");
  const compactResult = generateLocalDemoManifest({
    databasePath: compact.path,
    reportsRoot: join(compact.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const canonicalResult = generateLocalDemoManifest({
    databasePath: canonical.path,
    reportsRoot: join(canonical.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const source = sourceRows(compact.path).find((row) => row.size === "2856020");
  const projected = compactResult.manifest.rows.find((row) => row.barcode === source?.barcode);
  assert.ok(source);
  assert.ok(projected);
  assert.equal(projected.size, "285/60R20");
  assert.equal(projected.barcode, source.barcode);
  assert.equal(projected.canonicalProductUid, source.canonical_product_uid);
  assert.equal(compactResult.manifest.databaseSha256, compactHash);
  assert.equal(canonicalResult.manifest.databaseSha256, canonicalHash);
  assert.notEqual(compactHash, canonicalHash);
  assert.notEqual(compactResult.pointer.runDirectory, canonicalResult.pointer.runDirectory);
});

test("validator rejects a rehashed different valid display size", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const { manifest, batches } = corruptedResult(result, 2700, (row) => { row.size = "285/60R20"; });
  assert.throws(
    () => validateManifest(manifest, batches, { sourceRows: sourceRows(fixture.path) }),
    /deterministic|sample|source/i,
  );
});

test("validator rejects recomputed-hash duplicate barcode corruption", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const manifest = structuredClone(result.manifest);
  const batches = structuredClone(result.batches);

  // Simulate a malicious/corrupt artifact rewrite that also recomputes every exposed hash.
  manifest.rows[1].barcode = manifest.rows[0].barcode;
  batches[0].rows[1].barcode = batches[0].rows[0].barcode;
  rehash(manifest, batches);

  assert.throws(() => validateManifest(manifest, batches, { sourceRows: sourceRows(fixture.path) }), /unique|trusted|check digit/i);
});

test("validator rejects a rehashed brand/model rewrite that still satisfies every stratum", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const { manifest, batches } = corruptedResult(result, 2700, (row) => {
    row.brand = "Rehashed Brand Rewrite";
    row.model = "Rehashed Model Rewrite";
  });

  assert.throws(
    () => validateManifest(manifest, batches, { sourceRows: sourceRows(fixture.path) }),
    /deterministic|sample|source/i,
  );
});

test("validator rejects a rehashed eligible same-stratum source-row substitution", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const db = new Database(fixture.path);
  try {
    db.prepare(`INSERT INTO tires VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(barcode(4000), "upc", "TIRE_4000", "Replacement", "Replacement 4000", "", "225/65R17", "102", "H", "", "passenger", "all season", 2, "verified_2src", "active_retail", "auto_count_candidate", 90);
  } finally {
    db.close();
  }
  const replacement = sourceRows(fixture.path).find((row) => row.canonical_product_uid === "TIRE_4000");
  assert.ok(replacement);
  const { manifest, batches } = corruptedResult(result, 2700, (row) => {
    row.barcode = replacement.barcode;
    row.barcodeType = replacement.barcode_type;
    row.canonicalProductUid = replacement.canonical_product_uid;
    row.brand = replacement.brand;
    row.model = replacement.model;
    row.size = replacement.size;
    row.loadIndex = replacement.load_index;
    row.speedRating = replacement.speed_rating;
    row.manufacturerPartNumber = replacement.manufacturer_part_number;
    row.type = replacement.type;
    row.season = replacement.season;
    row.sourceCount = replacement.source_count;
    row.confidence = replacement.confidence;
    row.currentStatus = replacement.current_status;
    row.usableFor = replacement.usable_for;
    row.fieldCompletenessScore = replacement.field_completeness_score;
  });

  assert.throws(
    () => validateManifest(manifest, batches, { sourceRows: sourceRows(fixture.path) }),
    /deterministic|sample|source/i,
  );
});

test("validator rejects rehashed semantic corruption in every ordered stratum", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const pool = sourceRows(fixture.path);
  const cases = [
    [0, "repeated MPN made unique", (row) => { row.manufacturerPartNumber = "CORRUPT-UNIQUE"; }],
    [250, "unique MPN made repeated", (row) => { row.manufacturerPartNumber = "REP-0"; }],
    [300, "winter/all-terrain row loses its marker", (row) => { row.season = "summer"; }],
    [600, "LT/flotation row loses its special size", (row) => { row.size = "225/65R17"; }],
    [900, "source 5+ row falls below threshold", (row) => { row.sourceCount = 2; }],
    [1200, "strong-verification row changes confidence", (row) => { row.confidence = "verified_2src"; }],
    [1500, "low-completeness row rises above threshold", (row) => { row.fieldCompletenessScore = 90; }],
    [1800, "source-3 row changes source count", (row) => { row.sourceCount = 2; }],
    [2100, "EAN row becomes UPC", (row) => { row.barcode = barcode(900001); row.barcodeType = "upc"; }],
    [2400, "UPC row becomes EAN", (row) => { row.barcode = barcode(900002, true); row.barcodeType = "ean"; }],
    [2700, "diversity holdout relabels its stratum", (row) => { row.stratum = "barcode_upc"; }],
    [200, "canonical identity is duplicated", (row) => { row.canonicalProductUid = result.manifest.rows[0].canonicalProductUid; }],
    [200, "padding-equivalent barcode is duplicated", (row) => { row.barcode = `0${result.manifest.rows[0].barcode}`; row.barcodeType = "ean"; }],
    [200, "ordinal is rewritten", (row) => { row.ordinal = 999; }],
    [200, "batch is rewritten", (row) => { row.batch = 30; }],
    [300, "agent is rewritten", (row) => { row.agent = 1; }],
  ];
  for (const [index, name, mutate] of cases) {
    const { manifest, batches } = corruptedResult(result, index, mutate);
    assert.throws(() => validateManifest(manifest, batches, { sourceRows: pool }), /stratum|unique|allocation|trusted/i, name);
  }
});

test("validator rejects rehashed fixed metadata corruption and database drift never activates a run", () => {
  const fixture = fixtureDatabase();
  const result = generateLocalDemoManifest({
    databasePath: fixture.path,
    reportsRoot: join(fixture.root, "reports", "local-tire-demo"),
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
  });
  const pool = sourceRows(fixture.path);
  const metadataCases = [
    (manifest) => { manifest.seed = "other"; },
    (manifest) => { manifest.gitSha = "not-a-git-sha"; },
    (manifest) => { manifest.databaseSha256 = "x".repeat(64); },
    (manifest) => { manifest.generatedAt = "not-a-date"; },
    (_manifest, batches) => { batches[0].seed = "other"; },
    (_manifest, batches) => { batches[0].gitSha = "not-a-git-sha"; },
    (_manifest, batches) => { batches[0].databaseSha256 = "x".repeat(64); },
  ];
  for (const mutate of metadataCases) {
    const manifest = structuredClone(result.manifest);
    const batches = structuredClone(result.batches);
    mutate(manifest, batches);
    rehash(manifest, batches);
    assert.throws(() => validateManifest(manifest, batches, { sourceRows: pool }), /metadata|seed|revision|sha|generated|schema/i);
  }

  const drift = fixtureDatabase();
  const reportsRoot = join(drift.root, "reports", "local-tire-demo");
  assert.throws(() => generateLocalDemoManifest({
    databasePath: drift.path,
    reportsRoot,
    gitSha: "abc123def456",
    generatedAt: "2026-07-29T00:00:00.000Z",
    beforePostRead: () => {
      const db = new Database(drift.path);
      db.prepare("UPDATE tires SET source_count = source_count + 1 WHERE rowid = 1").run();
      db.close();
    },
  }), /changed while generating/i);
  assert.equal(existsSync(join(reportsRoot, "active-run.json")), false);
});
