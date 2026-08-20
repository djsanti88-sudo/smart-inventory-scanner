import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markCalibration, waitForAllCalibrated, waitForCalibrationTurn } from "./calibration-barrier.mjs";

test("calibration barrier admits groups of four and releases the exhaustive burst at twenty", async () => {
  const prior = process.cwd(); const cwd = mkdtempSync(join(tmpdir(), "boss-calibration-"));
  try {
    process.chdir(cwd); const runId = "boss-preview-20260804-calibration-001";
    await waitForCalibrationTurn(runId, 0);
    for (let lane = 0; lane < 4; lane++) markCalibration(runId, lane, "ready");
    await waitForCalibrationTurn(runId, 4);
    for (let lane = 4; lane < 20; lane++) markCalibration(runId, lane, "ready");
    await assert.doesNotReject(waitForAllCalibrated(runId));
  } finally { process.chdir(prior); rmSync(cwd, { recursive: true, force: true }); }
});
