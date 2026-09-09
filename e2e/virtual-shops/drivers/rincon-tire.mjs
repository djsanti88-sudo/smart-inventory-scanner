// e2e/virtual-shops/drivers/rincon-tire.mjs
//
// Virtual shop (a): Rincon Tire - disciplined tire shop, realistic scale.
// See shops.config.mjs; retired design history is summarized in docs/HISTORY.md.
//
// Daily loop: a morning stock count of "yesterday's deliveries" (a batch of
// known tire barcodes), a couple of genuinely unknown codes routed to Needs
// Review, and an end-of-day export used as a variance check. Repeats for
// `--days` simulated days. Every single scan is asserted against the
// TOP-LEVEL LAW (scan N = count N) via _shared.assertLawHolds.
//
// Mock-only, localhost:3500-only (see _shared.mjs validateLocalTarget). This
// driver does NOT spawn a dev server itself - point --target at an already
// running mock-backend server on port 3500 (future `npm run virtual-shops --
// --shop rincon-tire`, per the design doc's launch model; not built yet).
//
// This round is static + syntax verification only per the wave-2 B3 brief:
// this file is new, syntax-checked with `node --check`, and not executed
// against a live dev server.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  DEFAULT_TARGET,
  NO_AI_STATUS,
  FrictionLogger,
  assertLawHolds,
  artifactPath,
  ensureDir,
  installMockAiRoute,
  loginAndReachScan,
  readScanState,
  scanCode,
  sumCsvQuantities,
  takeScreenshot,
  loadFixtureWithFallback,
  validateLocalTarget,
  writeShopReport,
} from "./_shared.mjs";

const SHOP_KEY = "rincon-tire";
const DEFAULT_FIXTURE = resolve(process.cwd(), "e2e/virtual-shops/fixtures/rincon-tire.json");
const DEFAULT_REPORT_DIR = resolve(process.cwd(), `reports/virtual-shops/${SHOP_KEY}`);

// Standalone fallback used only when the wave-2 fixture generator (task 3 in
// the design doc, owned by a sibling agent) has not produced
// e2e/virtual-shops/fixtures/rincon-tire.json yet. Small, deliberately
// includes a same-model/different-size pair (the two 049000... placeholders
// below are NOT real tire GTINs - swap for the real ~800-row corpus pull
// once the fixture exists) so the identityMerge assertion has something to
// exercise even in fallback mode.
const FALLBACK_FIXTURE = {
  known: [
    { code: "848983012906", label: "known tire 1" },
    { code: "885911484047", label: "known tire 2" },
    { code: "049000028904", label: "same-model size A (fallback placeholder)" },
    { code: "049000028911", label: "same-model size B (fallback placeholder)" },
  ],
  unknown: ["RINCONUNKNOWN001", "RINCONUNKNOWN002"],
};

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    fixture: DEFAULT_FIXTURE,
    reportDir: DEFAULT_REPORT_DIR,
    days: 2,
    scansPerDay: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--report-dir") options.reportDir = argv[++index];
    else if (argument === "--days") options.days = Number(argv[++index]);
    else if (argument === "--scans-per-day") options.scansPerDay = Number(argv[++index]);
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/virtual-shops/drivers/rincon-tire.mjs [--target http://localhost:3500] " +
          "[--fixture path.json] [--report-dir dir] [--days N] [--scans-per-day N]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1) throw new Error("--days must be a positive integer");
  if (!Number.isInteger(options.scansPerDay) || options.scansPerDay < 1) {
    throw new Error("--scans-per-day must be a positive integer");
  }
  return options;
}

async function runDay({ page, dayIndex, known, unknown, scansPerDay, friction, screenshotsDir, runningTotal, resolvedUnknownCodes }) {
  const dayCodes = [];
  for (let index = 0; index < scansPerDay; index += 1) dayCodes.push(known[index % known.length].code);
  // A couple of genuinely unknown codes route to Needs Review each day, same as the design doc's daily
  // loop. Rotate through the fixture's unknown pool per day (never re-serve the same 2 codes) so each
  // day's Ignore resolution actually opens a FRESH review row: once a code is resolved (even via
  // "Ignore"), resolveUnknown's open/suggested-only guard (scanStore.ts) means re-scanning that same
  // code never reopens a new review - it just increments the existing placeholder's count, by design
  // (never spam Needs Review for a code a human already dismissed). Reusing day 1's codes on day 2
  // would make the review-resolution step fail every time through no fault of the app.
  const perDay = Math.min(2, unknown.length);
  const startIndex = ((dayIndex - 1) * perDay) % unknown.length;
  const dailyUnknown = unknown.length <= perDay
    ? unknown.slice(0, perDay)
    : Array.from({ length: perDay }, (_, offset) => unknown[(startIndex + offset) % unknown.length]);

  let activationMs = null;
  const dayStarted = performance.now();

  for (const code of dayCodes) {
    await scanCode(page, code);
    runningTotal.value += 1;
    const state = await readScanState(page);
    assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} known scan ${code}`);
    if (activationMs === null) activationMs = performance.now() - dayStarted;
  }

  for (const code of dailyUnknown) {
    await scanCode(page, code);
    runningTotal.value += 1;
    const state = await readScanState(page);
    assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} unknown scan ${code}`);
  }

  const elapsedMinutes = (performance.now() - dayStarted) / 60_000;
  const scansPerMinute = elapsedMinutes > 0 ? (dayCodes.length + dailyUnknown.length) / elapsedMinutes : null;

  // Resolve the day's unknowns into Needs Review once (per the design doc's "resolved once" step) so
  // tomorrow's session does not accumulate a growing backlog of the same fixture codes.
  for (const code of dailyUnknown) {
    await page.goto(new URL("/review", page.url()).toString(), { waitUntil: "domcontentloaded" });
    const row = page.getByTestId(`review-row-${code}`);
    // The review page hydrates (React mount + Zustand rehydrate) after "domcontentloaded" fires, so a
    // one-shot isVisible() right after goto races the render and false-negatives. waitFor with a real
    // timeout lets Playwright poll instead of sampling a single frame.
    const visible = await row
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) {
      // A code already resolved on an earlier day never reopens a fresh review row (scanStore.ts
      // resolveUnknown only acts on status "open"/"suggested"; a re-scan of an already-resolved code
      // just increments the existing placeholder's count). That is expected app behavior, not friction -
      // only flag it when this code has NOT been resolved before (the fixture rotation above should make
      // this rare; the fallback fixture's 2-code pool can still exhaust and hit it).
      if (resolvedUnknownCodes.has(code)) continue;
      await friction.log({
        dayIndex,
        phase: "needs-review-resolution",
        severity: "moderate",
        description: `Expected Needs Review row for ${code} was not visible`,
        screenshotPath: await takeScreenshot(page, screenshotsDir, `day${dayIndex}-review-missing-${code}`),
      });
      continue;
    }
    // "ignore-review" is the real control (NeedsReviewTable.tsx: resolveUnknown(review.id, "ignore", {}))
    // that resolves the row out of the open queue; "mark-item-unidentified" never existed in the app.
    await row
      .getByTestId("ignore-review")
      .click()
      .then(() => resolvedUnknownCodes.add(code))
      .catch(async () => {
        await friction.log({
          dayIndex,
          phase: "needs-review-resolution",
          severity: "minor",
          description: `Fallback resolution control not found for ${code}; left in Needs Review`,
        });
      });
  }

  await page.goto(new URL("/scan", page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });

  return { activationMs, scansPerMinute, scansToday: dayCodes.length + dailyUnknown.length };
}

