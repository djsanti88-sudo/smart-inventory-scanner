#!/usr/bin/env node
// Read-only, fail-closed projection of the approved global corpus and authenticated Boss reconciliation.
import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HASHES = {
  global: "CF61D12208E6E1AA0DCB5BBD2AAA98E775ED7A60110601628BB3EDE9DBFE13D6",
  repair: "ECF1F14400489897A3882964E928DFC28F8056CAC262176E28808B7BA0E42E82",
  reconciliation: "DAB216234D5346BAEEFBAE80E5C704F2F3C5D568CC3CA01FD5C4990B44183FFD",
};
const SHARDS = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(2, "0"));
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_SHARD = 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();
const OPAQUE_ID_PREFIX = "trusted-exact:v1:";
const COLLISION_HMAC_DOMAINS = Object.freeze({
  canonicalKey: "collision-canonical-key:v1",
  globalSourcePointer: "collision-global-source-pointer:v1",
  bossSourcePointer: "collision-boss-source-pointer:v1",
  globalValue: "collision-global-value:v1",
  bossValue: "collision-boss-value:v1",
  conflictSourcePointer: "conflict-source-pointer:v1",
  conflictIdentifier: "conflict-identifier:v1",
});
function requireBossHmacKey(value = process.env.BOSS_EXACT_INDEX_HMAC_KEY) {
  const key = String(value ?? "");
  if (Buffer.byteLength(key, "utf8") < 32) throw new Error("BOSS_EXACT_INDEX_HMAC_KEY must be a server-only secret of at least 32 bytes");
  return key;
}
const keyedDigest = (key, domain, value) => createHmac("sha256", key).update(`${domain}\0${value}`).digest("hex").toUpperCase();
const bossLookupKey = (key, sourceKey) => `boss:v1:${keyedDigest(key, "lookup:v1", sourceKey)}`;
const bossCanonicalProductId = (sourceUid) => `${OPAQUE_ID_PREFIX}${sha256(String(sourceUid)).slice(0, 32)}`;
const norm = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const normMpn = (value) => String(value ?? "").trim().replace(/[ -]/g, "").toUpperCase();
const normBrand = (value) => norm(value) === "toyo tire" ? "toyo" : norm(value);
const normSize = (value) => {
  const compact = norm(value).replace(/\s+/g, "");
  return compact === "42/13.5r17" || compact === "42x13.50r17lt" ? "42x13.50r17lt" : compact;
};
const gtinShape = (value) => /^\d{8}$|^\d{12,14}$/.test(String(value ?? "").trim());
// Non-GTIN identifiers are deliberately opaque. The approved reconciliation is the only
// authority for them: retain the exact trimmed scanner spelling, without part-number
// normalization, case folding, or a generated product identity.
const nonGtinKey = (value) => {
  const exact = String(value ?? "").trim();
  return exact ? `nongtin:${exact}` : null;
};

export function canonicalGtin(value) {
  const code = String(value ?? "").trim();
  return gtinShape(code) ? code.replace(/^0+/, "").padStart(14, "0") : null;
}

function validCheckDigit(value) {
  const code = String(value ?? "").trim();
  if (!gtinShape(code)) return false;
  const digits = [...code].map(Number); const check = digits.pop(); let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = 4 - weight) sum += digits[i] * weight;
  return (10 - (sum % 10)) % 10 === check;
}
function sourceHash(path, expected, label) {
  const bytes = readFileSync(path); const actual = sha256(bytes);
  if (!/^[A-F0-9]{64}$/.test(expected) || actual !== expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  return { bytes, actual };
}
function csvRows(text) {
  const rows = []; let row = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quote && text[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; }
    else if (char === "," && !quote) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quote) { if (char === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quote) throw new Error("CSV contains an unclosed quote");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((fields) => Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""])));
}
function minimal(row, scope, bossTrusted = false, bossCanonicalId = "") {
  return {
    canonical_product_uid: String(row.canonical_product_uid ?? ""), brand: String(row.brand ?? ""), model: String(row.model ?? ""),
    size: String(row.size ?? ""), raw_size_text: String(row.raw_size_text ?? row.size ?? ""), load_index: String(row.load_index ?? ""),
    speed_rating: String(row.speed_rating ?? ""), load_range: String(row.load_range ?? ""), type: String(row.type ?? ""), season: String(row.season ?? ""),
    manufacturer_part_number: String(row.manufacturer_part_number ?? ""), barcode: String(row.barcode ?? ""), barcode_type: String(row.barcode_type ?? ""),
    confidence: String(row.confidence ?? "verified_1src_strong"), current_status: String(row.current_status ?? "verified"), sourceScope: scope, bossTrusted,
    ...(bossTrusted ? { boss_canonical_product_id: bossCanonicalId } : {}),
  };
}

