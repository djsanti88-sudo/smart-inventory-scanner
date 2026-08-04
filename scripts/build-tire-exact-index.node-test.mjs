import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = resolve("scripts/build-tire-exact-index.mjs");
const { buildExactIndex, canonicalGtin } = await import(pathToFileURL(SCRIPT).href);

const sha256 = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tire-exact-index-"));
  const outputDir = join(root, "exact-index");
  const globalPath = join(root, "global.json");
  const repairPath = join(root, "repair.json");
  const reconciliationPath = join(root, "reconciliation.csv");
  const global = { barcodeIndex: {
    "036000291452": { canonical_product_uid: "unit", brand: "Acme", model: "Road", size: "225/45R17", manufacturer_part_number: "UNIT-1", barcode: "036000291452", barcode_type: "upc" },
    "30029885620210": { canonical_product_uid: "case", brand: "Acme", model: "Case", size: "225/45R17", manufacturer_part_number: "CASE-1", barcode: "30029885620210", barcode_type: "gtin14" },
  } };
  const repair = { tires: [{ barcode: "036000291452", canonical_product_uid: "unit", brand: "Acme", model: "Road", size: "225/45R17", manufacturer_part_number: "UNIT-1" }] };
  const reconciliation = [
    "sheet,row,raw_barcode,normalized_barcode_candidates,gtin_valid,gtin_level,source_part_number,part_number_base_key,part_number_affix_core,brand,size,matched_stable_product_id,matched_barcode,match_method,evidence,final_status",
    "Sheet1,2,036000291452,036000291452|0036000291452,true,UPC-A,UNIT-1,UNIT1,,Acme,225/45R17,unit,036000291452,exact_barcode,,accepted",
    "Sheet1,3,SHORT-UNIT-A,SHORT-UNIT-A,false,,UNIT-1,UNIT1,,Acme,225/45R17,unit,036000291452,exact_part_number,,accepted",
    "Sheet1,4,SHORT-UNIT-B,SHORT-UNIT-B,false,,UNIT-1,UNIT1,,Acme,225/45R17,unit,036000291452,affix_core_brand_size,,alias",
    "Sheet1,5,,,false,,UNIT-1,UNIT1,,Acme,225/45R17,unit,036000291452,affix_core_brand_size,,alias",
    "Sheet2,8,30029885620210,30029885620210,true,GTIN-14,CASE-1,CASE1,,,,case,30029885620210,packaging_code,,packaging_code",
  ].join("\n") + "\n";
  writeFileSync(globalPath, JSON.stringify(global));
  writeFileSync(repairPath, JSON.stringify(repair));
  writeFileSync(reconciliationPath, reconciliation);
  return { root, outputDir, globalPath, repairPath, reconciliationPath, hashes: { global: sha256(readFileSync(globalPath)), repair: sha256(readFileSync(repairPath)), reconciliation: sha256(readFileSync(reconciliationPath)) } };
}

function build(fx, overrides = {}) {
  return buildExactIndex({
    globalPath: fx.globalPath, repairPath: fx.repairPath, reconciliationPath: fx.reconciliationPath,
    outputDir: fx.outputDir, expectedHashes: fx.hashes, expectedCounts: null, enforceLedgerCompleteness: false, ...overrides,
  });
}

function check(fx) {
  return build(fx, { dryRun: true, check: true });
}

function rewriteOverlap(fx, { globalBrand, bossBrand, globalSize, bossSize }) {
  const global = JSON.parse(readFileSync(fx.globalPath, "utf8"));
  global.barcodeIndex["036000291452"] = {
    ...global.barcodeIndex["036000291452"], brand: globalBrand, size: globalSize,
  };
  const repair = JSON.parse(readFileSync(fx.repairPath, "utf8"));
  repair.tires[0] = { ...repair.tires[0], brand: bossBrand, size: bossSize };
  writeFileSync(fx.globalPath, JSON.stringify(global));
  writeFileSync(fx.repairPath, JSON.stringify(repair));
  fx.hashes.global = sha256(readFileSync(fx.globalPath));
  fx.hashes.repair = sha256(readFileSync(fx.repairPath));
}

test("canonical GTIN preserves nonzero package indicators while collapsing zero padding", () => {
  assert.equal(canonicalGtin("036000291452"), canonicalGtin("0036000291452"));
  assert.notEqual(canonicalGtin("30029885620210"), canonicalGtin("036000291452"));
});

