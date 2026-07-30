// e2e/virtual-shops/drivers/quickfix-auto.mjs
//
// Virtual shop (b): QuickFix Auto - small repair shop, sloppy scanner
// habits. See docs/superpowers/specs/2026-07-29-virtual-shops-design.md
// section (b).
//
// Same daily-loop skeleton as rincon-tire.mjs, but every scan optionally
// runs through an error-injection table (config knobs below): typos
// (adjacent-char swap before Enter), deliberate back-to-back double-scans,
// and mid-scan focus loss (navigate away or reload with a partial buffer,
// then resume). The whole point of this shop is proving errors change
// IDENTITY, never COUNT: every injected scan must still appear in the feed
// and be counted per the TOP-LEVEL LAW (CLAUDE.md), asserted after every
// single scan via _shared.assertLawHolds exactly like rincon-tire.mjs.
//
// Mock-only, localhost:3500-only (see _shared.mjs validateLocalTarget). Does
// not spawn its own dev server - point --target at an already-running mock
// backend, same contract as rincon-tire.mjs.
//
// This round is static + syntax verification only per the wave-2 B3 brief:
// this file is new, syntax-checked with `node --check`, and not executed
// against a live dev server.

import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  DEFAULT_TARGET,
  FrictionLogger,
  assertLawHolds,
  artifactPath,
  createSeededRandom,
  delay,
  ensureDir,
  installMockAiRoute,
  loginAndReachScan,
  readScanState,
  scanCode,
  swapAdjacentChars,
  takeScreenshot,
  typePartialCode,
  loadFixtureWithFallback,
  validateLocalTarget,
  writeShopReport,
} from "./_shared.mjs";

const SHOP_KEY = "quickfix-auto";
const DEFAULT_FIXTURE = resolve(process.cwd(), "e2e/virtual-shops/fixtures/quickfix-auto.json");
const DEFAULT_REPORT_DIR = resolve(process.cwd(), `reports/virtual-shops/${SHOP_KEY}`);

// Standalone fallback used only when the wave-2 fixture generator (design
// doc task 5, sibling agent) has not produced
// e2e/virtual-shops/fixtures/quickfix-auto.json yet. A small retail-shaped
// (non-tire) mix, matching the design doc's "oil filters, batteries, wiper
// blades, shop supplies" description.
const FALLBACK_FIXTURE = {
  items: [
    { code: "011110838828", label: "oil filter (fallback placeholder)" },
    { code: "011110838835", label: "battery (fallback placeholder)" },
    { code: "011110838842", label: "wiper blade (fallback placeholder)" },
    { code: "011110838859", label: "shop rag pack (fallback placeholder)" },
    { code: "011110838866", label: "brake cleaner (fallback placeholder)" },
  ],
};

// Error-injection knobs. Defaults are conservative so a small fallback-run
// still exercises every error class at least once; CLI flags override for
// heavier daily runs against the real ~150-item fixture.
const DEFAULT_ERROR_CONFIG = {
  typoRate: 0.15,
  doubleScanRate: 0.1,
  interruptRate: 0.05,
  pauseRate: 0.1,
  pauseMs: 250,
};

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    fixture: DEFAULT_FIXTURE,
    reportDir: DEFAULT_REPORT_DIR,
    days: 2,
    scansPerDay: 20,
    seed: 20260729,
    ...DEFAULT_ERROR_CONFIG,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--report-dir") options.reportDir = argv[++index];
    else if (argument === "--days") options.days = Number(argv[++index]);
    else if (argument === "--scans-per-day") options.scansPerDay = Number(argv[++index]);
    else if (argument === "--seed") options.seed = Number(argv[++index]);
    else if (argument === "--typo-rate") options.typoRate = Number(argv[++index]);
    else if (argument === "--double-scan-rate") options.doubleScanRate = Number(argv[++index]);
    else if (argument === "--interrupt-rate") options.interruptRate = Number(argv[++index]);
    else if (argument === "--pause-rate") options.pauseRate = Number(argv[++index]);
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/virtual-shops/drivers/quickfix-auto.mjs [--target http://localhost:3500] " +
          "[--fixture path.json] [--report-dir dir] [--days N] [--scans-per-day N] [--seed N] " +
          "[--typo-rate 0-1] [--double-scan-rate 0-1] [--interrupt-rate 0-1] [--pause-rate 0-1]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1) throw new Error("--days must be a positive integer");
  if (!Number.isInteger(options.scansPerDay) || options.scansPerDay < 1) {
    throw new Error("--scans-per-day must be a positive integer");
  }
  for (const key of ["typoRate", "doubleScanRate", "interruptRate", "pauseRate"]) {
    if (!(options[key] >= 0 && options[key] <= 1)) throw new Error(`--${key} must be between 0 and 1`);
  }
  return options;
}

