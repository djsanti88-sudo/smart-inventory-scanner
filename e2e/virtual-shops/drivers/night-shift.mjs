// e2e/virtual-shops/drivers/night-shift.mjs
//
// Virtual shop (d) "Night Shift" - the offline/retry resilience loop.
// Design: docs/superpowers/specs/2026-07-29-virtual-shops-design.md section (d).
//
// Flow (real UI, mock backend only), repeated per day in
// fixtures/night-shift-scan-sequence.json (checked-in, deterministic,
// phased structure - see e2e/virtual-shops/README.md):
//   1. Go offline (Playwright `context.setOffline(true)`, real network
//      blocking - the same mechanism e2e/stress-drive.mjs uses) and scan the
//      day's fixture burst plus two dedicated unknown codes (not part of the
//      fixture; added here for TOP-LEVEL LAW identity-gate coverage, same as
//      the other virtual shops). Per the TOP-LEVEL LAW every scan must still
//      appear in the feed and count immediately, even though sync is failing
//      behind the scenes.
//   2. Refresh the page mid-session, still offline, and prove the scan feed
//      survives the reload (persisted state, not just in-memory Zustand
//      state).
//   3. Reconnect and trigger a retry storm (the fixture's per-day
//      retryCount) on the pending-sync queue by clicking "Try saving again"
//      repeatedly in quick succession - idempotency must hold: retries never
//      create a second counted entry for the same scan.
//   4. Assert the day's issued scans against the fixture's
//      `expected.totalScansThisDay`, then move on to the next day in the
//      SAME browser session (a shop's data persists day to day; scanFeed and
//      finalCounts grow cumulatively).
//   5. After the last day, assert the crown invariant across three
//      independent readouts (DOM final-count table, persisted
//      Zustand/localStorage state, and an exported CSV) against the
//      cumulative total issued across every day.
//
// Falls back to a synthetic single-day plan built from
// tools/fable5/fixtures/stress-codes.json (read-only, the pre-fixture
// behavior this driver used) if fixtures/night-shift-scan-sequence.json is
// missing or unreadable, so the driver stays runnable standalone.
//
// Mock-only: /api/ai-lookup is routed to a local stub via
// drivers/_shared.mjs's installMockAiRoute; AI lookup is also disabled
// through app settings before anything is scanned. Restricted to
// localhost:3500 (drivers/_shared.mjs validateLocalTarget), the port
// reserved for virtual shops in the design doc.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  DEFAULT_TARGET,
  artifactPath,
  delay,
  ensureDir,
  installMockAiRoute,
  loginAndReachScan,
  scanCode,
  sumCsvQuantities,
  validateLocalTarget,
} from "./_shared.mjs";

const RETRY_STORM_CLICKS_DEFAULT = 3;

