#!/usr/bin/env node
// Discount Tire harvest: Task 8 Step 1 - weekly top-up job.
//
// Runner: a LOWER-TIER (haiku) scheduled agent whose only jobs are: run this script,
// read state/weekly-report-<date>.md, write the summary, flag anomalies. It has no
// authority to change caps, hosts, or guards - none of that is exposed as a CLI flag
// here on purpose.
//
// Flow (Task 8 Step 1, verbatim from the plan):
//   discover (new urls only) -> batch (cap 500 pages, state-suffix=weekly,
//   done-weekly.json pre-seeded from the union of all existing done*.json) -> apply
//   (only if the batch produced >= 1 new row) -> a short report file.
//
// Usage:
//   node scripts/dt-harvest/weekly.mjs
//
// Hard safety (never overridable by a flag on this script):
//   - discover.mjs / run-batch.mjs / apply.mjs are invoked exactly as documented - no
//     flag here can raise run-batch.mjs's block-rate stop, widen the host allowlist, or
//     raise the 500-page cap.
//   - --limit is hardcoded to 500. --state-suffix is hardcoded to "weekly".
//
// Exit code: 0 on success (even with 0 new urls); non-zero when the report's Anomalies
// section is non-empty, so a dumb (haiku-tier) runner can alert on exit code alone.
//
// IMPORTANT (owner note, 2026-07-08): a 4-worker backfill fleet (state suffixes w0-w3)
// is running live in this checkout while this script is authored. This script is NOT
// run live as part of building it - only unit tests (lib/weekly.test.mjs) prove the
// pure logic. The orchestrator below is static-built and reviewed, not executed here.
//
// apply.mjs has no machine-readable summary output (only console.log). Rather than
// modifying apply.mjs (out of scope for this task) or guessing its added/skipped/
// spot-check numbers from batch telemetry, this script captures apply.mjs's real stdout
// and parses the printed report lines via lib/weekly.mjs's parseApplyOutput - the
// report always reflects what apply.mjs actually did, not an estimate.

import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { newUrls, buildWeeklyReport, parseApplyOutput } from "./lib/weekly.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const URLS_FILE = path.join(STATE_DIR, "urls.json");
const DONE_WEEKLY_FILE = path.join(STATE_DIR, "done-weekly.json");
const TELEMETRY_WEEKLY_FILE = path.join(STATE_DIR, "telemetry-weekly.json");
const STOP_REPORT_WEEKLY_FILE = path.join(STATE_DIR, "stop-report-weekly.json");

const BATCH_LIMIT = 500; // hard cap, per the plan - never raised by a flag
const STATE_SUFFIX = "weekly"; // hard-scoped, never touches other workers' state

async function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
}

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Find every state/done*.json file (done.json plus any worker-suffixed done-*.json).
 * Intentionally includes this job's own done-weekly.json from a prior run (if present) -
 * a url this weekly job already harvested last time must count as done this time too,
 * same as any other worker's done map.
 */
async function findAllDoneFiles() {
  if (!existsSync(STATE_DIR)) return [];
  const entries = await readdir(STATE_DIR);
  return entries
    .filter((f) => /^done(-.+)?\.json$/.test(f))
    .sort()
    .map((f) => path.join(STATE_DIR, f));
}

