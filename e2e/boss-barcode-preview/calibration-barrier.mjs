import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LANES = 20;
const CAPACITY = 4;
const RUN_ID = /^boss-preview-[a-z0-9-]{16,64}$/;
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

function barrierDir(runId) {
  if (!RUN_ID.test(runId)) throw new Error("Preview calibration barrier run id is invalid.");
  return resolve("outputs/boss-barcode-certification/preview-runs", `${runId}.calibration`);
}

function counts(runId) {
  const dir = barrierDir(runId); mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir);
  return { ready: names.filter((name) => /^lane-\d{2}\.ready$/.test(name)).length, failed: names.some((name) => /^lane-\d{2}\.failed$/.test(name)) };
}

async function waitFor(runId, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = counts(runId);
    if (state.failed) throw new Error("A Preview calibration lane failed before the exhaustive burst.");
    if (predicate(state.ready)) return;
    await pause(25);
  }
  throw new Error("Preview calibration barrier timed out.");
}

export async function waitForCalibrationTurn(runId, lane) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= LANES) throw new Error("Preview calibration lane is invalid.");
  const requiredReady = Math.floor(lane / CAPACITY) * CAPACITY;
  await waitFor(runId, (ready) => ready >= requiredReady);
}

export function markCalibration(runId, lane, status) {
  const dir = barrierDir(runId); mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `lane-${String(lane).padStart(2, "0")}.${status}`);
  try { writeFileSync(path, "", { flag: "wx" }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
}

export async function waitForAllCalibrated(runId) {
  await waitFor(runId, (ready) => ready === LANES);
}
