// e2e/virtual-shops/drivers/quickfix-auto.mjs
//
// Virtual shop (b): QuickFix Auto - small repair shop, sloppy scanner
// habits. See docs/superpowers/specs/2026-07-29-virtual-shops-design.md
// section (b).
//
// Same daily-loop skeleton as rincon-tire.mjs, but every scan runs through
// an error-injection plan: typos (dropped-digit / extra-digit), deliberate
// back-to-back double-scans, and mid-scan focus loss (reload or navigate
// away with a partial buffer, then resume). The whole point of this shop is
// proving errors change IDENTITY, never COUNT: every injected scan must
// still appear in the feed and be counted per the TOP-LEVEL LAW (CLAUDE.md),
// asserted after every single scan via _shared.assertLawHolds exactly like
// rincon-tire.mjs.
//
// Error-injection plan: `buildDayPlan()` below is a verbatim port of
// fixtures/generate-fixtures.mjs's buildQuickFixAuto() day-plan algorithm
// (same seeded PRNG - _shared.createSeededRandom is the identical mulberry32
// - same per-item roll order, same dropped/extra-digit typo construction).
// Given the SAME seed (default 20260729, matching the committed fixture's
// base seed) and the SAME rates (0.08 typo / 0.1 double-scan / 0.03
// interrupt, also the committed defaults), this driver's runtime-computed
// plan for day N is byte-for-byte identical to day N in
// fixtures/quickfix-auto-error-injection.json - the "reference table" the
// design doc calls for. When that fixture file is present and its rates/
// seed/item-count match the current run, the driver additionally
// cross-checks the computed plan against it and logs friction if they ever
// diverge (a regression guard on this port).
//
// Mock-only, localhost:3500-only (see _shared.mjs validateLocalTarget). Does
// not spawn its own dev server - point --target at an already-running mock
// backend, same contract as rincon-tire.mjs.
//
// Syntax-checked with `node --check`; not executed against a live dev server
// as part of this fix (see e2e/virtual-shops/README.md verification notes).

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
  takeScreenshot,
  typePartialCode,
  loadFixtureWithFallback,
  validateLocalTarget,
  writeShopReport,
} from "./_shared.mjs";

const SHOP_KEY = "quickfix-auto";
const DEFAULT_FIXTURE = resolve(process.cwd(), "e2e/virtual-shops/fixtures/quickfix-auto.json");
const DEFAULT_ERROR_FIXTURE = resolve(
  process.cwd(),
  "e2e/virtual-shops/fixtures/quickfix-auto-error-injection.json",
);
const DEFAULT_REPORT_DIR = resolve(process.cwd(), `reports/virtual-shops/${SHOP_KEY}`);

// Standalone fallback used only when the fixture generator has not produced
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

// Same base seed and rates as fixtures/generate-fixtures.mjs's
// QUICKFIX_SEED / TYPO_RATE / DOUBLE_SCAN_RATE / INTERRUPT_RATE, so a
// default run reproduces the committed reference table exactly.
const DEFAULT_ERROR_CONFIG = {
  typoRate: 0.08,
  doubleScanRate: 0.1,
  interruptRate: 0.03,
};

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    fixture: DEFAULT_FIXTURE,
    errorFixture: DEFAULT_ERROR_FIXTURE,
    reportDir: DEFAULT_REPORT_DIR,
    days: 2,
    scansPerDay: null,
    seed: 20260729,
    ...DEFAULT_ERROR_CONFIG,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--error-fixture") options.errorFixture = argv[++index];
    else if (argument === "--report-dir") options.reportDir = argv[++index];
    else if (argument === "--days") options.days = Number(argv[++index]);
    else if (argument === "--scans-per-day") options.scansPerDay = Number(argv[++index]);
    else if (argument === "--seed") options.seed = Number(argv[++index]);
    else if (argument === "--typo-rate") options.typoRate = Number(argv[++index]);
    else if (argument === "--double-scan-rate") options.doubleScanRate = Number(argv[++index]);
    else if (argument === "--interrupt-rate") options.interruptRate = Number(argv[++index]);
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/virtual-shops/drivers/quickfix-auto.mjs [--target http://localhost:3500] " +
          "[--fixture path.json] [--error-fixture path.json] [--report-dir dir] [--days N] " +
          "[--scans-per-day N] [--seed N] [--typo-rate 0-1] [--double-scan-rate 0-1] [--interrupt-rate 0-1]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1) throw new Error("--days must be a positive integer");
  if (options.scansPerDay !== null && (!Number.isInteger(options.scansPerDay) || options.scansPerDay < 1)) {
    throw new Error("--scans-per-day must be a positive integer");
  }
  for (const key of ["typoRate", "doubleScanRate", "interruptRate"]) {
    if (!(options[key] >= 0 && options[key] <= 1)) throw new Error(`--${key} must be between 0 and 1`);
  }
  return options;
}