function privateBossRow(row, bossCanonicalId) {
  return minimal({ ...row, canonical_product_uid: "", barcode: "" }, "authenticated_boss_corpus", true, bossCanonicalId);
}
function differingFields(a, b) {
  for (const field of ["brand", "model", "size", "manufacturer_part_number"]) {
    const normalize = field === "manufacturer_part_number" ? normMpn : field === "brand" ? normBrand : field === "size" ? normSize : norm;
    if (normalize(a[field]) && normalize(b[field]) && normalize(a[field]) !== normalize(b[field])) return [field];
  }
  return [];
}
function shardFor(key) { return (createHash("sha256").update(key).digest()[0] % 64).toString(16).padStart(2, "0"); }
function loadRepair(path) {
  if (path.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8")).tires ?? [];
  const db = new Database(path, { readonly: true });
  try { return db.prepare("SELECT * FROM tires").all(); } finally { db.close(); }
}
function collisionHmac(key, domain, value) {
  return keyedDigest(key, domain, String(value ?? ""));
}
function loadDispositionLedger(path, bossHmacKey) {
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.schemaVersion !== "2.0.0" || !/^[A-F0-9]{64}$/.test(parsed.keyFingerprintHmacSha256) || !Array.isArray(parsed.entries) || parsed.entries.length !== 42) {
    throw new Error("collision disposition ledger must contain exactly the exhaustive 42 reviewed entries");
  }
  if (parsed.keyFingerprintHmacSha256 !== collisionHmac(bossHmacKey, "key-fingerprint:v1", "scanbin-boss-exact-index")) {
    throw new Error("collision disposition ledger HMAC key mismatch");
  }
  const keys = new Set();
  for (const entry of parsed.entries) {
    const expectedKeys = ["action", "bossSourcePointerHmacSha256", "bossValueHmacSha256", "canonicalKeyHmacSha256", "globalSourcePointerHmacSha256", "globalValueHmacSha256"];
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys) ||
      !/^[A-F0-9]{64}$/.test(entry.canonicalKeyHmacSha256) || keys.has(entry.canonicalKeyHmacSha256) || entry.action !== "omit_conflicting_field" ||
      !/^[A-F0-9]{64}$/.test(entry.globalSourcePointerHmacSha256) || !/^[A-F0-9]{64}$/.test(entry.bossSourcePointerHmacSha256) ||
      !/^[A-F0-9]{64}$/.test(entry.globalValueHmacSha256) || !/^[A-F0-9]{64}$/.test(entry.bossValueHmacSha256)) {
      throw new Error("collision disposition ledger entry is malformed");
    }
    keys.add(entry.canonicalKeyHmacSha256);
  }
  return { entries: new Map(parsed.entries.map((entry) => [entry.canonicalKeyHmacSha256, entry])), digest: sha256(bytes) };
}
function resolveReviewedMpnConflict({ key, globalPointer, bossPointer, globalRow, bossRow, fields, ledger, bossHmacKey, reviewedCollisionKeys }) {
  if (fields.length !== 1 || fields[0] !== "manufacturer_part_number") {
    throw new Error(`Boss/global incompatibility in fields=${fields.join("|")}`);
  }
  const canonicalKeyHmacSha256 = collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.canonicalKey, key);
  const entry = ledger.get(canonicalKeyHmacSha256);
  if (!entry || entry.globalSourcePointerHmacSha256 !== collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.globalSourcePointer, globalPointer) ||
    entry.bossSourcePointerHmacSha256 !== collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.bossSourcePointer, bossPointer) ||
    entry.globalValueHmacSha256 !== collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.globalValue, globalRow.manufacturer_part_number) ||
    entry.bossValueHmacSha256 !== collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.bossValue, bossRow.manufacturer_part_number)) {
    throw new Error("unreviewed or changed MPN collision disposition");
  }
  reviewedCollisionKeys.add(canonicalKeyHmacSha256);
  return { ...globalRow, manufacturer_part_number: "" };
}
function requireOutputLimits(dir, manifest) {
  let total = 0;
  for (const shard of SHARDS) { const size = statSync(join(dir, `${shard}.json`)).size; if (size > MAX_SHARD) throw new Error(`shard ${shard} exceeds 1 MiB`); total += size; }
  total += statSync(join(dir, "manifest.json")).size + statSync(join(dir, "conflict-ledger.json")).size;
  if (total > MAX_TOTAL) throw new Error("exact index exceeds 40 MiB");
  if (Object.values(manifest.shardCounts).some((count) => count > Math.ceil(manifest.totalKeys * 0.2) + 1)) throw new Error("unbalanced shard distribution");
  return total;
}
function artifactNames() { return ["conflict-ledger.json", "manifest.json", ...SHARDS.map((shard) => `${shard}.json`)]; }
function verifyManifestInternals(dir, manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.shardHashes || !manifest.shardCounts || !manifest.shardBytes) {
    throw new Error("artifact manifest is malformed");
  }
  const expectedDigest = sha256(JSON.stringify(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "contentDigest"))));
  if (manifest.contentDigest !== expectedDigest) throw new Error("artifact manifest content digest mismatch");
  const conflictLedger = readFileSync(join(dir, "conflict-ledger.json"));
  if (manifest.conflictLedgerSha256 !== sha256(conflictLedger)) throw new Error("artifact conflict ledger hash mismatch");
  for (const shard of SHARDS) {
    const name = `${shard}.json`; const bytes = readFileSync(join(dir, name));
    if (manifest.shardHashes[shard] !== sha256(bytes)) throw new Error(`artifact shard hash mismatch: ${name}`);
    if (manifest.shardBytes[shard] !== bytes.length) throw new Error(`artifact shard byte count mismatch: ${name}`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (manifest.shardCounts[shard] !== Object.keys(parsed).length) throw new Error(`artifact shard count mismatch: ${name}`);
  }
  requireOutputLimits(dir, manifest);
}
function validateOnDiskArtifact(outputDir, freshDir) {
  if (!existsSync(outputDir)) throw new Error("exact-index artifact is missing");
  const expectedNames = artifactNames().sort();
  const actualNames = readdirSync(outputDir).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("exact-index artifact set mismatch: expected manifest plus all and only 64 shards");
  for (const name of expectedNames) {
    if (!lstatSync(join(outputDir, name)).isFile()) throw new Error(`exact-index artifact is not a regular file: ${name}`);
  }
  let actualManifest;
  try { actualManifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")); }
  catch (error) { throw new Error(`artifact manifest is malformed: ${error.message}`); }
  verifyManifestInternals(outputDir, actualManifest);
  for (const name of expectedNames) {
    const actual = readFileSync(join(outputDir, name)); const fresh = readFileSync(join(freshDir, name));
    if (!actual.equals(fresh)) throw new Error(`exact-index artifact mismatch against fresh pinned projection: ${name}`);
  }
}

export function buildExactIndex(options = {}) {
  const root = resolve(options.root ?? ".");
  const bossHmacKey = requireBossHmacKey(options.bossHmacKey);
  const globalPath = options.globalPath ?? process.env.BOSS_GLOBAL_CORPUS_PATH ?? join(root, "src/server/tire-knowledge/tireKnowledge.generated.json");
  const repairPath = options.repairPath ?? process.env.BOSS_REPAIR_DB_PATH ?? join(root, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db");
  const reconciliationPath = options.reconciliationPath ?? process.env.BOSS_RECONCILIATION_PATH ?? join(root, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/BOSS_ROW_RECONCILIATION.csv");
  const outputDir = options.outputDir ?? join(root, "src/server/tire-knowledge/exact-index");
  const dispositionPath = options.dispositionPath ?? join(root, "scripts/tire-exact-index-collision-dispositions.json");
  const expected = options.expectedHashes ?? HASHES;
  const dispositionLedger = loadDispositionLedger(dispositionPath, bossHmacKey);
  const ledger = dispositionLedger.entries;
  const globalInput = sourceHash(globalPath, expected.global, "global corpus");
  const repairInput = sourceHash(repairPath, expected.repair, "repair DB");
  const reconciliationInput = sourceHash(reconciliationPath, expected.reconciliation, "reconciliation CSV");
  const staged = mkdtempSync(join(dirname(outputDir), ".exact-index-staging-"));
  const global = JSON.parse(globalInput.bytes.toString("utf8"));
  const verifiedRepairPath = join(staged, repairPath.endsWith(".json") ? "verified-repair.json" : "verified-repair.db");
  writeFileSync(verifiedRepairPath, repairInput.bytes);
  options.afterInputVerification?.();
  const repair = new Map(loadRepair(verifiedRepairPath).map((row) => [String(row.barcode), row]));
  rmSync(verifiedRepairPath, { force: true });
  const reconciliationRows = csvRows(reconciliationInput.bytes.toString("utf8"));
  const all = new Map(); const bossCanonicals = new Set(); const bossProductIdentities = new Set(); const bossIdentityByLookupKey = new Map();
  const acceptedSpellingKeys = new Map(); const blockedPackages = new Set(); const reviewedCollisionKeys = new Set();
  let nonGtinApprovedRows = 0;
  const nonGtinConflictLedger = [];
  for (const rec of reconciliationRows) {
    if (rec.final_status !== "packaging_code") continue;
    const packageKey = canonicalGtin(rec.raw_barcode);
    if (!packageKey || !validCheckDigit(rec.raw_barcode)) throw new Error("malformed packaging source");
    blockedPackages.add(packageKey);
  }
  for (const value of Object.values(global.barcodeIndex ?? {})) {
    const row = minimal(value, "global_corpus"); const key = canonicalGtin(row.barcode);
    if (!key || !validCheckDigit(row.barcode)) continue;
    if (blockedPackages.has(key)) continue;
    const existing = all.get(key);
    if (existing && differingFields(existing.row, row).length) throw new Error("canonical collision: global corpus rows disagree");
    all.set(key, { row, pointers: [`tireKnowledge.generated.json:barcodeIndex.${row.barcode}`] });
  }
  const addBossRow = ({ sourceLookupKey, dbRow, bossUid, pointer }) => {
    const priorIdentity = bossIdentityByLookupKey.get(sourceLookupKey);
    if (priorIdentity && priorIdentity !== bossUid) throw new Error("conflicting Boss identities for one lookup key");
    bossIdentityByLookupKey.set(sourceLookupKey, bossUid);
    bossProductIdentities.add(bossUid);
    const privateKey = bossLookupKey(bossHmacKey, sourceLookupKey);
    const bossCanonicalId = bossCanonicalProductId(bossUid);
    const row = privateBossRow(dbRow, bossCanonicalId);
    const existing = all.get(privateKey);
    if (existing) {
      if (existing.row.boss_canonical_product_id !== bossCanonicalId) throw new Error("conflicting Boss identities for one lookup key");
      if (differingFields(existing.row, row).length) throw new Error("Boss source rows disagree for one lookup key");
      existing.pointers.push(pointer);
      return;
    }
    all.set(privateKey, { row, pointers: [pointer] });
  };
  for (const rec of reconciliationRows) {
    if (rec.final_status === "packaging_code") continue;
    if (rec.final_status !== "accepted" && rec.final_status !== "alias") continue;
    const pointer = `${rec.sheet}:${rec.row}`;
    if (rec.gtin_valid !== "true") {
      const key = nonGtinKey(rec.raw_barcode);
      if (!key) {
        nonGtinConflictLedger.push({ sourcePointerHmacSha256: collisionHmac(bossHmacKey, COLLISION_HMAC_DOMAINS.conflictSourcePointer, pointer), reason: "blank_non_gtin_identifier", finalStatus: rec.final_status });
        continue;
      }
      const dbRow = repair.get(rec.matched_barcode);
      if (!dbRow) throw new Error("Boss source has no repair match");
      if (String(dbRow.canonical_product_uid ?? "") !== String(rec.matched_stable_product_id ?? "")) {
        throw new Error("Boss source disagrees with repair-issued canonical product identity");
      }
      const bossUid = String(rec.matched_stable_product_id ?? "");
      nonGtinApprovedRows++;
      const prior = acceptedSpellingKeys.get(key);
      if (prior && prior !== bossUid) throw new Error("cross-product approved non-GTIN identifier");
      addBossRow({ sourceLookupKey: key, dbRow: { ...dbRow, barcode_type: "approved_non_gtin" }, bossUid, pointer });
      acceptedSpellingKeys.set(key, bossUid);
      bossCanonicals.add(key);
      continue;
    }
    if (!validCheckDigit(rec.raw_barcode)) throw new Error("malformed accepted Boss input");
    const key = canonicalGtin(rec.raw_barcode); if (!key) throw new Error("non-GTIN Boss input");
    if (blockedPackages.has(key)) continue;
    const dbRow = repair.get(rec.matched_barcode);
    if (!dbRow) throw new Error("Boss source has no repair match");
    if (String(dbRow.canonical_product_uid ?? "") !== String(rec.matched_stable_product_id ?? "")) {
      throw new Error("Boss source disagrees with repair-issued canonical product identity");
    }
    const bossUid = String(rec.matched_stable_product_id ?? "");
    const row = minimal({ ...dbRow, barcode: rec.matched_barcode || rec.raw_barcode }, "authenticated_boss_corpus", true, bossCanonicalProductId(bossUid));
    const existing = all.get(key);
    if (existing) {
      const fields = differingFields(existing.row, row);
      if (fields.length) existing.row = resolveReviewedMpnConflict({ key, globalPointer: existing.pointers[0], bossPointer: pointer, globalRow: existing.row, bossRow: row, fields, ledger, bossHmacKey, reviewedCollisionKeys });
    }
    addBossRow({ sourceLookupKey: key, dbRow, bossUid, pointer });
    for (const spelling of String(rec.normalized_barcode_candidates || rec.raw_barcode).split("|").filter(Boolean)) {
      if (!validCheckDigit(spelling) || canonicalGtin(spelling) !== key) throw new Error("accepted spelling is not a valid canonical-equivalent public GTIN");
      const prior = acceptedSpellingKeys.get(spelling);
      if (prior && prior !== bossUid) throw new Error("accepted spelling collides across products");
      acceptedSpellingKeys.set(spelling, bossUid);
    }
    bossCanonicals.add(key);
  }
  if (options.enforceLedgerCompleteness !== false && (ledger.size !== 42 || reviewedCollisionKeys.size !== 42)) {
    throw new Error("collision disposition ledger has an extra or unmatched entry");
  }
  const excludedCasePacks = blockedPackages.size;
  if (excludedCasePacks !== 1) throw new Error(`expected exactly one excluded case pack, got ${excludedCasePacks}`);
  const expectedCounts = options.expectedCounts === undefined
    ? { admittedBossCodes: 5626, acceptedSpellings: 13656, bossCanonicalProductIds: 5296, nonGtinApprovedRows: 314, nonGtinApprovedIdentifiers: 310, nonGtinBlankAliasConflicts: 193 }
    : options.expectedCounts;
  const acceptedSpellings = acceptedSpellingKeys.size;
  const nonGtinApprovedIdentifiers = [...acceptedSpellingKeys.keys()].filter((key) => key.startsWith("nongtin:")).length;
  const nonGtinBlankAliasConflicts = nonGtinConflictLedger.filter((entry) => entry.finalStatus === "alias").length;
  const redactedConflictLedger = { schemaVersion: "1.0.0", entries: [
    ...nonGtinConflictLedger,
    ...[...ledger.values()].map((entry) => ({ sourcePointerHmacSha256: entry.bossSourcePointerHmacSha256, finalStatus: "accepted", reason: "reviewed_mpn_field_omitted", identifierHmacSha256: entry.canonicalKeyHmacSha256 })),
  ].sort((a, b) => `${a.sourcePointerHmacSha256}:${a.reason}`.localeCompare(`${b.sourcePointerHmacSha256}:${b.reason}`)) };
  if (expectedCounts && (bossCanonicals.size !== expectedCounts.admittedBossCodes || acceptedSpellings !== expectedCounts.acceptedSpellings || bossProductIdentities.size !== expectedCounts.bossCanonicalProductIds || nonGtinApprovedRows !== expectedCounts.nonGtinApprovedRows ||
    nonGtinApprovedIdentifiers !== expectedCounts.nonGtinApprovedIdentifiers || nonGtinBlankAliasConflicts !== expectedCounts.nonGtinBlankAliasConflicts)) {
    throw new Error(`Boss cardinality mismatch: codes=${bossCanonicals.size}, spellings=${acceptedSpellings}, nonGtin=${nonGtinApprovedIdentifiers}, blankAliases=${nonGtinBlankAliasConflicts}`);
  }
  try {
    const shards = Object.fromEntries(SHARDS.map((shard) => [shard, {}]));
    for (const [key, value] of [...all.entries()].sort(([a], [b]) => a.localeCompare(b))) shards[shardFor(key)][key] = value.row;
    const shardHashes = {}; const shardCounts = {}; const shardBytes = {};
    for (const shard of SHARDS) { const bytes = Buffer.from(JSON.stringify(shards[shard]) + "\n"); shardHashes[shard] = sha256(bytes); shardCounts[shard] = Object.keys(shards[shard]).length; shardBytes[shard] = bytes.length; writeFileSync(join(staged, `${shard}.json`), bytes); }
    const conflictLedgerBytes = Buffer.from(JSON.stringify(redactedConflictLedger, null, 2) + "\n");
    writeFileSync(join(staged, "conflict-ledger.json"), conflictLedgerBytes);
    const manifest = { schemaVersion: "2.0.0", generatorVersion: "2.0.0", shardAlgorithm: "sha256-first-byte-mod-64-v1", bossHmacAlgorithm: "hmac-sha256-domain-separated-v1", bossKeyFingerprint: keyedDigest(bossHmacKey, "key-fingerprint:v1", "scanbin-boss-exact-index"), approvedCorpusSha256: expected.global, repairSha256: expected.repair, reconciliationSha256: expected.reconciliation, collisionDispositionCount: ledger.size, collisionDispositionLedgerSha256: dispositionLedger.digest, conflictLedgerCount: redactedConflictLedger.entries.length, conflictLedgerSha256: sha256(conflictLedgerBytes), admittedBossCodes: bossCanonicals.size, acceptedSpellings, bossCanonicalProductIds: bossProductIdentities.size, nonGtinApprovedRows, nonGtinApprovedIdentifiers, nonGtinBlankAliasConflicts, nonGtinConflictLedgerSha256: sha256(JSON.stringify(nonGtinConflictLedger)), excludedCasePacks, blockedBossPackageKeys: [...blockedPackages].map((key) => bossLookupKey(bossHmacKey, key)).sort(), shardHashes, shardCounts, shardBytes, totalShardBytes: Object.values(shardBytes).reduce((sum, value) => sum + value, 0), totalKeys: all.size };
    manifest.contentDigest = sha256(JSON.stringify(manifest)); writeFileSync(join(staged, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const totalBytes = requireOutputLimits(staged, manifest);
    if (options.check) validateOnDiskArtifact(outputDir, staged);
    if (!options.dryRun && !options.check) { const backup = `${outputDir}.previous`; const fsOps = { renameSync, ...(options.fileSystem ?? {}) }; rmSync(backup, { recursive: true, force: true }); if (existsSync(outputDir)) fsOps.renameSync(outputDir, backup); try { fsOps.renameSync(staged, outputDir); rmSync(backup, { recursive: true, force: true }); } catch (error) { if (existsSync(backup) && !existsSync(outputDir)) fsOps.renameSync(backup, outputDir); throw error; } }
    return { manifest, totalBytes, shardBytes };
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true, force: true }); }
}

function cli() {
  const check = process.argv.includes("--check");
  const result = buildExactIndex({ dryRun: check, check });
  console.log(`[build-tire-exact-index] OK keys=${result.manifest.totalKeys} boss=${result.manifest.admittedBossCodes} bytes=${result.totalBytes} digest=${result.manifest.contentDigest}${check ? " check" : ""}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