function parseArgs(argv) {
  const values = {
    target: DEFAULT_TARGET,
    outputDir: "reports/virtual-shops/night-shift",
    fixture: resolve(process.cwd(), "e2e/virtual-shops/fixtures/night-shift-scan-sequence.json"),
    stressCodesFixture: resolve(process.cwd(), "tools/fable5/fixtures/stress-codes.json"),
    days: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") values.target = argv[++index];
    else if (argument === "--output-dir") values.outputDir = argv[++index];
    else if (argument === "--fixture") values.fixture = argv[++index];
    else if (argument === "--stress-codes-fixture") values.stressCodesFixture = argv[++index];
    else if (argument === "--days") values.days = Number(argv[++index]);
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/virtual-shops/drivers/night-shift.mjs [--target http://localhost:3500] " +
          "[--output-dir reports/virtual-shops/night-shift] [--fixture path.json] " +
          "[--stress-codes-fixture path.json] [--days N]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.target || !values.outputDir || !values.fixture) {
    throw new Error("--target, --output-dir, and --fixture need values");
  }
  values.target = validateLocalTarget(values.target);
  if (values.days !== null && (!Number.isInteger(values.days) || values.days < 1)) {
    throw new Error("--days must be a positive integer");
  }
  return values;
}

async function loadScanSequence(fixturePath, stressCodesFixturePath) {
  try {
    const raw = await readFile(fixturePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.days) || parsed.days.length === 0) throw new Error("fixture has no days[]");
    return { mode: "fixture", days: parsed.days };
  } catch (error) {
    // Fallback: the pre-fixture behavior - a single synthetic day built from the raw stress-codes pool.
    const raw = JSON.parse(await readFile(stressCodesFixturePath, "utf8"));
    const codes = raw?.codes;
    if (!Array.isArray(codes) || codes.length < 12) {
      throw new Error(`Neither ${fixturePath} nor ${stressCodesFixturePath} yielded a usable scan plan`);
    }
    const burst = [...new Set(codes)].slice(0, 12);
    return {
      mode: "fallback",
      reason: error instanceof Error ? error.message : String(error),
      days: [
        {
          dayIndex: 1,
          phases: [
            { phase: "offline-burst", offline: true, scans: burst },
            { phase: "refresh-mid-session", action: "reload", offlineDuringReload: true },
            { phase: "reconnect", action: "go-online" },
            { phase: "retry-storm", action: "trigger-pending-sync-retry", retryCount: RETRY_STORM_CLICKS_DEFAULT },
          ],
          expected: { totalScansThisDay: burst.length, totalCountedThisDay: burst.length },
        },
      ],
    };
  }
}

async function readFeedLength(page) {
  return page.evaluate(() => window.__scanStore?.getState().scanFeed.length ?? null);
}

async function readPersistedCount(page) {
  return page.evaluate(() => {
    const sumRows = (rows) => rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const exposed = window.__scanStore;
    if (exposed?.getState) return sumRows(exposed.getState().finalCounts);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith("sis-scan-v1")) continue;
      try {
        const payload = JSON.parse(window.localStorage.getItem(key) || "null");
        if (Array.isArray(payload?.state?.finalCounts)) return sumRows(payload.state.finalCounts);
      } catch {
        // Keep looking; a malformed local blob is not trusted as the answer.
      }
    }
    return null;
  });
}

