#!/usr/bin/env node
/** Deliberate local-only evaluator artifact runner. No provider/network/decode/persistence imports. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "src/eval/identity/fixtures/identity-manifest.v1.json");
const baselinePath = resolve(root, "src/eval/identity/reports/baseline.v1.json");
const importPerformanceBaselinePath = resolve(root, "src/eval/identity/reports/import-perf-baseline.v1.json");
const command = process.argv.find((argument) => argument === "--evaluate" || argument === "--write-synthetic-baseline") ?? "--evaluate";
const importPerformance = process.argv.includes("--import-performance");
const compareBaseline = process.argv.includes("--compare-baseline");
const format = process.argv.includes("--format=markdown") ? "markdown" : "json";
const writeImportBaseline = process.argv.includes("--write-import-performance-baseline");

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function canonicalSha256(value) { return createHash("sha256").update(`identity-import-v1:${canonicalJson(value)}`).digest("hex"); }
function assertSynthetic(value) {
  if (value?.manifestVersion !== "identity-manifest-v1" || value.syntheticOnly !== true || value.promotionEligible !== false || !Array.isArray(value.promotionBlockers) || !value.promotionBlockers.includes("synthetic_only") || !value.promotionBlockers.includes("real_export_evidence_required")) throw new Error("synthetic_manifest_must_remain_promotion_ineligible");
}
async function buildReport() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertSynthetic(manifest);
  const source = await readFile(resolve(root, "src/eval/identity/evaluator.ts"), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const { evaluateIdentityCases } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const metrics = evaluateIdentityCases(manifest.cases, manifest.expectedDecisions, { splitSeed: manifest.splitSeed, bootstrapSeed: "identity-bootstrap-v1", bootstrapSamples: 1000 });
  return { reportVersion: "identity-baseline-v1", manifestVersion: manifest.manifestVersion, syntheticOnly: true, promotionEligible: false, promotionBlockers: ["synthetic_only", "real_export_evidence_required"], baselineStatus: "not_a_promotion_baseline", evaluatorVersion: "identity-evaluator-v1", splitSeed: manifest.splitSeed, manifestHash: hash({ ...manifest, expectedDecisions: undefined }), decisionHash: hash(manifest.expectedDecisions), metrics };
}
async function main() {
  if (importPerformance) {
    const baseline = JSON.parse(await readFile(importPerformanceBaselinePath, "utf8"));
    const fixtureBytes = await readFile(resolve(root, "src/eval/identity/fixtures/frozen-5000.v1.json"));
    const fixture = JSON.parse(fixtureBytes.toString("utf8"));
    if (fixture.fixtureVersion !== baseline.fixture.fixtureVersion || fixture.rowCount !== baseline.fixture.rowCount || fixture.sourceHash !== baseline.fixture.sourceHash) throw new Error("import_performance_fixture_mismatch");
    if (!Array.isArray(fixture.rows) || fixture.rows.length !== 5_000 || !Array.isArray(fixture.snapshot?.barcodeCandidates) || fixture.snapshot.barcodeCandidates.length !== 2_000 || canonicalSha256({ rows: fixture.rows, snapshot: fixture.snapshot }) !== fixture.contentSha256) throw new Error("import_performance_canonical_fixture_mismatch");
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
    if (fixtureSha256 !== baseline.fixture.fixtureSha256) throw new Error("import_performance_fixture_hash_mismatch");
    const run = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "src/eval/identity/importPerf.test.ts"], { cwd: root, encoding: "utf8", env: { ...process.env, IDENTITY_CAPTURE_PERF: "1" } });
    const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const match = combined.match(/IDENTITY_PERF_METRICS=(\{[^\r\n]+\})/);
    if (!match) throw new Error(`import_performance_measurement_failed:${run.status ?? "unknown"}`);
    const metrics = JSON.parse(match[1]);
    const cpus = os.cpus();
    const current = { platform: process.platform, release: os.release(), arch: process.arch, cpu: cpus[0]?.model ?? "unknown", logicalConcurrency: cpus.length, node: process.version };
    const comparable = Object.keys(current).every((key) => current[key] === baseline.environment[key]);
    if (metrics.warmMedianMs > baseline.gates.warmPreviewWallMs || metrics.decisionP95Ms > baseline.gates.decisionP95Ms) throw new Error("import_performance_absolute_gate_failed");
    if (compareBaseline && comparable && metrics.warmMedianMs > baseline.metrics.warmMedianMs * baseline.gates.baselineTolerance) throw new Error("import_performance_baseline_regression");
    const report = { ...baseline, recordedAt: writeImportBaseline ? new Date().toISOString() : baseline.recordedAt, environment: writeImportBaseline ? current : baseline.environment, fixture: { ...baseline.fixture, fixtureSha256, quantity: fixture.expectedQuantity, buckets: fixture.buckets }, metrics, mode: "offline-import-performance", comparison: compareBaseline ? (comparable ? { status: "recorded_machine", tolerance: baseline.gates.baselineTolerance, limitMs: baseline.metrics.warmMedianMs * baseline.gates.baselineTolerance } : { status: "environment_mismatch", current, recorded: baseline.environment }) : { status: "not_requested" } };
    if (writeImportBaseline) await writeFile(importPerformanceBaselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(format === "markdown"
      ? `# Local identity import performance\n\nFixture: ${fixture.fixtureVersion}, ${fixture.rowCount} rows.\n\nWarm median: ${report.metrics.warmMedianMs} ms. Decision p95: ${report.metrics.decisionP95Ms} ms. Browser main thread: BLOCKED.\n`
      : `${JSON.stringify(report)}\n`);
    return;
  }
  const report = await buildReport();
  if (command === "--write-synthetic-baseline") await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (JSON.stringify(baseline) !== JSON.stringify(report)) throw new Error("baseline_report_mismatch");
  }
  process.stdout.write(`${JSON.stringify({ mode: command.slice(2), cases: report.metrics.rowAccounting.input, syntheticOnly: true, promotionEligible: false, networkCalls: 0, providerCalls: 0 })}\n`);
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
