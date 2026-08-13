#!/usr/bin/env node
// scripts/proof-all.mjs
//
// THE HONEST GATE. Created 2026-08-12 after `npm run proof:local` reported 4128
// tests passing while scripts/refresh-tire-meta.test.mjs was RED -- that suite is
// vitest-excluded and only runs under `node --test`, so proof:local could not see
// it. The same session found 11 *.rules.test.ts suites that self-skip without a
// Firestore emulator, and 9 vitest-excluded node:test files wired to no runner at
// all (they passed; nothing had run them in months).
//
// The lesson: "the tests passed" is meaningless unless you know WHICH tests ran.
//
// This script does two things proof:local does not:
//   1. Runs every local suite, including the node:test files vitest excludes.
//   2. Prints an explicit NOT RUN section naming the suites that did not execute
//      and the command that would run them -- so green is never mistaken for total.
//
// Exit code is non-zero if any leg fails. Suites that require external services
// (Firestore emulator, a dev server, a browser) are reported, never silently
// assumed. Nothing here calls a paid or live API.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const NODE_TEST_SUITES = [
  // Wired to an npm script already.
  "scripts/refresh-tire-meta.test.mjs",
  "scripts/certify-boss-barcodes.node-test.mjs",
  // ORPHANED before 2026-08-12: excluded from vitest.config.ts AND absent from every
  // runner. They pass; they simply protected nothing. Adopted here.
  "scripts/boss-workbook-reconcile-dryrun.test.mjs",
  "scripts/boss-override-2026-08-05.test.mjs",
  "scripts/kkm-catalog/init-db.test.mjs",
  "scripts/tire-db-repair/03_part_number_aliases.test.mjs",
  "scripts/tire-db-repair/09_promote_preflight.test.mjs",
  "scripts/tire-db-repair/10_promote_execute.test.mjs",
  "scripts/tire-db-repair/11_twin_columns.test.mjs",
  "scripts/tire-db-repair/model_styling.test.mjs",
  "scripts/tire-db-repair/validate.test.mjs",
];

// Suites this gate deliberately does NOT run, with the reason and the real command.
// Listed in the output every time so their absence is never invisible.
const NOT_RUN = [
  ["Firestore rules + repository suites (11 *.rules.test.ts)", "self-skip without an emulator", "npm run test:firebase"],
  ["Mock Playwright E2E", "needs a dev server on port 3100", "npm run test:e2e"],
  ["Human-bot browser proof", "needs a dev server on port 3300", "npm run qa:bots"],
  ["Production build", "slow; run before shipping", "npm run build"],
];

const results = [];

function run(label, cmd, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  // shell:true is needed on Windows to resolve `npx`, but it MUST NOT be used for
  // process.execPath -- the node binary lives under "C:\Program Files\nodejs" and the
  // space splits the command ("'C:\Program' is not recognized").
  const needsShell = process.platform === "win32" && cmd !== process.execPath;
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: needsShell });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;

  // vitest: "Tests  4128 passed | 105 skipped (4233)" -- surface skips, they are the blind spot.
  const vitest = out.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/);
  // node:test: "ℹ pass 12" / "ℹ fail 0"
  const nodePass = out.match(/^\s*.?\s*pass (\d+)$/m);
  const nodeFail = out.match(/^\s*.?\s*fail (\d+)$/m);

  let detail = ok ? "ok" : `FAILED (exit ${r.status})`;
  let skipped = 0;
  if (vitest) { detail = `${vitest[1]} passed`; skipped = Number(vitest[2] ?? 0); if (skipped) detail += `, ${skipped} skipped`; }
  else if (nodePass) { detail = `${nodePass[1]} passed`; if (nodeFail && Number(nodeFail[1]) > 0) detail += `, ${nodeFail[1]} FAILED`; }

  results.push({ label, ok, detail, skipped });
  if (!ok) process.stdout.write(out.split("\n").slice(-25).join("\n") + "\n");
  else process.stdout.write(`${detail}\n`);
  return ok;
}

run("typecheck (tsc --noEmit)", "npx", ["tsc", "--noEmit"]);
run("vitest (unit + dom)", "npx", ["vitest", "run"]);

const missing = NODE_TEST_SUITES.filter((f) => !existsSync(f));
const present = NODE_TEST_SUITES.filter((f) => existsSync(f));
if (present.length) run(`node:test (${present.length} vitest-excluded suites)`, process.execPath, ["--test", ...present]);
run("teach bot suite", process.execPath, ["--test", "e2e/teach/**/*.test.mjs"]);

// ---- report ----
const failed = results.filter((r) => !r.ok);
const totalSkipped = results.reduce((n, r) => n + r.skipped, 0);

process.stdout.write("\n" + "=".repeat(64) + "\nPROOF:ALL SUMMARY\n" + "=".repeat(64) + "\n");
for (const r of results) process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(42)} ${r.detail}\n`);

if (missing.length) {
  process.stdout.write(`\n  WARNING: ${missing.length} configured suite(s) no longer exist on disk:\n`);
  for (const f of missing) process.stdout.write(`    - ${f}  (remove it from NODE_TEST_SUITES or restore the file)\n`);
}

process.stdout.write("\nNOT RUN BY THIS GATE -- green above does NOT cover these:\n");
for (const [name, why, cmd] of NOT_RUN) process.stdout.write(`  - ${name}\n      ${why}; run: ${cmd}\n`);
if (totalSkipped) process.stdout.write(`\n  ${totalSkipped} test(s) reported SKIPPED above (mostly the emulator-gated suites).\n`);

if (failed.length) {
  process.stdout.write(`\nRESULT: FAILED -- ${failed.length} leg(s): ${failed.map((f) => f.label).join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("\nRESULT: all local legs green (see NOT RUN above for what that excludes)\n");