/**
 * Picks exactly one error class (or "clean") for this scan slot based on the
 * seeded RNG, so injection is deterministic and reproducible across runs
 * with the same --seed. Rates are treated as independent buckets in a fixed
 * order (typo, double-scan, interrupt, pause) so they never combine on one
 * scan - keeps each injected scan's assertion unambiguous.
 */
function pickErrorClass(random, config) {
  const roll = random();
  let threshold = 0;
  threshold += config.typoRate;
  if (roll < threshold) return "typo";
  threshold += config.doubleScanRate;
  if (roll < threshold) return "double-scan";
  threshold += config.interruptRate;
  if (roll < threshold) return "interrupt";
  threshold += config.pauseRate;
  if (roll < threshold) return "pause";
  return "clean";
}

async function scanClean(page, code, runningTotal, dayIndex) {
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} clean scan ${code}`);
}

async function scanTypo(page, code, runningTotal, dayIndex, friction, screenshotsDir) {
  const typoCode = swapAdjacentChars(code, Math.max(0, code.length - 3));
  await scanCode(page, typoCode);
  runningTotal.value += 1;
  const state = await readScanState(page);
  // A typo'd code still must appear and count (TOP-LEVEL LAW): identity may
  // be unresolved (Needs Review), but the row and the count must exist.
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} typo scan ${typoCode} (from ${code})`);
  await friction.log({
    dayIndex,
    phase: "typo-injection",
    severity: "minor",
    description: `Injected typo ${code} -> ${typoCode}; scan still appeared and counted`,
  });
}

async function scanDouble(page, code, runningTotal, dayIndex, friction) {
  const before = await readScanState(page);
  const productsBefore = before?.products ?? 0;
  await scanCode(page, code);
  runningTotal.value += 1;
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} double-scan ${code}`);
  if (state.products > productsBefore + 1) {
    await friction.log({
      dayIndex,
      phase: "double-scan-injection",
      severity: "blocking",
      description: `Double-scan of ${code} created ${state.products - productsBefore} new product rows, expected at most 1`,
    });
  }
}

async function scanInterrupted(page, code, runningTotal, dayIndex, friction, screenshotsDir) {
  // Type half the code, then lose focus (reload) mid-buffer - the buffer must not leak into the next scan.
  const partial = code.slice(0, Math.max(1, Math.floor(code.length / 2)));
  await typePartialCode(page, partial);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} interrupted scan ${code}`);
  await friction.log({
    dayIndex,
    phase: "interrupt-injection",
    severity: "minor",
    description: `Mid-scan interrupt (partial "${partial}" + reload) before resuming ${code}; buffer did not corrupt the resumed scan`,
    screenshotPath: await takeScreenshot(page, screenshotsDir, `day${dayIndex}-interrupt-${code}`),
  });
}

