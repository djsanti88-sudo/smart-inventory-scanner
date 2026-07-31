#!/usr/bin/env node
/**
 * Deliberate local-only artifact gate for Task 5. This runner never calls a
 * provider, network, decode route, persistence service, or production target.
 * It cannot make synthetic data promotion-eligible.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "src/eval/identity/fixtures/identity-manifest.v1.json");
const baselinePath = resolve(root, "src/eval/identity/reports/baseline.v1.json");

function assertSyntheticOnly(value) {
  if (
    value?.manifestVersion !== "identity-manifest-v1" ||
    value.syntheticOnly !== true ||
    value.promotionEligible !== false ||
    !Array.isArray(value.promotionBlockers) ||
    !value.promotionBlockers.includes("synthetic_only") ||
    !value.promotionBlockers.includes("real_export_evidence_required")
  ) {
    throw new Error("synthetic_manifest_must_remain_promotion_ineligible");
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const command = process.argv[2] ?? "--evaluate";
  if (command !== "--evaluate" && command !== "--write-synthetic-baseline") {
    throw new Error("usage: node scripts/benchmark-identity-import.mjs [--evaluate|--write-synthetic-baseline]");
  }
  const manifest = await readJson(manifestPath);
  assertSyntheticOnly(manifest);
  const baseline = await readJson(baselinePath);
  if (baseline.syntheticOnly !== true || baseline.promotionEligible !== false || baseline.baselineStatus !== "not_a_promotion_baseline") {
    throw new Error("synthetic_baseline_must_remain_promotion_ineligible");
  }
  if (command === "--write-synthetic-baseline") {
    // This explicit maintenance action deliberately preserves the hard blockers.
    await writeFile(baselinePath, `${JSON.stringify({ ...baseline, manifestVersion: manifest.manifestVersion, syntheticOnly: true, promotionEligible: false, promotionBlockers: ["synthetic_only", "real_export_evidence_required"], baselineStatus: "not_a_promotion_baseline" }, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ mode: command.slice(2), cases: manifest.cases.length, syntheticOnly: true, promotionEligible: false, networkCalls: 0, providerCalls: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
