// Discount Tire harvest: Task 8 Step 1 - pure logic for the weekly top-up job.
// No I/O, no Playwright, no network, no child_process - safe to unit test directly.
// weekly.mjs (the CLI orchestrator) imports these and does all the actual file/process work.

/**
 * Set difference: urls present in `freshUrls` (the just-rewritten state/urls.json list)
 * that are NOT marked done in ANY of the merged done maps (state/done*.json across all
 * workers, so a url any worker already harvested is never re-selected as "new").
 *
 * Preserves freshUrls' order and does not de-duplicate freshUrls itself - it is a pure
 * filter, matching selectUrls' style in lib/batch.mjs.
 *
 * @param {string[]} freshUrls - urls from the fresh discover.mjs run.
 * @param {Array<Record<string, true> | undefined | null>} doneMaps - one done map per
 *   worker/suffix (done.json, done-w0.json, done-w1.json, ...). Missing/undefined is
 *   treated as no done maps at all (every fresh url counts as new).
 * @returns {string[]}
 */
export function newUrls(freshUrls, doneMaps) {
  if (!Array.isArray(freshUrls) || freshUrls.length === 0) return [];

  const maps = Array.isArray(doneMaps) ? doneMaps : [];
  const mergedDone = new Set();
  for (const map of maps) {
    if (!map) continue;
    for (const [url, value] of Object.entries(map)) {
      if (value) mergedDone.add(url);
    }
  }

  return freshUrls.filter((url) => !mergedDone.has(url));
}

function pct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Parse apply.mjs's printed stdout report into { added, skipped, spotCheck } so weekly.mjs
 * reports REAL apply numbers rather than re-deriving them from batch telemetry. apply.mjs
 * has no machine-readable output file (out of scope to add one here - see task brief), so
 * this parses its stable, existing log lines:
 *   "  Added:   <n>"
 *   "  Skipped: <n>"
 *   "[dt-harvest apply] Spot-check summary: <passed> PASS, <failed> FAIL"
 * Returns null fields for anything not found (e.g. spot-check line absent when there was
 * nothing to spot-check) rather than guessing. Never throws on unexpected output.
 *
 * @param {string} stdout
 * @returns {{ added: number|null, skipped: number|null, spotCheck: {passed:number, failed:number}|null }}
 */
export function parseApplyOutput(stdout) {
  const text = typeof stdout === "string" ? stdout : "";

  const addedMatch = text.match(/^\s*Added:\s*(\d+)/m);
  const skippedMatch = text.match(/^\s*Skipped:\s*(\d+)/m);
  const spotCheckMatch = text.match(/Spot-check summary:\s*(\d+)\s*PASS,\s*(\d+)\s*FAIL/);

  return {
    added: addedMatch ? Number(addedMatch[1]) : null,
    skipped: skippedMatch ? Number(skippedMatch[1]) : null,
    spotCheck: spotCheckMatch ? { passed: Number(spotCheckMatch[1]), failed: Number(spotCheckMatch[2]) } : null,
  };
}

/**
 * Build the weekly top-up markdown report + anomalies flag.
 *
 * Anomalies section is non-empty (anomalies: true) when ANY of:
 *   - batch.blockRate > 0.05 (5%)
 *   - error rate (batch.error / (ok+blocked+error)) > 0.10 (10%)
 *   - applyResult.spotCheck.failed > 0
 *   - hardStopFired is true
 *   - batchFailed is true (run-batch.mjs exited non-zero - this must never read as a
 *     clean "0 new rows" run just because there is no fresh telemetry to report)
 *   - applyResult.unparsed is true (apply.mjs exited 0 but its stdout could not be
 *     parsed - this must never be coerced into fake "added: 0" zeros)
 *
 * `batch` and `applyResult` may be null (zero-new-urls run: nothing was fetched or
 * applied) - this never throws and never counts as an anomaly on its own.
 *
 * @param {object} inputs
 * @param {string} inputs.date - YYYY-MM-DD, used in the report header.
 * @param {number} inputs.newUrlCount - count of new urls found by newUrls().
 * @param {{ok:number, blocked:number, error:number, rows:number, guardRejected:number, blockRate:number} | null} inputs.batch
 * @param {boolean} inputs.applyRan - whether apply.mjs was actually run.
 * @param {{added:number|null, skipped:number|null, spotCheck:{passed:number, failed:number}|null, unparsed?:boolean} | null} inputs.applyResult
 * @param {boolean} inputs.hardStopFired - whether run-batch.mjs's block-rate hard stop fired.
 * @param {boolean} [inputs.batchFailed] - whether run-batch.mjs exited non-zero this run.
 * @returns {{ markdown: string, anomalies: boolean }}
 */
