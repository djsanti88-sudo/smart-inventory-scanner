import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { validateBatchResult } from "./validate-result.mjs";
import { validateManifest } from "./generate-manifest.mjs";
import { assertLocalDemoDatabase } from "../local-demo-preflight.mjs";

const MANIFEST_KEYS = ["schemaVersion", "seed", "gitSha", "databaseSha256", "generatedAt", "total", "batchSize", "batchCount", "agentCount", "manifestSha256", "rows"];
const MANIFEST_ROW_KEYS = ["barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size", "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season", "sourceCount", "confidence", "currentStatus", "usableFor", "fieldCompletenessScore", "angle", "stratum", "ordinal", "batch", "agent"];
const BATCH_KEYS = ["schemaVersion", "gitSha", "databaseSha256", "seed", "batch", "agent", "rowCount", "batchSha256", "expectedBarcodesSha256", "expectedCanonicalProductUidsSha256", "rows"];
const ACTIVE_RUN_KEYS = ["schemaVersion", "runDirectory", "gitSha", "databaseSha256", "manifestSha256", "generatedAt"];
const RUNTIME_SESSION_KEYS = ["schemaVersion", "gitSha", "databaseSha256", "manifestSha256", "runDirectory", "ledgerPath", "nonce", "startedAt"];
const EGRESS_ENTRY_KEYS = ["pid", "timestamp", "method", "protocol", "host", "path"];