/**
 * Verbatim port of fixtures/generate-fixtures.mjs's injectTypo(): same two
 * position draws off the SAME rng stream, same dropped/extra-digit shape.
 */
function injectTypoVariant(code, positionRng) {
  const digits = code.split("");
  const dropPosition = 2 + Math.floor(positionRng() * (digits.length - 4));
  const dropped = digits.slice(0, dropPosition).concat(digits.slice(dropPosition + 1)).join("");
  const dupPosition = 2 + Math.floor(positionRng() * (digits.length - 4));
  const duplicated = digits.slice(0, dupPosition).concat([digits[dupPosition]], digits.slice(dupPosition)).join("");
  return { droppedDigit: dropped, extraDigit: duplicated };
}

/**
 * Verbatim port of fixtures/generate-fixtures.mjs's buildQuickFixAuto() day
 * plan loop: one roll per item, fixed threshold order (typo, double-scan,
 * interrupt, else clean). Given the same seed + rates as the committed
 * fixture, this reproduces fixtures/quickfix-auto-error-injection.json's
 * per-day arrays exactly.
 */
function buildDayPlan(items, dayIndex, baseSeed, rates) {
  const seed = baseSeed + dayIndex * 97;
  const dayRng = createSeededRandom(seed);
  const typoInjections = [];
  const doubleScans = [];
  const interrupts = [];
  items.forEach((item, itemIndex) => {
    const roll = dayRng();
    if (roll < rates.typoRate) {
      const variant = injectTypoVariant(item.code, dayRng);
      typoInjections.push({
        itemIndex,
        code: item.code,
        typoType: dayRng() < 0.5 ? "dropped-digit" : "extra-digit",
        typoCode: dayRng() < 0.5 ? variant.droppedDigit : variant.extraDigit,
      });
    } else if (roll < rates.typoRate + rates.doubleScanRate) {
      doubleScans.push({ itemIndex, code: item.code });
    } else if (roll < rates.typoRate + rates.doubleScanRate + rates.interruptRate) {
      interrupts.push({
        afterItemIndex: itemIndex,
        code: item.code,
        action: dayRng() < 0.5 ? "reload" : "navigate-away",
        resumeDelayMs: 200 + Math.floor(dayRng() * 800),
      });
    }
  });
  return { dayIndex, seed, typoInjections, doubleScans, interrupts };
}

function planLookup(dayPlan) {
  const byIndex = new Map();
  for (const entry of dayPlan.typoInjections) byIndex.set(entry.itemIndex, { kind: "typo", typoCode: entry.typoCode });
  for (const entry of dayPlan.doubleScans) byIndex.set(entry.itemIndex, { kind: "double-scan" });
  for (const entry of dayPlan.interrupts) {
    byIndex.set(entry.afterItemIndex, { kind: "interrupt", action: entry.action, resumeDelayMs: entry.resumeDelayMs });
  }
  return byIndex;
}

/** True when every itemIndex/code/typoCode/action in `computed` matches `reference` exactly. */
function plansMatch(computed, reference) {
  if (!reference) return false;
  const sameList = (a, b, keys) =>
    a.length === b.length && a.every((entry, i) => keys.every((key) => entry[key] === b[i]?.[key]));
  return (
    sameList(computed.typoInjections, reference.typoInjections, ["itemIndex", "code", "typoType", "typoCode"]) &&
    sameList(computed.doubleScans, reference.doubleScans, ["itemIndex", "code"]) &&
    sameList(computed.interrupts, reference.interrupts, ["afterItemIndex", "code", "action", "resumeDelayMs"])
  );
}