async function scanWithPause(page, code, pauseMs, runningTotal, dayIndex, friction) {
  await delay(pauseMs);
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} paused scan ${code}`);
}

async function runDay({ page, dayIndex, items, scansPerDay, config, random, friction, screenshotsDir, runningTotal }) {
  const errorCounts = { typo: 0, "double-scan": 0, interrupt: 0, pause: 0, clean: 0 };
  for (let index = 0; index < scansPerDay; index += 1) {
    const item = items[index % items.length];
    const errorClass = pickErrorClass(random, config);
    errorCounts[errorClass] += 1;
    switch (errorClass) {
      case "typo":
        await scanTypo(page, item.code, runningTotal, dayIndex, friction, screenshotsDir);
        break;
      case "double-scan":
        await scanDouble(page, item.code, runningTotal, dayIndex, friction);
        break;
      case "interrupt":
        await scanInterrupted(page, item.code, runningTotal, dayIndex, friction, screenshotsDir);
        break;
      case "pause":
        await scanWithPause(page, item.code, config.pauseMs, runningTotal, dayIndex, friction);
        break;
      default:
        await scanClean(page, item.code, runningTotal, dayIndex);
    }
  }
  // double-scan issues two physical scans per loop iteration, so the attempted count differs from scansPerDay.
  const scansAttemptedToday =
    scansPerDay - errorCounts["double-scan"] + errorCounts["double-scan"] * 2;
  return { errorCounts, scansAttemptedToday };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = validateLocalTarget(options.target);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(options.reportDir, runId);
  const screenshotsDir = resolve(runDir, "screenshots");
  await ensureDir(runDir);
  await ensureDir(screenshotsDir);

  const friction = new FrictionLogger(SHOP_KEY, runDir);
  const fixtureResult = await loadFixtureWithFallback(options.fixture, FALLBACK_FIXTURE);
  if (fixtureResult.usedFallback) {
    await friction.log({
      dayIndex: 0,
      phase: "fixture-load",
      severity: "minor",
      description: `Fixture not found at ${artifactPath(options.fixture)} (${fixtureResult.reason}); using built-in fallback fixture`,
    });
  }
  const items = Array.isArray(fixtureResult.data.items) ? fixtureResult.data.items : FALLBACK_FIXTURE.items;
  const random = createSeededRandom(options.seed);
  const errorConfig = {
    typoRate: options.typoRate,
    doubleScanRate: options.doubleScanRate,
    interruptRate: options.interruptRate,
    pauseRate: options.pauseRate,
    pauseMs: options.pauseMs,
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await installMockAiRoute(context);
  page.on("pageerror", (error) => {
    friction.log({
      dayIndex: -1,
      phase: "runtime",
      severity: "moderate",
      description: `page error: ${error.message}`,
    }).catch(() => {});
  });

  const metrics = {
    scansAttempted: 0,
    scansCounted: 0,
    daysSimulated: 0,
    errorCountsByDay: [],
    seed: options.seed,
  };
  const runningTotal = { value: 0 };
  const failures = [];

  try {
    await loginAndReachScan(page, target);

    for (let dayIndex = 1; dayIndex <= options.days; dayIndex += 1) {
      try {
        const dayResult = await runDay({
          page,
          dayIndex,
          items,
          scansPerDay: options.scansPerDay,
          config: errorConfig,
          random,
          friction,
          screenshotsDir,
          runningTotal,
        });
        metrics.scansAttempted += dayResult.scansAttemptedToday;
        metrics.scansCounted = runningTotal.value;
        metrics.daysSimulated += 1;
        metrics.errorCountsByDay.push(dayResult.errorCounts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`day ${dayIndex}: ${message}`);
        await friction.log({ dayIndex, phase: "daily-loop", severity: "blocking", description: message });
      }
    }
  } finally {
    const metricResults = {
      "every injected scan appears and counts": {
        pass: metrics.scansAttempted === metrics.scansCounted,
        detail: `attempted ${metrics.scansAttempted}, counted ${metrics.scansCounted}`,
      },
      "no blocking friction (e.g. duplicate rows from double-scan)": {
        pass: friction.summary().blocking === 0,
        detail: `${friction.summary().blocking} blocking event(s) logged`,
      },
      "no blocking failures": {
        pass: failures.length === 0,
        detail: failures.length === 0 ? "none" : failures.join("; "),
      },
    };
    const { reportJsonPath, reportMdPath } = await writeShopReport(runDir, {
      shopKey: SHOP_KEY,
      metrics,
      metricResults,
      friction,
    });
    await context.close();
    await browser.close();
    console.log(JSON.stringify({ report: reportJsonPath, summary: reportMdPath, failures }));
    if (failures.length > 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
