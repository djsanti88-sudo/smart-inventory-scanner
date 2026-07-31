#!/usr/bin/env node
/** Deliberate local-only evaluator artifact runner. No provider/network/decode/persistence imports. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "src/eval/identity/fixtures/identity-manifest.v1.json");
const baselinePath = resolve(root, "src/eval/identity/reports/baseline.v1.json");
const command = process.argv.find((argument) => argument === "--evaluate" || argument === "--write-synthetic-baseline") ?? "--evaluate";

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
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
  const report = await buildReport();
  if (command === "--write-synthetic-baseline") await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (JSON.stringify(baseline) !== JSON.stringify(report)) throw new Error("baseline_report_mismatch");
  }
  process.stdout.write(`${JSON.stringify({ mode: command.slice(2), cases: report.metrics.rowAccounting.input, syntheticOnly: true, promotionEligible: false, networkCalls: 0, providerCalls: 0 })}\n`);
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
