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
// This script does three things proof:local does not:
//   1. Runs every local suite, including the node:test files vitest excludes.
//   2. Prints an explicit NOT RUN section naming the suites that did not execute
//      and the command that would run them -- so green is never mistaken for total.
//   3. DISCOVERS test files itself (2026-08-16 clean-room review, HIGH) instead of
//      trusting only a hand-maintained list. A file this gate does not know about
//      cannot be protected by it -- see the SELF-DETECTION section below.
//
// Exit code is non-zero if any leg fails, if the discovery scan finds an orphaned
// test file no runner accounts for, or if the run was narrowed without explicit
// acknowledgment (see NARROWED, below). Suites that require external services
// (Firestore emulator, a dev server, a browser) are reported, never silently
// assumed. Nothing here calls a paid or live API.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  // ORPHANED before 2026-08-16: `test:certify:boss-barcodes` wires up the certification
  // file and e2e/boss-barcode-corpus/fixtures.test.mjs, but proof-all.mjs only ran the
  // former -- fixtures.test.mjs (and its five siblings, which have no npm script at all)
  // could go red while this gate reported green. The 2026-08-16 self-detection scan (see
  // discoverTestFiles/findOrphanTestFiles below) is what actually caught this; these are
  // adopted here as the fix, not just as a manually-found patch.
  "e2e/boss-barcode-corpus/fixtures.test.mjs",
  "e2e/boss-barcode-corpus/local-corpus-ui.contract.test.mjs",
  "e2e/boss-barcode-corpus/local-sample.test.mjs",
  "e2e/boss-barcode-corpus/production-server.test.mjs",
  "e2e/boss-barcode-corpus/receipt.test.mjs",
  "e2e/boss-barcode-corpus/reporter.test.mjs",
  "e2e/boss-barcode-corpus/run.test.mjs",
  // ORPHANED before 2026-08-16: e2e/boss-barcode-preview/ is a brand-new, still-untracked
  // suite (Vercel Preview certification harness) with no npm script referencing its
  // *.test.mjs files at all -- the same self-detection scan caught it too. One file in this
  // directory (fixtures.test.mjs) needs a private, never-committed BOSS_RECONCILIATION_PATH
  // and is declared in NOT_RUN below instead; the rest run cleanly with no external data.
  "e2e/boss-barcode-preview/admin.test.mjs",
  "e2e/boss-barcode-preview/calibration-barrier.test.mjs",
  "e2e/boss-barcode-preview/config.test.mjs",
  "e2e/boss-barcode-preview/finalize.test.mjs",
  "e2e/boss-barcode-preview/persistence.test.mjs",
  "e2e/boss-barcode-preview/receipt.test.mjs",
  "e2e/boss-barcode-preview/reporter.test.mjs",
  "e2e/boss-barcode-preview/run.test.mjs",
  "e2e/boss-barcode-preview/terminal.test.mjs",
  "e2e/boss-barcode-preview/vercel-inspect.test.mjs",
];