async function readDomCount(page) {
  return page.locator('[data-testid="final-count-body"] tr').evaluateAll((rows) =>
    rows.reduce((sum, row) => {
      const value = Number(row.querySelector("td")?.textContent?.trim() || "0");
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0),
  );
}

async function exportFinalCounts(page, runDir) {
  const trigger = page.getByTestId("export-menu-trigger");
  await trigger.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-final-counts").click();
  const download = await downloadPromise;
  const csvPath = resolve(runDir, "final-counts.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  return { csvPath, count: sumCsvQuantities(csv) };
}

async function drainPendingQueue(page, { attempts, delayMs }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pending = await page.evaluate(() => {
      const state = window.__scanStore?.getState();
      if (!state) return null;
      return state.pendingSyncQueue.filter((item) => item.businessId === state.businessId).length;
    });
    if (pending === 0) return { drained: true, remaining: 0 };
    const retryButton = page.getByTestId("retry-sync");
    if (await retryButton.isEnabled().catch(() => false)) await retryButton.click();
    await delay(delayMs);
  }
  const remaining = await page.evaluate(() => {
    const state = window.__scanStore?.getState();
    if (!state) return null;
    return state.pendingSyncQueue.filter((item) => item.businessId === state.businessId).length;
  });
  return { drained: remaining === 0, remaining };
}

function buildMarkdown(report) {
  const lines = [];
  lines.push("# Night Shift - offline and retry resilience report");
  lines.push("");
  lines.push(`Run: ${report.runId}`);
  lines.push(`Target: ${report.target} (mock backend only)`);
  lines.push(
    `Data source: ${
      report.data_source === "fixture"
        ? "fixtures/night-shift-scan-sequence.json"
        : `runtime fallback (${report.fixture_fallback_reason})`
    }`,
  );
  lines.push("");
  lines.push(
    `**${report.total_scans_issued} scans issued across ${report.days.length} simulated day(s) while offline/reconnecting, ` +
      `${report.crown_invariant ? "zero lost, zero double-counted" : "CROWN INVARIANT FAILED"} after recovery.**`,
  );
  lines.push("");
  lines.push("## Per-day results");
  lines.push("");
  lines.push("| Day | Scans issued | Expected | Feed survived refresh | Queue drained |");
  lines.push("|---|---|---|---|---|");
  for (const day of report.days) {
    lines.push(
      `| ${day.dayIndex} | ${day.scansIssued} | ${day.expectedScans ?? "n/a"} | ${day.feedSurvivedRefresh ? "yes" : "no"} | ${day.queueDrained ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Crown invariant readouts (cumulative, after the final day)");
  lines.push("");
  lines.push("| Readout | Value | Expected |");
  lines.push("|---|---|---|");
  lines.push(`| Scan feed length | ${report.final_feed_length} | ${report.total_scans_issued} |`);
  lines.push(`| DOM final-count total | ${report.dom_count} | ${report.total_scans_issued} |`);
  lines.push(`| Persisted (store/localStorage) total | ${report.persisted_count} | ${report.total_scans_issued} |`);
  lines.push(`| Exported CSV total | ${report.exported_count} | ${report.total_scans_issued} |`);
  lines.push("");
  if (report.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures) lines.push(`- ${failure}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(process.cwd(), options.outputDir, runId);
  const screenshotsDir = resolve(runDir, "screenshots");
  await ensureDir(screenshotsDir);

  const sequence = await loadScanSequence(options.fixture, options.stressCodesFixture);
  const daysToRun = options.days ? sequence.days.slice(0, options.days) : sequence.days;

  const report = {
    target: options.target,
    runId,
    data_source: sequence.mode,
    fixture_fallback_reason: sequence.mode === "fallback" ? sequence.reason : null,
    total_scans_issued: 0,
    days: [],
    final_feed_length: null,
    dom_count: null,
    persisted_count: null,
    exported_count: null,
    crown_invariant: false,
    screenshots: [],
    failures: [],
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.failures.push(`page error: ${error.message}`));
    await installMockAiRoute(context);

    await loginAndReachScan(page, options.target);
    await page.evaluate(() => {
      window.__scanStore.getState().updateSettings({ autoSuggestUnknowns: false });
    });

    for (const day of daysToRun) {
      const dayReport = {
        dayIndex: day.dayIndex,
        scansIssued: 0,
        expectedScans: day.expected?.totalScansThisDay ?? null,
        feedSurvivedRefresh: false,
        queueDrained: false,
      };
      const offlinePhase = day.phases.find((p) => p.phase === "offline-burst");
      const retryPhase = day.phases.find((p) => p.phase === "retry-storm");
      const unknownCodes = [`NIGHTSHIFTUNKNOWN${day.dayIndex}001`, `NIGHTSHIFTUNKNOWN${day.dayIndex}002`];
      const scanPlan = [...(offlinePhase?.scans ?? []), ...unknownCodes];

      // --- Phase 1: offline scan burst. Every scan must still appear and count.
      await context.setOffline(true);
      const feedBeforeDay = (await readFeedLength(page)) ?? 0;
      const midpoint = Math.ceil(scanPlan.length / 2);
      for (const code of scanPlan.slice(0, midpoint)) {
        await scanCode(page, code);
        dayReport.scansIssued += 1;
      }
      await page.waitForFunction((n) => window.__scanStore.getState().scanFeed.length >= n, feedBeforeDay + midpoint);
      const pendingWarningVisible = await page.getByTestId("pending-warning").isVisible({ timeout: 2000 }).catch(() => false);
      if (!pendingWarningVisible) {
        report.failures.push(
          `day ${day.dayIndex}: pending-warning ("Saved locally, not synced yet.") was not shown while offline`,
        );
      }
      const offlineShot = resolve(screenshotsDir, `day${day.dayIndex}-01-offline-burst.png`);
      await page.screenshot({ path: offlineShot, fullPage: true });
      report.screenshots.push(artifactPath(offlineShot));

      // --- Phase 2: mid-session refresh, still offline. Feed must survive.
      const feedLengthBeforeRefresh = await readFeedLength(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => Boolean(window.__scanStore));
      const feedLengthAfterRefresh = await readFeedLength(page);
      dayReport.feedSurvivedRefresh =
        feedLengthAfterRefresh !== null && feedLengthAfterRefresh === feedLengthBeforeRefresh;
      if (!dayReport.feedSurvivedRefresh) {
        report.failures.push(
          `day ${day.dayIndex}: scan feed did not survive the mid-session refresh: before=${feedLengthBeforeRefresh}, after=${feedLengthAfterRefresh}`,
        );
      }

      // --- Continue scanning the rest of the day's plan (still offline) after the refresh.
      for (const code of scanPlan.slice(midpoint)) {
        await scanCode(page, code);
        dayReport.scansIssued += 1;
      }
      await page.waitForFunction((n) => window.__scanStore.getState().scanFeed.length >= n, feedBeforeDay + scanPlan.length);

      // --- Phase 3: reconnect and trigger a retry storm on the pending queue.
      await context.setOffline(false);
      const retryClicks = retryPhase?.retryCount ?? RETRY_STORM_CLICKS_DEFAULT;
      const drainResult = await drainPendingQueue(page, { attempts: retryClicks, delayMs: 500 });
      dayReport.queueDrained = drainResult.drained;
      const reconnectShot = resolve(screenshotsDir, `day${day.dayIndex}-02-after-reconnect.png`);
      await page.screenshot({ path: reconnectShot, fullPage: true });
      report.screenshots.push(artifactPath(reconnectShot));

      if (dayReport.expectedScans !== null && dayReport.scansIssued < dayReport.expectedScans) {
        report.failures.push(
          `day ${day.dayIndex}: issued ${dayReport.scansIssued} scans, fixture's offline-burst expected at least ${dayReport.expectedScans}`,
        );
      }

      report.total_scans_issued += dayReport.scansIssued;
      report.days.push(dayReport);
    }

    // --- Final: crown invariant, checked three independent ways, across the whole cumulative session.
    report.final_feed_length = await readFeedLength(page);
    report.persisted_count = await readPersistedCount(page);
    report.dom_count = await readDomCount(page);
    const exported = await exportFinalCounts(page, runDir);
    report.exported_count = exported.count;

    report.crown_invariant =
      report.final_feed_length === report.total_scans_issued &&
      report.dom_count === report.total_scans_issued &&
      report.persisted_count === report.total_scans_issued &&
      report.exported_count === report.total_scans_issued;

    if (!report.crown_invariant) {
      report.failures.push(
        `Crown invariant failed: expected ${report.total_scans_issued} scans; ` +
          `feed=${report.final_feed_length}, dom=${report.dom_count}, ` +
          `persisted=${report.persisted_count}, exported=${report.exported_count}`,
      );
    }

    await writeFile(resolve(runDir, "report.md"), buildMarkdown(report), "utf8");
    await context.close();
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
    try {
      await writeFile(resolve(runDir, "report.md"), buildMarkdown(report), "utf8");
    } catch {
      // Best-effort: the JSON report below is the authoritative artifact.
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeFile(resolve(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify({
      report_dir: artifactPath(runDir),
      data_source: report.data_source,
      total_scans_issued: report.total_scans_issued,
      crown_invariant: report.crown_invariant,
      failures: report.failures,
    }),
  );
  if (report.failures.length > 0 || !report.crown_invariant) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