/** Run a child node script to completion, streaming its stdout/stderr through the parent's. */
function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * Run a child node script, ALSO capturing its stdout text (still streamed live to this
 * process's stdout so a human/haiku watching the run sees the same output as always).
 * Used only for apply.mjs, whose real added/skipped/spot-check numbers live in its
 * printed report (no machine-readable output file - see lib/weekly.mjs's
 * parseApplyOutput doc comment).
 */
function runNodeScriptCapture(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["inherit", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout }));
  });
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const runDate = todayStamp();

  // --- Step 1: discover (rewrites state/urls.json) ---
  console.log("[weekly] Step 1/4: discover.mjs (fresh urls.json)");
  const discoverExit = await runNodeScript(path.join(__dirname, "discover.mjs"), []);
  if (discoverExit !== 0) {
    console.error(`[weekly] discover.mjs exited ${discoverExit} - aborting weekly run.`);
    process.exitCode = 1;
    return;
  }

  const urlsState = await readJsonSafe(URLS_FILE, { urls: [] });
  const freshUrls = Array.isArray(urlsState.urls) ? urlsState.urls : [];

  const doneFiles = await findAllDoneFiles();
  const doneMaps = await Promise.all(doneFiles.map((f) => readJsonSafe(f, {})));
  const freshNewUrls = newUrls(freshUrls, doneMaps);
  console.log(`[weekly] New urls found (fresh urls.json minus the union of ${doneFiles.length} done*.json file(s)): ${freshNewUrls.length}`);

  let batchTelemetry = null;
  let hardStopFired = false;
  let batchFailed = false;
  let applyRan = false;
  let applyResult = null;

  if (freshNewUrls.length > 0) {
    // --- Step 2: batch, capped at 500 pages, isolated state-suffix=weekly ---
    // Pre-seed done-weekly.json with the union of every existing worker's done map so
    // already-harvested pages (by any worker) are never refetched by the weekly job.
    const preSeeded = {};
    for (const map of doneMaps) {
      for (const [url, value] of Object.entries(map || {})) {
        if (value) preSeeded[url] = true;
      }
    }
    await writeJsonAtomic(DONE_WEEKLY_FILE, preSeeded);
    console.log(`[weekly] Pre-seeded ${DONE_WEEKLY_FILE} with ${Object.keys(preSeeded).length} already-done url(s) merged from ${doneFiles.length} done*.json file(s).`);

    console.log(`[weekly] Step 2/4: run-batch.mjs --limit=${BATCH_LIMIT} --state-suffix=${STATE_SUFFIX}`);
    const batchExit = await runNodeScript(path.join(__dirname, "run-batch.mjs"), [
      `--limit=${BATCH_LIMIT}`,
      `--state-suffix=${STATE_SUFFIX}`,
    ]);
    if (batchExit !== 0) {
      console.error(`[weekly] run-batch.mjs exited ${batchExit} - continuing to report, but flagging as an anomaly.`);
      batchFailed = true;
    }

    batchTelemetry = await readJsonSafe(TELEMETRY_WEEKLY_FILE, null);
    hardStopFired = existsSync(STOP_REPORT_WEEKLY_FILE);
  } else {
    console.log("[weekly] Step 2/4: skipped (0 new urls).");
  }

  // --- Step 3: apply, only if the batch produced >= 1 new row ---
  if (batchTelemetry && batchTelemetry.rows >= 1) {
    console.log("[weekly] Step 3/4: apply.mjs (batch produced new rows)");
    const { code: applyExit, stdout: applyStdout } = await runNodeScriptCapture(path.join(__dirname, "apply.mjs"), []);
    applyRan = true;
    const parsed = parseApplyOutput(applyStdout);
    if (applyExit !== 0) {
      console.error(`[weekly] apply.mjs exited ${applyExit} - treating as a failed spot-check anomaly.`);
      applyResult = {
        added: parsed.added ?? 0,
        skipped: parsed.skipped ?? 0,
        spotCheck: parsed.spotCheck ?? { passed: 0, failed: 1 },
      };
    } else if (parsed.added === null && parsed.skipped === null && parsed.spotCheck === null) {
      // apply.mjs exited 0 (it believes it succeeded) but its stdout did not match any
      // of the expected report lines. Coercing this into added:0/skipped:0 would read as
      // "apply ran and added nothing" when the truth is "we don't know what apply did" -
      // flag it as its own anomaly instead of guessing zeros (review finding, IMPORTANT).
      console.error("[weekly] apply.mjs exited 0 but its stdout could not be parsed - flagging as an anomaly (wording drift?).");
      applyResult = { added: null, skipped: null, spotCheck: null, unparsed: true };
    } else {
      applyResult = {
        added: parsed.added ?? 0,
        skipped: parsed.skipped ?? 0,
        spotCheck: parsed.spotCheck ?? { passed: 0, failed: 0 },
      };
    }
  } else {
    console.log("[weekly] Step 3/4: skipped (batch produced 0 new rows, or there was nothing to batch).");
  }

  // --- Step 4: report ---
  console.log("[weekly] Step 4/4: writing report");
  const { markdown, anomalies } = buildWeeklyReport({
    date: runDate,
    newUrlCount: freshNewUrls.length,
    batch: batchTelemetry,
    applyRan,
    applyResult,
    hardStopFired,
    batchFailed,
  });

  const reportFile = path.join(STATE_DIR, `weekly-report-${runDate}.md`);
  await writeFile(reportFile, markdown, "utf8");
  console.log(`[weekly] Wrote ${reportFile}`);

  if (anomalies) {
    console.error("[weekly] Anomalies detected - see the report's Anomalies section.");
    process.exitCode = 1;
  } else {
    console.log("[weekly] No anomalies. Done.");
  }
}

main().catch((err) => {
  console.error("weekly.mjs failed:", err);
  process.exitCode = 1;
});