// Suites this gate deliberately does NOT run, with the reason and the real command.
// Listed in the output every time so their absence is never invisible. `files`, when
// present, names the exact discovered test file(s) this entry accounts for -- it is what
// lets findOrphanTestFiles() tell "declared and skipped for a real reason" apart from
// "nobody wrote this suite down anywhere" (see SELF-DETECTION below).
const NOT_RUN = [
  ["Firestore rules + repository suites (11 *.rules.test.ts)", "self-skip without an emulator", "npm run test:firebase"],
  ["Mock Playwright E2E", "needs a dev server on port 3100", "npm run test:e2e"],
  ["Real (non-bypass) sync-visibility E2E (scan-sync-visibility.spec.ts)", "needs its own dev server on port 3101 with NEXT_PUBLIC_E2E_AUTH_BYPASS off - the flag every other mock webServer forces on", "npm run test:e2e:no-bypass"],
  ["Human-bot browser proof", "needs a dev server on port 3300", "npm run qa:bots"],
  ["Production build", "slow; run before shipping", "npm run build"],
  [
    "Boss Preview corpus fixtures (e2e/boss-barcode-preview/fixtures.test.mjs)",
    "needs BOSS_RECONCILIATION_PATH, a private source file that is never committed",
    "BOSS_RECONCILIATION_PATH=<path> node --test e2e/boss-barcode-preview/fixtures.test.mjs",
    ["e2e/boss-barcode-preview/fixtures.test.mjs"],
  ],
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

// CI-only opt-out knobs (both default to empty => identical full local behavior).
// Set by .github/workflows/ci.yml for suites that need data this gate cannot supply
// in a fresh clean-checkout runner (see that workflow's comments for exact reasons).
// Never used to silently narrow the LOCAL gate -- a developer running `npm run
// proof:all` with no env vars set still gets the full suite, unchanged.
const VITEST_EXTRA_EXCLUDE = (process.env.VITEST_EXTRA_EXCLUDE || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const NODE_TEST_SKIP = new Set(
  (process.env.NODE_TEST_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)
);
// A narrowed run (either knob above set) must never be reported as a plain success --
// see buildSummaryReport's RESULT line and computeExitCode below. CI sets this explicitly
// alongside its narrowing knobs so the reduced-coverage run is a deliberate, visible
// choice, never a silent default (2026-08-16 clean-room review, HIGH).
const PROOF_ALL_ACCEPT_NARROWED = process.env.PROOF_ALL_ACCEPT_NARROWED === "1";

// ---------------------------------------------------------------------------------------
// SELF-DETECTION (2026-08-16 clean-room review, HIGH)
//
// The "missing" check further down only asks whether files ALREADY LISTED in
// NODE_TEST_SUITES still exist on disk. That says nothing about a *.test.mjs/*.test.ts
// file nobody ever added to any list -- vitest doesn't collect it (excluded or outside its
// include globs), no node:test leg runs it, and it isn't named in NOT_RUN. It is invisible:
// it can be red forever while this gate reports green. That is exactly the bug this gate
// exists to end (see the file header).
//
// The fix is a cheap filesystem walk (discoverTestFiles) reconciled against three sets
// this run already knows: what vitest actually collected (read back from its own JSON
// report -- ground truth, not a re-implementation of vitest.config.ts's glob rules), what
// the node:test legs execute, and what NOT_RUN declares. Anything in none of the three is
// an orphan: FAIL CLOSED and name it (findOrphanTestFiles).
// ---------------------------------------------------------------------------------------

const DISCOVERY_ROOTS = ["scripts", "e2e", "src"];
const DISCOVERY_SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "backups", "coverage"]);
const TEST_FILE_RE = /\.test\.(mjs|ts|tsx|js)$/;

/**
 * Cheap recursive filesystem walk -- no test execution, no vitest/node spawn. Finds every
 * *.test.(mjs|ts|tsx|js) file under scripts/, e2e/, and src/, including untracked files
 * (a brand-new suite that was never `git add`ed is exactly the failure mode this exists to
 * catch). `readdir` is injectable for unit testing without touching the real filesystem.
 */
export function discoverTestFiles(roots = DISCOVERY_ROOTS, readdir = readdirSync) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (TEST_FILE_RE.test(entry.name)) out.push(p);
    }
  }
  for (const root of roots) walk(root);
  return out.sort();
}

/**
 * Pure reconciliation -- takes the four sets in as plain data (no I/O) so it can be unit
 * tested directly. A file discovered on disk that is in NONE of collectedByVitest,
 * executedByNodeTest, or declaredNotRun is an orphan: some runner must be told about it,
 * or it protects nothing.
 */