test("admits approved non-GTIN exact identifiers under their repair-issued product identity and ledgers blank aliases", () => {
  const fx = fixture();
  try {
    const result = build(fx);
    const rows = Object.values(result.manifest.shardCounts).flatMap((_, index) =>
      Object.entries(JSON.parse(readFileSync(join(fx.outputDir, `${index.toString(16).padStart(2, "0")}.json`), "utf8"))),
    );
    const shortRows = rows.filter(([key]) => key.startsWith("nongtin:"));

    assert.equal(shortRows.length, 2, "approved non-GTIN identifiers must not be silently dropped");
    assert.deepEqual(new Set(shortRows.map(([, row]) => row.canonical_product_uid)), new Set(["unit"]),
      "all approved spellings for one repair product share its pre-existing stable identity");
    assert.equal(result.manifest.nonGtinApprovedIdentifiers, 2);
    assert.equal(result.manifest.nonGtinApprovedRows, 2);
    assert.equal(result.manifest.nonGtinBlankAliasConflicts, 1);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("rejects a non-GTIN spelling approved for different repair-issued products", () => {
  const fx = fixture();
  try {
    const repair = JSON.parse(readFileSync(fx.repairPath, "utf8"));
    repair.tires.push({ barcode: "009999999999", canonical_product_uid: "other", brand: "Acme", model: "Other", size: "225/45R17", manufacturer_part_number: "UNIT-2" });
    writeFileSync(fx.repairPath, JSON.stringify(repair));
    const conflict = "Sheet1,6,SHORT-UNIT-A,SHORT-UNIT-A,false,,UNIT-2,UNIT2,,Acme,225/45R17,other,009999999999,exact_part_number,,accepted\n";
    writeFileSync(fx.reconciliationPath, readFileSync(fx.reconciliationPath, "utf8") + conflict);
    fx.hashes.repair = sha256(readFileSync(fx.repairPath));
    fx.hashes.reconciliation = sha256(readFileSync(fx.reconciliationPath));

    assert.throws(() => build(fx), /cross-product approved non-GTIN identifier/i);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("records a deterministic source-derived shortest non-GTIN sample without publishing identifiers", () => {
  const fx = fixture();
  try {
    const result = build(fx);
    assert.equal(result.manifest.sourceDerivedNonGtinSampleCount, 2);
    assert.match(result.manifest.sourceDerivedNonGtinSampleSha256, /^[A-F0-9]{64}$/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("rejects a GTIN reconciliation row whose stable product identity disagrees with repair", () => {
  const fx = fixture();
  try {
    const changed = readFileSync(fx.reconciliationPath, "utf8").replace(",unit,036000291452,exact_barcode", ",other,036000291452,exact_barcode");
    writeFileSync(fx.reconciliationPath, changed);
    fx.hashes.reconciliation = sha256(changed);
    assert.throws(() => build(fx), /disagrees with repair-issued canonical product identity/i);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("pinned source bytes, status, checksum, and package rules fail closed while approved non-GTIN identifiers remain exact", () => {
  const fx = fixture();
  mkdirSync(fx.outputDir); writeFileSync(join(fx.outputDir, "sentinel"), "prior");
  try {
    assert.throws(() => build(fx, { expectedHashes: { ...fx.hashes, global: "0".repeat(64) } }), /SHA-256 mismatch/);
    assert.equal(existsSync(join(fx.outputDir, "sentinel")), true);
    const bad = readFileSync(fx.reconciliationPath, "utf8").replace("true,UPC-A", "false,UPC-A");
    writeFileSync(fx.reconciliationPath, bad);
    fx.hashes.reconciliation = sha256(bad);
    const result = build(fx);
    assert.equal(result.manifest.admittedBossCodes, 3, "a non-GTIN row stays an opaque approved exact identifier rather than being GTIN-normalized");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("builds deterministic minimal shards, blocks case packs, and atomically preserves prior index on failure", () => {
  const fx = fixture();
  try {
    const first = build(fx);
    assert.equal(existsSync(join(fx.outputDir, "verified-repair.json")), false, "the staged verified input is not promoted as a serving artifact");
    assert.equal(first.manifest.excludedCasePacks, 1);
    assert.equal(first.manifest.totalKeys, 3);
    assert.equal(first.manifest.shardAlgorithm, "sha256-first-byte-mod-64-v1");
    assert.deepEqual(Object.keys(first.manifest.shardCounts).sort(), Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, "0")));
    const bytes = readFileSync(join(fx.outputDir, "manifest.json"));
    const second = build(fx);
    assert.deepEqual(readFileSync(join(fx.outputDir, "manifest.json")), bytes);
    assert.equal(second.manifest.contentDigest, first.manifest.contentDigest);
    const shards = Object.values(first.manifest.shardCounts);
    assert.ok(shards.every((count) => count <= 1));
    assert.ok(first.totalBytes <= 40 * 1024 * 1024);
    assert.ok(Object.values(first.shardBytes).every((size) => size <= 1024 * 1024));
    const overlapRow = Object.keys(first.manifest.shardCounts)
      .flatMap((shard) => Object.values(JSON.parse(readFileSync(join(fx.outputDir, `${shard}.json`), "utf8"))))
      .find((row) => row.sourceScope === "global_corpus");
    assert.equal(overlapRow.sourceScope, "global_corpus", "public overlap remains globally available");
    assert.equal(overlapRow.bossTrusted, true, "public overlap retains Boss trust for authorized elevation");
    const collision = JSON.parse(readFileSync(fx.globalPath, "utf8"));
    collision.barcodeIndex["0036000291452"] = { ...collision.barcodeIndex["036000291452"], brand: "Other" };
    writeFileSync(fx.globalPath, JSON.stringify(collision)); fx.hashes.global = sha256(readFileSync(fx.globalPath));
    assert.throws(() => build(fx), /collision|ambigu/i);
    assert.deepEqual(readFileSync(join(fx.outputDir, "manifest.json")), bytes, "failed validation preserves the complete prior index");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("serializes digest-covered blocked package canonical keys without a loader dependency", () => {
  const fx = fixture();
  try {
    const result = build(fx);
    const manifest = JSON.parse(readFileSync(join(fx.outputDir, "manifest.json"), "utf8"));
    const packageKey = canonicalGtin("30029885620210");

    assert.deepEqual(manifest.blockedPackageCanonicalKeys, [packageKey]);
    assert.deepEqual(manifest.blockedPackageCanonicalKeys, [...manifest.blockedPackageCanonicalKeys].sort());
    assert.equal(canonicalGtin("30029885620210"), packageKey);
    assert.equal(canonicalGtin(" 30029885620210 "), packageKey);
    assert.equal(Object.values(manifest.shardCounts).reduce((total, count) => total + count, 0), manifest.totalKeys);
    for (const shard of Object.keys(manifest.shardCounts)) {
      assert.equal(JSON.parse(readFileSync(join(fx.outputDir, `${shard}.json`), "utf8"))[packageKey], undefined);
    }
    assert.equal(result.manifest.contentDigest, manifest.contentDigest, "Task 1 emits all loader-needed package truth in the manifest");

    const stale = { ...manifest, blockedPackageCanonicalKeys: [] };
    writeFileSync(join(fx.outputDir, "manifest.json"), JSON.stringify(stale, null, 2) + "\n");
    assert.throws(() => check(fx), /artifact mismatch|content digest|manifest/i, "a stale package block list is rejected");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("check mode validates the on-disk manifest and all and only projected artifacts", () => {
  const fx = fixture();
  try {
    build(fx);
    assert.doesNotThrow(() => check(fx));

    const shard = Object.entries(JSON.parse(readFileSync(join(fx.outputDir, "manifest.json"), "utf8")).shardCounts)
      .find(([, count]) => count === 1)[0];
    writeFileSync(join(fx.outputDir, `${shard}.json`), "{\"tampered\":true}\n");
    assert.throws(() => check(fx), /artifact mismatch|shard hash|content digest/i, "tampered shard is rejected");

    build(fx);
    const manifestPath = join(fx.outputDir, "manifest.json");
    const stale = JSON.parse(readFileSync(manifestPath, "utf8"));
    stale.totalKeys += 1;
    writeFileSync(manifestPath, JSON.stringify(stale, null, 2) + "\n");
    assert.throws(() => check(fx), /artifact mismatch|content digest|manifest/i, "stale manifest is rejected");

    build(fx);
    const bytes = readFileSync(join(fx.outputDir, `${shard}.json`));
    writeFileSync(join(fx.outputDir, `${shard}.json`), bytes.subarray(0, Math.max(1, bytes.length - 1)));
    assert.throws(() => check(fx), /artifact mismatch|shard hash|content digest/i, "truncated shard is rejected");

    build(fx);
    rmSync(join(fx.outputDir, `${shard}.json`));
    assert.throws(() => check(fx), /artifact set mismatch|missing|required/i, "missing shard is rejected");

    build(fx);
    writeFileSync(join(fx.outputDir, "unexpected.json"), "{}\n");
    assert.throws(() => check(fx), /artifact set mismatch|unexpected/i, "extra artifact is rejected");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("overlap normalizers accept only the reviewed Toyo and tire-size spellings", () => {
  const fx = fixture();
  try {
    rewriteOverlap(fx, { globalBrand: "Toyo Tire", bossBrand: "Toyo", globalSize: "42/13.5R17", bossSize: "42X13.50R17LT" });
    assert.doesNotThrow(() => build(fx), "the two reviewed equivalent spellings are accepted");

    rewriteOverlap(fx, { globalBrand: "Toyo Tires", bossBrand: "Toyo", globalSize: "42/13.5R17", bossSize: "42X13.50R17LT" });
    assert.throws(() => build(fx), /incompatibility|fields=brand/i, "nearby Toyo value is not fuzzy-normalized");

    rewriteOverlap(fx, { globalBrand: "Toyo Tire", bossBrand: "Toyo", globalSize: "42x13.50r17", bossSize: "42X13.50R17LT" });
    assert.throws(() => build(fx), /incompatibility|fields=size/i, "nearby size value is not broadened into the reviewed equivalence");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("production build contract pins all three supplied inputs and fixed cardinalities", () => {
  const reviewedLedger = JSON.parse(readFileSync(resolve("scripts/tire-exact-index-collision-dispositions.json"), "utf8"));
  assert.equal(reviewedLedger.entries.length, 42, "the exhaustive reviewed MPN collision census is pinned exactly");
  const result = buildExactIndex({ root: resolve("."), outputDir: join(mkdtempSync(join(tmpdir(), "tire-exact-production-")), "exact-index"), dryRun: true });
  assert.equal(result.manifest.admittedBossCodes, 5626);
  assert.equal(result.manifest.acceptedSpellings, 13656);
  assert.equal(result.manifest.nonGtinApprovedRows, 314);
  assert.equal(result.manifest.nonGtinApprovedIdentifiers, 310);
  assert.equal(result.manifest.nonGtinBlankAliasConflicts, 193);
  assert.equal(result.manifest.excludedCasePacks, 1);
  assert.equal(result.manifest.collisionDispositionCount, 42);
  assert.match(result.manifest.collisionDispositionLedgerSha256, /^[A-F0-9]{64}$/);
});

test("uses the verified staged repair bytes when the source changes after verification", () => {
  const fx = fixture();
  try {
    let mutated = false;
    const result = build(fx, {
      afterInputVerification() {
        mutated = true;
        writeFileSync(fx.repairPath, JSON.stringify({ tires: [{
          barcode: "036000291452", canonical_product_uid: "evil", brand: "Wrong", model: "Wrong",
          size: "1/1R1", manufacturer_part_number: "WRONG",
        }] }));
      },
    });
    assert.equal(mutated, true, "the deterministic test seam must run after byte verification");
    const shard = Object.entries(result.manifest.shardCounts).find(([, count]) => count === 1)[0];
    const row = Object.values(JSON.parse(readFileSync(join(fx.outputDir, `${shard}.json`), "utf8")))[0];
    assert.equal(row.brand, "Acme", "projection must read the verified staged copy, not replacement source bytes");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("restores the previous complete index when promotion fails after its move", () => {
  const fx = fixture();
  try {
    build(fx);
    const before = readFileSync(join(fx.outputDir, "manifest.json"));
    let moves = 0;
    assert.throws(() => build(fx, {
      fileSystem: {
        renameSync(from, to) {
          moves++;
          if (moves === 2) throw new Error("injected promotion failure");
          return renameSync(from, to);
        },
      },
    }), /injected promotion failure/);
    assert.deepEqual(readFileSync(join(fx.outputDir, "manifest.json")), before);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("validates and globally deduplicates accepted spellings instead of counting CSV occurrences", () => {
  const fx = fixture();
  try {
    const accepted = readFileSync(fx.reconciliationPath, "utf8").replace(
      "036000291452|0036000291452",
      "036000291452|036000291452|0036000291452|not-a-gtin"
    );
    writeFileSync(fx.reconciliationPath, accepted);
    fx.hashes.reconciliation = sha256(accepted);
    assert.throws(() => build(fx), /accepted spelling.*GTIN|malformed.*accepted/i);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