async function endOfDayVariance({ page, dayIndex, friction, screenshotsDir, runDir, expectedTotal }) {
  const trigger = page.getByTestId("export-menu-trigger");
  if (!(await trigger.isVisible().catch(() => false))) {
    await friction.log({
      dayIndex,
      phase: "end-of-day-variance",
      severity: "moderate",
      description: "Export menu trigger not visible; could not produce end-of-day variance export",
    });
    return { exported: null, matchesExpected: false };
  }
  await trigger.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-final-counts").click();
  const download = await downloadPromise;
  const csvPath = resolve(runDir, `day${dayIndex}-final-counts.csv`);
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  const exported = sumCsvQuantities(csv);
  const matchesExpected = exported === expectedTotal;
  if (!matchesExpected) {
    await friction.log({
      dayIndex,
      phase: "end-of-day-variance",
      severity: "blocking",
      description: `Exported variance total ${exported} does not match expected ${expectedTotal}`,
      screenshotPath: await takeScreenshot(page, screenshotsDir, `day${dayIndex}-variance-mismatch`),
    });
  }
  return { exported, matchesExpected };
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
  const known = Array.isArray(fixtureResult.data.known) ? fixtureResult.data.known : FALLBACK_FIXTURE.known;
  const unknown = Array.isArray(fixtureResult.data.unknown) ? fixtureResult.data.unknown : FALLBACK_FIXTURE.unknown;

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

  const metrics = { scansAttempted: 0, scansCounted: 0, daysSimulated: 0, activationMsFirstDay: null, scansPerMinuteByDay: [] };
  const runningTotal = { value: 0 };
  const resolvedUnknownCodes = new Set();
  const failures = [];

  try {
    await loginAndReachScan(page, target);
    // Confirm the mock status is what we expect before trusting anything downstream.
    const statusResponse = await page.evaluate(async () => fetch("/api/ai-lookup").then((response) => response.json()));
    if (statusResponse.mode !== NO_AI_STATUS.mode) {
      throw new Error(`Expected mock AI status mode "${NO_AI_STATUS.mode}", got "${statusResponse.mode}"`);
    }

    for (let dayIndex = 1; dayIndex <= options.days; dayIndex += 1) {
      try {
        const dayResult = await runDay({
          page,
          dayIndex,
          known,
          unknown,
          scansPerDay: options.scansPerDay,
          friction,
          screenshotsDir,
          runningTotal,
          resolvedUnknownCodes,
        });
        metrics.scansAttempted += dayResult.scansToday;
        metrics.scansCounted = runningTotal.value;
        metrics.daysSimulated += 1;
        metrics.scansPerMinuteByDay.push(dayResult.scansPerMinute);
        if (dayIndex === 1) metrics.activationMsFirstDay = dayResult.activationMs;

        const variance = await endOfDayVariance({
          page,
          dayIndex,
          friction,
          screenshotsDir,
          runDir,
          expectedTotal: runningTotal.value,
        });
        if (dayIndex === options.days) metrics.finalVariance = variance;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`day ${dayIndex}: ${message}`);
        await friction.log({ dayIndex, phase: "daily-loop", severity: "blocking", description: message });
      }
    }
  } finally {
    const metricResults = {
      "zero lost or duplicated counts": {
        pass: metrics.scansAttempted === metrics.scansCounted,
        detail: `attempted ${metrics.scansAttempted}, counted ${metrics.scansCounted}`,
      },
      "activation time recorded": {
        pass: typeof metrics.activationMsFirstDay === "number",
        detail: `${metrics.activationMsFirstDay ?? "not recorded"} ms to first counted scan`,
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