export function findOrphanTestFiles({ discovered, collectedByVitest, executedByNodeTest, declaredNotRun }) {
  const covered = new Set([
    ...(collectedByVitest ?? []),
    ...(executedByNodeTest ?? []),
    ...(declaredNotRun ?? []),
  ]);
  return discovered.filter((f) => !covered.has(f));
}

/** Absolute path (any separator) -> repo-relative POSIX path, for comparing against discoverTestFiles() output. */
function toRepoRelativePosix(absPath, repoRootPosix) {
  const normalized = absPath.split(path.sep).join("/").split("\\").join("/");
  return normalized.startsWith(repoRootPosix) ? normalized.slice(repoRootPosix.length) : normalized;
}

/**
 * Reads back the file list vitest ACTUALLY COLLECTED from the JSON report the real run
 * already wrote (via --reporter=json --outputFile.json=<path> in main(), alongside the
 * normal --reporter=default output). This is ground truth, not a second re-implementation
 * of vitest.config.ts's include/exclude globs that could itself drift out of sync -- and
 * it costs nothing extra: no second vitest invocation, just reading a file the real run
 * already produced. Returns null (not []) when the report is missing or unreadable, so
 * callers can tell "vitest collected zero files" apart from "we don't actually know" --
 * conflating those would treat the vitest leg's own crash as proof every other file is an
 * orphan, which is a confusing way to report a leg failure that already fails the gate.
 */
export function readVitestCollectedFiles(reportPath, repoRootPosix) {
  if (!existsSync(reportPath)) return null;
  try {
    const json = JSON.parse(readFileSync(reportPath, "utf8"));
    const testResults = Array.isArray(json.testResults) ? json.testResults : [];
    return testResults.map((t) => toRepoRelativePosix(t.name, repoRootPosix));
  } catch {
    return null;
  }
}

/**
 * Pure summary formatter -- deliberately separated from the spawnSync run() calls above so it can
 * be unit-tested (scripts/proof-all.summary.test.mjs) without paying for a real tsc/vitest/node:test
 * run every time. Takes only plain data in; returns the printable report text plus the failed list.
 *
 * DEFECT FIX (2026-08-16 clean-room review, HIGH): VITEST_EXTRA_EXCLUDE used to be applied to the
 * vitest invocation (~L95 below) but never surfaced anywhere in this report -- a CI config change
 * that set it produced a fully green PROOF:ALL SUMMARY with silently reduced coverage. Both CI
 * opt-out knobs (VITEST_EXTRA_EXCLUDE and NODE_TEST_SKIP) are now named with equal prominence, and
 * the RESULT line itself is marked NARROWED whenever either is in effect.
 *
 * DEFECT FIX (2026-08-16 clean-room review, HIGH): the word "green" used to appear in the NARROWED
 * branch's own RESULT line ("all local legs green, BUT THIS RUN WAS NARROWED"), so the exact phrase
 * a reviewer would search for to confirm total coverage could be quoted verbatim from a run that
 * proved the opposite. The NARROWED branch below now never contains the substring "green" in any
 * case -- only the genuinely unnarrowed, all-legs-passed branch is allowed to say it.
 *
 * DEFECT FIX (2026-08-16 clean-room review, HIGH): orphaned test files (discovered on disk but run
 * by no runner and declared nowhere -- see findOrphanTestFiles above) are now reported as their own
 * failure, not a footnote. `orphans` flows into `failed` via the caller's `results` entry so a run
 * with orphans always exits non-zero.
 */