async function scanClean(page, code, runningTotal, dayIndex) {
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} clean scan ${code}`);
}

async function scanTypo(page, code, typoCode, runningTotal, dayIndex, friction) {
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

async function scanInterrupted(page, code, action, resumeDelayMs, runningTotal, dayIndex, friction, screenshotsDir, target) {
  // Type half the code, then lose focus (reload or navigate away) mid-buffer
  // - the buffer must not leak into the next scan.
  const partial = code.slice(0, Math.max(1, Math.floor(code.length / 2)));
  await typePartialCode(page, partial);
  // Neutralize the race between the ScannerInput debounce fallback (80ms) and
  // Playwright's own navigation-initiation latency: an independent JS
  // round trip (e.g. page.evaluate to blank the value) can itself take
  // longer than 80ms under load, so it can still lose the race against the
  // timer armed by the LAST keystroke of typePartialCode above. Clearing via
  // real Backspace keystrokes instead keeps the clear on the SAME event
  // pipeline as the typing that armed the timer: each Backspace re-arms
  // ScannerInput's debounce for another 80ms (handleKeyDown's non-Enter
  // branch), so by the time this loop returns, the DOM value is guaranteed
  // "" and any debounce that later fires mid-navigation hits submit()'s own
  // `raw.trim().length === 0` guard and no-ops - deterministic regardless of
  // CDP/system timing, no reliance on out-running a timer via a separate
  // async call.
  const interruptInput = page.getByTestId("scanner-input");
  for (let index = 0; index < partial.length; index += 1) await interruptInput.press("Backspace");
  if (action === "navigate-away") {
    await page.goto(`${target}/products`, { waitUntil: "domcontentloaded" });
    await delay(resumeDelayMs);
    await page.goto(`${target}/scan`, { waitUntil: "domcontentloaded" });
  } else {
    // Reload immediately, before the ScannerInput debounce fallback
    // (debounceMs=80) can auto-submit the pending partial buffer as its own
    // scan; delay AFTER reload to simulate recovery time, matching the
    // navigate-away branch's ordering. Waiting resumeDelayMs (200-1000ms,
    // always > 80ms) before reloading let the debounce fire first and
    // silently submit an extra scan, undercounting runningTotal below.
    await page.reload({ waitUntil: "domcontentloaded" });
    await delay(resumeDelayMs);
  }
  await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
  // Wait for React hydration (window.__scanStore existing), same guard
  // loginAndReachScan uses on first load. The scanner-input DOM node can be
  // present (server-rendered) before React has attached its onKeyDown
  // handler, especially once scanFeed/localStorage has grown large by later
  // simulated days (more state to rehydrate on mount) - typing/Enter into an
  // unhydrated input is silently swallowed (no handler yet), losing the
  // resumed scan entirely. The "reload" branch already had an incidental
  // safety margin from its post-action `delay(resumeDelayMs)`; navigate-away
  // had no such margin after landing back on /scan, so this waits explicitly
  // instead of relying on delay placement.
  await page.waitForFunction(() => Boolean(window.__scanStore));
  await scanCode(page, code);
  runningTotal.value += 1;
  const state = await readScanState(page);
  assertLawHolds(state, runningTotal.value, `${SHOP_KEY} day ${dayIndex} interrupted scan ${code}`);
  await friction.log({
    dayIndex,
    phase: "interrupt-injection",
    severity: "minor",
    description:
      `Mid-scan interrupt (partial "${partial}" + ${action}, ${resumeDelayMs}ms) before resuming ${code}; ` +
      "buffer did not corrupt the resumed scan",
    screenshotPath: await takeScreenshot(page, screenshotsDir, `day${dayIndex}-interrupt-${code}`),
  });
}

async function runDay({ page, dayIndex, items, dayPlan, target, friction, screenshotsDir, runningTotal }) {
  const lookup = planLookup(dayPlan);
  const errorCounts = { typo: 0, "double-scan": 0, interrupt: 0, clean: 0 };
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    const planned = lookup.get(itemIndex);
    if (!planned) {
      errorCounts.clean += 1;
      await scanClean(page, item.code, runningTotal, dayIndex);
      continue;
    }
    if (planned.kind === "typo") {
      errorCounts.typo += 1;
      await scanTypo(page, item.code, planned.typoCode, runningTotal, dayIndex, friction);
    } else if (planned.kind === "double-scan") {
      errorCounts["double-scan"] += 1;
      await scanDouble(page, item.code, runningTotal, dayIndex, friction);
    } else {
      errorCounts.interrupt += 1;
      await scanInterrupted(
        page,
        item.code,
        planned.action,
        planned.resumeDelayMs,
        runningTotal,
        dayIndex,
        friction,
        screenshotsDir,
        target,
      );
    }
  }
  // double-scan issues two physical scans per item slot, so attempted differs from items.length.
  const scansAttemptedToday = items.length + errorCounts["double-scan"];
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
  const scansPerDay = options.scansPerDay ?? items.length;

  const errorRates = {
    typoRate: options.typoRate,
    doubleScanRate: options.doubleScanRate,
    interruptRate: options.interruptRate,
  };
  const errorFixtureResult = await loadFixtureWithFallback(options.errorFixture, null);
  const referenceAvailable = !errorFixtureResult.usedFallback && Array.isArray(errorFixtureResult.data?.days);
  if (!referenceAvailable) {
    await friction.log({
      dayIndex: 0,
      phase: "error-fixture-load",
      severity: "minor",
      description:
        `Error-injection reference table not found at ${artifactPath(options.errorFixture)}` +
        (errorFixtureResult.reason ? ` (${errorFixtureResult.reason})` : "") +
        "; computing the day plan at runtime via the same seeded algorithm instead",
    });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await installMockAiRoute(context);
  page.on("pageerror", (error) => {
    friction
      .log({
        dayIndex: -1,
        phase: "runtime",
        severity: "moderate",
        description: `page error: ${error.message}`,
      })
      .catch(() => {});
  });

  const metrics = {
    scansAttempted: 0,
    scansCounted: 0,
    daysSimulated: 0,
    errorCountsByDay: [],
    seed: options.seed,
    referenceTableSource: referenceAvailable ? "fixture" : "computed-fallback",
    referenceTableVerifiedDays: [],
  };
  const runningTotal = { value: 0 };
  const failures = [];

  try {
    await loginAndReachScan(page, target);

    for (let dayIndex = 1; dayIndex <= options.days; dayIndex += 1) {
      try {
        const dayItems = items.slice(0, scansPerDay);
        const computedPlan = buildDayPlan(dayItems, dayIndex, options.seed, errorRates);
        const referenceDay = referenceAvailable
          ? errorFixtureResult.data.days.find((day) => day.dayIndex === dayIndex)
          : null;
        if (referenceDay) {
          const impliedBaseSeed = referenceDay.seed - dayIndex * 97;
          const sameConfig =
            impliedBaseSeed === options.seed &&
            errorFixtureResult.data.rates?.typoRate === errorRates.typoRate &&
            errorFixtureResult.data.rates?.doubleScanRate === errorRates.doubleScanRate &&
            errorFixtureResult.data.rates?.interruptRate === errorRates.interruptRate &&
            scansPerDay === errorFixtureResult.data.itemCount;
          if (sameConfig) {
            const matches = plansMatch(computedPlan, referenceDay);
            metrics.referenceTableVerifiedDays.push({ dayIndex, matches });
            if (!matches) {
              await friction.log({
                dayIndex,
                phase: "error-fixture-verify",
                severity: "moderate",
                description: `Computed day plan diverged from the committed reference table for day ${dayIndex} at the default seed/rates`,
              });
            }
          }
        }

        const dayResult = await runDay({
          page,
          dayIndex,
          items: dayItems,
          dayPlan: computedPlan,
          target,
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
      "error-injection plan matches the committed reference table (default seed/rates)": {
        pass: metrics.referenceTableVerifiedDays.every((d) => d.matches),
        detail:
          metrics.referenceTableVerifiedDays.length > 0
            ? metrics.referenceTableVerifiedDays.map((d) => `day ${d.dayIndex}: ${d.matches ? "match" : "MISMATCH"}`).join("; ")
            : "no comparable day (reference table unavailable or non-default seed/rates/scans-per-day)",
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