export function buildWeeklyReport(inputs) {
  const {
    date,
    newUrlCount = 0,
    batch = null,
    applyRan = false,
    applyResult = null,
    hardStopFired = false,
    batchFailed = false,
  } = inputs || {};

  const anomalyNotes = [];

  const pagesProcessed = batch ? batch.ok + batch.blocked + batch.error : 0;
  const errorRate = batch && pagesProcessed > 0 ? batch.error / pagesProcessed : 0;
  const blockRate = batch ? batch.blockRate : 0;

  if (batch && blockRate > 0.05) {
    anomalyNotes.push(`Block rate ${pct(blockRate)} exceeded the 5% weekly-report threshold.`);
  }
  if (batch && errorRate > 0.1) {
    anomalyNotes.push(`Error rate ${pct(errorRate)} (${batch.error}/${pagesProcessed} pages) exceeded the 10% weekly-report threshold.`);
  }
  if (applyResult && applyResult.spotCheck && applyResult.spotCheck.failed > 0) {
    anomalyNotes.push(`Apply spot-check failed: ${applyResult.spotCheck.failed} of ${applyResult.spotCheck.passed + applyResult.spotCheck.failed} sampled barcodes did not round-trip.`);
  }
  if (hardStopFired) {
    anomalyNotes.push("The block-rate hard stop fired during this run's batch - crawl stopped early, see the stop-report for details.");
  }
  if (batchFailed) {
    anomalyNotes.push("run-batch.mjs exited non-zero this run - treat any 'rows/pages' numbers below as incomplete or stale, not a clean 0-new-rows run.");
  }
  if (applyResult && applyResult.unparsed) {
    anomalyNotes.push("apply.mjs exited 0 but its stdout could not be parsed (wording drift?) - added/skipped/spot-check counts below are unparsed, not verified zeros.");
  }

  const anomalies = anomalyNotes.length > 0;

  const lines = [];
  lines.push(`# Weekly Discount Tire top-up report - ${date}`);
  lines.push("");
  lines.push("## Discover");
  lines.push(`- New urls found (not in any worker's done set): ${newUrlCount}`);
  lines.push("");
  lines.push("## Batch");
  if (batch) {
    lines.push(`- Pages fetched: ${pagesProcessed}`);
    lines.push(`- ok: ${batch.ok}`);
    lines.push(`- blocked: ${batch.blocked}`);
    lines.push(`- error: ${batch.error}`);
    lines.push(`- rows produced: ${batch.rows}`);
    lines.push(`- guard rejected: ${batch.guardRejected}`);
    lines.push(`- block rate: ${pct(blockRate)}`);
    lines.push(`- error rate: ${pct(errorRate)}`);
  } else {
    lines.push("- Skipped: 0 new urls, nothing to fetch this run.");
  }
  lines.push("");
  lines.push("## Apply");
  if (applyRan && applyResult) {
    lines.push(`- Rows added: ${applyResult.unparsed ? "unparsed" : applyResult.added}`);
    lines.push(`- Rows skipped: ${applyResult.unparsed ? "unparsed" : applyResult.skipped}`);
    if (applyResult.spotCheck) {
      lines.push(`- Spot-check: ${applyResult.spotCheck.passed} passed, ${applyResult.spotCheck.failed} failed`);
    } else if (applyResult.unparsed) {
      lines.push("- Spot-check: unparsed (apply.mjs output could not be parsed)");
    }
  } else {
    lines.push("- Skipped: the batch produced no new rows (or there were no new urls), so apply.mjs was not run.");
  }
  lines.push("");
  lines.push("## Anomalies");
  if (anomalies) {
    for (const note of anomalyNotes) lines.push(`- ${note}`);
  } else {
    lines.push("- None.");
  }
  lines.push("");

  return { markdown: lines.join("\n"), anomalies };
}