export function buildSummaryReport({ results, missing, skippedByEnv, vitestExtraExclude, totalSkipped, orphans }) {
  const failed = results.filter((r) => !r.ok);
  const narrowed = (skippedByEnv?.length ?? 0) > 0 || (vitestExtraExclude?.length ?? 0) > 0;
  const lines = [];

  lines.push("\n" + "=".repeat(64) + "\nPROOF:ALL SUMMARY\n" + "=".repeat(64));
  for (const r of results) lines.push(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(42)} ${r.detail}`);

  if (missing?.length) {
    lines.push(`\n  WARNING: ${missing.length} configured suite(s) no longer exist on disk:`);
    for (const f of missing) lines.push(`    - ${f}  (remove it from NODE_TEST_SUITES or restore the file)`);
  }

  if (orphans?.length) {
    lines.push(`\n  !!! FAIL CLOSED: ${orphans.length} test file(s) discovered on disk but run by NO runner !!!`);
    lines.push(`  Not collected by vitest, not run by a node:test leg, not declared in NOT_RUN:`);
    for (const f of orphans) lines.push(`    - ${f}`);
    lines.push(`  Fix: wire each one into an npm script + NODE_TEST_SUITES, or add it to NOT_RUN with why.`);
  }

  // Both CI-only opt-out knobs get the SAME loud treatment -- neither is a default, both are an
  // exception, and either one narrows what "green" actually proved.
  if (vitestExtraExclude?.length) {
    lines.push(`\n  !!! NARROWED: VITEST_EXTRA_EXCLUDE excluded ${vitestExtraExclude.length} pattern(s) from the vitest leg !!!`);
    for (const p of vitestExtraExclude) lines.push(`    - ${p}`);
  }

  if (skippedByEnv?.length) {
    lines.push(`\n  !!! NARROWED: NODE_TEST_SKIP skipped ${skippedByEnv.length} node:test suite(s) !!!`);
    for (const f of skippedByEnv) lines.push(`    - ${f}`);
  }

  lines.push("\nNOT RUN BY THIS GATE -- green above does NOT cover these:");
  for (const [name, why, cmd] of NOT_RUN) lines.push(`  - ${name}\n      ${why}; run: ${cmd}`);
  if (totalSkipped) lines.push(`\n  ${totalSkipped} test(s) reported SKIPPED above (mostly the emulator-gated suites).`);

  if (failed.length) {
    lines.push(`\nRESULT: FAILED -- ${failed.length} leg(s): ${failed.map((f) => f.label).join(", ")}`);
  } else if (narrowed) {
    lines.push(
      `\nRESULT: NARROWED -- every leg that ran PASSED, but this run's coverage was deliberately reduced ` +
      `(see the NARROWED block(s) above). This is NOT a full pass and must never be described as "all ` +
      `legs passed" without that caveat. Requires PROOF_ALL_ACCEPT_NARROWED=1 to exit non-failing; ` +
      `unacknowledged, this run exits non-zero.`
    );
  } else {
    lines.push("\nRESULT: all local legs green (see NOT RUN above for what that excludes)");
  }

  return { text: lines.join("\n") + "\n", failed, narrowed };
}

/**
 * Pure exit-code decision (2026-08-16 clean-room review, HIGH). Previously main() exited
 * nonzero ONLY on a real leg failure, so a narrowed run -- even one nobody acknowledged --
 * exited 0 and showed a green CI checkmark. Now:
 *   - any real leg failure (including the orphan-discovery pseudo-leg) -> 1
 *   - a narrowed run the caller did NOT explicitly acknowledge -> 2 (distinct from a real
 *     failure, but still non-zero -- a silent default must never look like success)
 *   - a narrowed run the caller DID acknowledge (PROOF_ALL_ACCEPT_NARROWED=1) -> 0
 *   - a clean, unnarrowed, all-legs-passed run -> 0
 */
export function computeExitCode({ failed, narrowed, narrowedAccepted }) {
  if (failed?.length) return 1;
  if (narrowed && !narrowedAccepted) return 2;
  return 0;
}