function nearest(values, percentile) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * percentile / 100) - 1] ?? 0; }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hasExactKeys(value, expectedKeys) { const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : []; const expected = [...expectedKeys].sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function throwInvalid(message) { throw new Error(`Invalid local tire proof anchor: ${message}`); }

function isContainedPath(root, path) {
  const within = relative(root, path);
  return Boolean(within) && !within.startsWith("..") && !isAbsolute(within);
}

function databaseRows(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT barcode, barcode_type, canonical_product_uid, brand, model, model_display,
      size, load_index, speed_rating, manufacturer_part_number, type, season, source_count, confidence,
      current_status, usable_for, field_completeness_score FROM tires`).all();
  } finally { db.close(); }
}

function defaultVerifyCurrentRun(manifest, batches) {
  const currentGitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  if (manifest.gitSha !== currentGitSha) throwInvalid("manifest git SHA does not equal current git HEAD");
  const databasePath = resolve("src/server/knowledge.generated.db");
  const database = assertLocalDemoDatabase(databasePath);
  if (manifest.databaseSha256 !== database.databaseSha256) throwInvalid("manifest database SHA does not equal the current local database");
  validateManifest(manifest, batches, { sourceRows: databaseRows(databasePath) });
}

function isStrictEgressEntry(value) {
  return hasExactKeys(value, EGRESS_ENTRY_KEYS) && Number.isSafeInteger(value.pid) &&
    typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)) &&
    typeof value.method === "string" && value.method.length > 0 && value.method.length <= 16 &&
    typeof value.protocol === "string" && /^[a-z]+:$/.test(value.protocol) &&
    typeof value.host === "string" && value.host.length > 0 && value.host.length <= 255 &&
    typeof value.path === "string" && value.path.startsWith("/") && value.path.length <= 2048 && !value.path.includes("?");
}

function readLiveRuntimeSession(root, manifest) {
  const sessionPath = join(root, "runtime-session.json");
  const resolvedSessionPath = realpathSync(sessionPath);
  if (relative(root, resolvedSessionPath) !== "runtime-session.json") throwInvalid("runtime session path");
  const session = readJson(resolvedSessionPath);
  if (!hasExactKeys(session, RUNTIME_SESSION_KEYS) || session.schemaVersion !== 1 ||
    session.gitSha !== manifest.gitSha || session.databaseSha256 !== manifest.databaseSha256 ||
    session.manifestSha256 !== manifest.manifestSha256 || session.runDirectory !== basename(root) ||
    typeof session.ledgerPath !== "string" || typeof session.nonce !== "string" || !/^[a-f0-9]{32,}$/i.test(session.nonce) ||
    typeof session.startedAt !== "string" || !Number.isFinite(Date.parse(session.startedAt))) throwInvalid("runtime session binding");
  const runtimeRoot = realpathSync(resolve(dirname(root), "runtime"));
  const requestedLedgerPath = resolve(session.ledgerPath);
  if (!isAbsolute(session.ledgerPath) || !isContainedPath(runtimeRoot, requestedLedgerPath) || !requestedLedgerPath.endsWith(".jsonl")) throwInvalid("runtime egress ledger path");
  const ledgerPath = realpathSync(requestedLedgerPath);
  if (!isContainedPath(runtimeRoot, ledgerPath) || !statSync(ledgerPath).isFile()) throwInvalid("runtime egress ledger path");
  const bytes = readFileSync(ledgerPath);
  const ledgerSha256 = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  const entries = text.trim() === "" ? [] : text.trimEnd().split(/\r?\n/).map((line, index) => {
    try { return JSON.parse(line); } catch { throwInvalid(`runtime egress ledger JSONL line ${index + 1}`); }
  });
  if (!entries.every(isStrictEgressEntry)) throwInvalid("runtime egress ledger schema");
  if (entries.length !== 0) throwInvalid(`runtime egress ledger contains ${entries.length} blocked attempt(s)`);
  return { ledgerPath, ledgerSha256, entries, nonce: session.nonce };
}

function readManifestAnchor(root) {
  const manifest = readJson(join(root, "manifest.json"));
  const active = readJson(join(dirname(root), "active-run.json"));
  if (!hasExactKeys(manifest, MANIFEST_KEYS)) throwInvalid("manifest schema");
  if (!hasExactKeys(active, ACTIVE_RUN_KEYS)) throwInvalid("active-run schema");
  const unsigned = { ...manifest }; delete unsigned.manifestSha256;
  if (manifest.manifestSha256 !== hash(unsigned)) throwInvalid("manifest SHA-256");
  if (manifest.schemaVersion !== 1 || typeof manifest.seed !== "string" || !manifest.seed || !/^[a-f0-9]{7,64}$/i.test(manifest.gitSha) || !/^[a-f0-9]{64}$/i.test(manifest.databaseSha256) || Number.isNaN(Date.parse(manifest.generatedAt)) || manifest.total !== 3000 || manifest.batchSize !== 100 || manifest.batchCount !== 30 || manifest.agentCount !== 10 || !Array.isArray(manifest.rows) || manifest.rows.length !== 3000 || manifest.rows.some((row) => !hasExactKeys(row, MANIFEST_ROW_KEYS))) throwInvalid("manifest contents");
  if (active.schemaVersion !== 1 || active.runDirectory !== basename(root) || active.gitSha !== manifest.gitSha || active.databaseSha256 !== manifest.databaseSha256 || active.manifestSha256 !== manifest.manifestSha256 || active.generatedAt !== manifest.generatedAt) throwInvalid("active-run binding");
  return manifest;
}

function readAnchoredEntries(root, batches, results, manifest, runtimeSessionNonce) {
  return Array.from({ length: 30 }, (_, index) => {
    const batchNumber = index + 1;
    const name = `batch-${String(batchNumber).padStart(2, "0")}.json`;
    const batch = readJson(join(batches, name));
    const result = readJson(join(results, name));
    const rows = manifest.rows.slice(index * 100, (index + 1) * 100);
    const expectedHashes = { batchSha256: hash(rows), expectedBarcodesSha256: hash(rows.map((row) => row.barcode)), expectedCanonicalProductUidsSha256: hash(rows.map((row) => row.canonicalProductUid)) };
    if (!hasExactKeys(batch, BATCH_KEYS) || batch.schemaVersion !== 1 || batch.batch !== batchNumber || batch.agent !== rows[0]?.agent || batch.rowCount !== 100 || batch.gitSha !== manifest.gitSha || batch.databaseSha256 !== manifest.databaseSha256 || batch.seed !== manifest.seed || JSON.stringify(batch.rows) !== JSON.stringify(rows) || Object.entries(expectedHashes).some(([key, value]) => batch[key] !== value)) throwInvalid(`batch-${String(batchNumber).padStart(2, "0")} binding`);
    if (result?.ledgerProof?.manifest?.batch !== batchNumber) throwInvalid(`result batch-${String(batchNumber).padStart(2, "0")} binding`);
    return { batch, result, anchor: { batch: batchNumber, manifest, runtimeSessionNonce } };
  });
}

export function summarizeResults(entries) {
  if (!Array.isArray(entries) || entries.length !== 30) throw new Error("A green local tire proof requires exactly 30 result files.");
  const validations = entries.map(({ batch, result, anchor }) => validateBatchResult(batch, result, anchor));
  const numbers = entries.map(({ batch }) => batch?.batch).sort((a, b) => a - b);
  if (numbers.some((number, index) => number !== index + 1)) throw new Error("Proof batches must contain internal batch numbers 1 through 30 exactly once.");
  if (validations.some((validation) => !validation.passed)) throw new Error("A green local tire proof requires every batch and ledger proof to pass.");
  const latencies = entries.flatMap(({ result }) => result.observations.map((row) => row.latencyMs));
  return { schemaVersion: 1, passed: true, batchCount: 30, total: validations.reduce((sum, item) => sum + item.inputCount, 0), countedQuantity: validations.reduce((sum, item) => sum + item.countedQuantity, 0), correctVerified: validations.reduce((sum, item) => sum + item.correctVerified, 0), wrongVerified: validations.reduce((sum, item) => sum + item.wrongVerified, 0), feedMissing: validations.reduce((sum, item) => sum + item.feedMissing, 0), consoleErrorCount: validations.reduce((sum, item) => sum + item.consoleErrorCount, 0), nonLocalRequestCount: validations.reduce((sum, item) => sum + item.nonLocalRequestCount, 0), serverEgressAttemptCount: entries.reduce((sum, entry) => sum + entry.result.serverEgressAttempts.length, 0), p50Ms: nearest(latencies, 50), p95Ms: nearest(latencies, 95), p99Ms: nearest(latencies, 99), batches: validations };
}

export function summarizeDirectory(runDirectory, { verifyCurrentRun = defaultVerifyCurrentRun } = {}) {
  const root = realpathSync(resolve(runDirectory)); const batches = join(root, "batches"); const results = join(root, "results"); const manifest = readManifestAnchor(root);
  for (const directory of [batches, results]) { const names = readdirSync(directory).sort(); const expected = Array.from({ length: 30 }, (_, index) => `batch-${String(index + 1).padStart(2, "0")}.json`); if (names.length !== 30 || names.some((name, index) => name !== expected[index])) throw new Error("Proof directory requires exactly batch-01 through batch-30 JSON files."); }
  const runtime = readLiveRuntimeSession(root, manifest);
  const entries = readAnchoredEntries(root, batches, results, manifest, runtime.nonce);
  verifyCurrentRun(manifest, entries.map(({ batch }) => batch));
  const summary = { ...summarizeResults(entries), runtimeEgressLedgerSha256: runtime.ledgerSha256, runtimeEgressLedgerPath: runtime.ledgerPath };
  writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`); writeFileSync(join(root, "REPORT.md"), `# Local Tire Demo Proof\n\n**PASS** - ${summary.total}/3000 scans; 30/30 ledger proofs passed; ledger quantity ${summary.countedQuantity}; correct ${summary.correctVerified}; wrong ${summary.wrongVerified}; feed missing ${summary.feedMissing}; console ${summary.consoleErrorCount}; zero egress confirmed (nonlocal ${summary.nonLocalRequestCount}; server egress ${summary.serverEgressAttemptCount}; runtime ledger ${summary.runtimeEgressLedgerSha256}); p95 ${summary.p95Ms} ms.\n\n| Batch | Input | Count | Wrong | Errors | Egress | p95 |\n| - | -: | -: | -: | -: | -: | -: |\n${summary.batches.map((batch, index) => `| ${index + 1} | ${batch.inputCount} | ${batch.countedQuantity} | ${batch.wrongVerified} | ${batch.consoleErrorCount} | ${batch.nonLocalRequestCount} | ${batch.p95Ms} |`).join("\n")}\n`); return summary;
}
if (process.argv[1]?.endsWith("summarize.mjs")) console.log(JSON.stringify(summarizeDirectory(process.argv[2] ?? process.cwd()), null, 2));
