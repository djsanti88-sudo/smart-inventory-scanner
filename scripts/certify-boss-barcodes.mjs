#!/usr/bin/env node
// Local-only certification wrapper.  The private reconciliation source is passed only by path and
// is hash-checked inside the test; no barcode values or receipts are committed to this repository.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseCertificationArgs(argv) {
  let target = "";
  let maxProviderCalls = Number.NaN;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") target = argv[++index] ?? "";
    else if (arg === "--max-provider-calls") maxProviderCalls = Number(argv[++index]);
    else throw new Error(`Unknown certification argument: ${arg}`);
  }
  if (target !== "direct") throw new Error("This runner performs local direct proof only; Preview requires its separate approval gate.");
  if (maxProviderCalls !== 0) throw new Error("Direct certification requires zero provider calls.");
  return { target, maxProviderCalls };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseCertificationArgs(argv);
  const source = env.BOSS_RECONCILIATION_PATH;
  if (!source || !existsSync(source)) throw new Error("BOSS_RECONCILIATION_PATH must name the available private reconciliation source.");
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/server/tire-knowledge/bossCorpusDirect.test.ts"], {
    cwd: resolve("."),
    env: { ...env, BOSS_RECONCILIATION_PATH: source },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log("[certify-boss-barcodes] PASS local direct proof: zero provider calls required and source values remain private.");
  return args;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(`[certify-boss-barcodes] FAIL ${String(error instanceof Error ? error.message : error)}`); process.exitCode = 1; }
}