function repoRootPosix() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const normalized = root.split(path.sep).join("/").split("\\").join("/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function main() {
  run("typecheck (tsc --noEmit)", "npx", ["tsc", "--noEmit"]);

  // --reporter=json --outputFile.json=<tmp> rides along with the normal --reporter=default
  // run (same single vitest invocation, no extra spawn, no noticeable slowdown) so the
  // orphan-discovery reconciliation below can read back exactly which files vitest
  // actually collected -- ground truth, not a re-implementation of its glob config.
  const reportDir = mkdtempSync(path.join(os.tmpdir(), "proof-all-vitest-"));
  const vitestReportPath = path.join(reportDir, "report.json");
  run(
    "vitest (unit + dom)",
    "npx",
    [
      "vitest", "run",
      "--reporter=default", "--reporter=json", `--outputFile.json=${vitestReportPath}`,
      ...VITEST_EXTRA_EXCLUDE.flatMap((p) => ["--exclude", p]),
    ]
  );
  const collectedByVitest = readVitestCollectedFiles(vitestReportPath, repoRootPosix());
  try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

  const missing = NODE_TEST_SUITES.filter((f) => !existsSync(f));
  const skippedByEnv = NODE_TEST_SUITES.filter((f) => existsSync(f) && NODE_TEST_SKIP.has(f));
  const present = NODE_TEST_SUITES.filter((f) => existsSync(f) && !NODE_TEST_SKIP.has(f));
  // --test-concurrency=1 is deliberate. `node --test` runs files in PARALLEL by default,
  // and the tire-db-repair suites are heavy SQLite tests (~3 min each standalone). One of
  // them failed inside a parallel proof:all run on 2026-08-12 and then passed 61/61 three
  // times standalone -- the same "flaky under full parallel load only, fine isolated"
  // pattern already recorded for cloudDrainRace.store.test.ts. Root cause is NOT confirmed
  // (each suite makes its own mkdtemp scratch dir, so it is contention, not collision).
  // Running them serially removes the variable. A gate that intermittently lies is worse
  // than a slow one: people learn to re-run red instead of reading it.
  if (present.length) run(`node:test (${present.length} vitest-excluded suites, serial)`, process.execPath, ["--test", "--test-concurrency=1", ...present]);

  const teachSuites = discoverTestFiles(["e2e/teach"]);
  run("teach bot suite", process.execPath, ["--test", "e2e/teach/**/*.test.mjs"]);

  // SELF-DETECTION: reconcile the real filesystem against what any runner in this file
  // actually knows about. NODE_TEST_SUITES is used in full here (not just `present`) --
  // a suite temporarily narrowed out via NODE_TEST_SKIP is still DECLARED, so it must not
  // be reported as an unknown orphan on top of being reported as narrowed.
  const declaredNotRun = NOT_RUN.flatMap((entry) => entry[3] ?? []);
  const discovered = discoverTestFiles();
  const orphans = collectedByVitest === null
    ? [] // vitest's own leg already failed to produce a report; that failure alone fails the gate below -- don't pile on with a misleading "everything is an orphan" report.
    : findOrphanTestFiles({
        discovered,
        collectedByVitest,
        executedByNodeTest: [...NODE_TEST_SUITES, ...teachSuites],
        declaredNotRun,
      });
  results.push({
    label: "test-file discovery (self-detection scan)",
    ok: orphans.length === 0,
    detail: orphans.length ? `${orphans.length} orphaned file(s) -- see FAIL CLOSED block below` : `0 orphaned files (${discovered.length} discovered)`,
    skipped: 0,
  });

  const totalSkipped = results.reduce((n, r) => n + r.skipped, 0);
  const { text, failed, narrowed } = buildSummaryReport({ results, missing, skippedByEnv, vitestExtraExclude: VITEST_EXTRA_EXCLUDE, totalSkipped, orphans });
  process.stdout.write(text);

  const exitCode = computeExitCode({ failed, narrowed, narrowedAccepted: PROOF_ALL_ACCEPT_NARROWED });
  if (exitCode) process.exit(exitCode);
}

// Only run the real (slow, spawning) gate when this file is executed directly -- importing it for
// the summary-formatter unit test above must never trigger a full tsc/vitest/node:test run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
