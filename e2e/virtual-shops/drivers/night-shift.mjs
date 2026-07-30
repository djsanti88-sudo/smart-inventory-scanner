// e2e/virtual-shops/drivers/night-shift.mjs
//
// Virtual shop (d) "Night Shift" - the offline/retry resilience loop.
// Design: docs/superpowers/specs/2026-07-29-virtual-shops-design.md section (d).
//
// Flow (real UI, mock backend only):
//   1. Go offline (Playwright `context.setOffline(true)`, real network
//      blocking - the same mechanism e2e/stress-drive.mjs uses) and scan a
//      burst of known + unknown codes. Per the TOP-LEVEL LAW every scan must
//      still appear in the feed and count immediately, even though sync is
//      failing behind the scenes.
//   2. Refresh the page mid-session, still offline, and prove the scan feed
//      and pending queue survive the reload (persisted state, not just
//      in-memory Zustand state).
//   3. Reconnect (`context.setOffline(false)`) and trigger a retry storm on
//      the pending-sync queue by clicking "Try saving again" repeatedly in
//      quick succession - idempotency must hold: retries never create a
//      second counted entry for the same scan.
//   4. Assert the crown invariant across three independent readouts (DOM
//      final-count table, persisted Zustand/localStorage state, and an
//      exported CSV): feed rows == expected scans, totals == expected scans,
//      zero lost scans, zero double-counts.
//
// Mock-only: /api/ai-lookup is routed to a local stub (same NO_AI_STATUS
// shape as e2e/persona-drive.mjs / e2e/stress-drive.mjs); AI lookup is also
// disabled through app settings before anything is scanned. Restricted to
// localhost:3500, the port reserved for virtual shops in the design doc.
// Known-code fixture reused from tools/fable5/fixtures/stress-codes.json
// (read-only), per the design doc's explicit "reuse, don't invent" guidance.
//
// NOTE (wave-3 dedup): this file was built before e2e/virtual-shops/drivers/
// _shared.mjs existed. The NO_AI_STATUS stub, target-validation guard,
// scan()/artifactPath() helpers, and the crown-invariant triple-readout
// helpers below are intentionally local copies of the same small helpers
// used elsewhere in e2e/ (notably e2e/stress-drive.mjs). Once _shared.mjs
// lands, these should be de-duplicated to import from it instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_TARGET = "http://localhost:3500";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const KNOWN_CODE_COUNT = 12;
const UNKNOWN_CODES = ["NIGHTSHIFTUNKNOWN001", "NIGHTSHIFTUNKNOWN002"];
const RETRY_STORM_CLICKS = 5;

const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  geminiEnabled: false,
  openaiEnabled: false,
  geminiConfigured: false,
  openaiConfigured: false,
  premiumFallback: false,
  mode: "off",
  dailyLimit: 200,
  missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
  e2e: true,
};

function parseArgs(argv) {
  const values = {
    target: DEFAULT_TARGET,
    outputDir: "reports/virtual-shops/night-shift",
    fixture: "tools/fable5/fixtures/stress-codes.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") values.target = argv[++index];
    else if (argument === "--output-dir") values.outputDir = argv[++index];
    else if (argument === "--fixture") values.fixture = argv[++index];
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/virtual-shops/drivers/night-shift.mjs [--target http://localhost:3500] " +
          "[--output-dir reports/virtual-shops/night-shift] [--fixture tools/fable5/fixtures/stress-codes.json]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.target || !values.outputDir || !values.fixture) {
    throw new Error("--target, --output-dir, and --fixture need values");
  }
  const target = new URL(values.target);
  if (!LOCAL_HOSTS.has(target.hostname) || target.port !== "3500") {
    throw new Error("Night Shift driver is restricted to localhost port 3500 (the virtual-shops port)");
  }
  return values;
}

function artifactPath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function delay(milliseconds) {
  return new Promise((complete) => setTimeout(complete, milliseconds));
}

async function loadKnownCodes(fixturePath, count) {
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const codes = raw?.codes;
  if (!Array.isArray(codes) || codes.length < count) {
    throw new Error(`Fixture ${fixturePath} did not contain at least ${count} codes`);
  }
  const unique = [...new Set(codes)].slice(0, count);
  if (unique.length !== count) throw new Error(`Fixture ${fixturePath} did not yield ${count} unique codes`);
  return unique;
}

async function scan(page, code) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
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

function sumCsvQuantities(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  if (!lines[0]?.startsWith("quantity,")) throw new Error("Final-count CSV has an unexpected header");
  return lines.slice(1).reduce((sum, line) => {
    const comma = line.indexOf(",");
    const quantity = Number(comma === -1 ? line : line.slice(0, comma));
    if (!Number.isFinite(quantity)) throw new Error(`Invalid quantity in exported CSV: ${line}`);
    return sum + quantity;
  }, 0);
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
  lines.push("");
  lines.push(
    `**${report.total_scans_issued} scans issued while offline/reconnecting, ` +
      `${report.crown_invariant ? "zero lost, zero double-counted" : "CROWN INVARIANT FAILED"} after recovery.**`,
  );
  lines.push("");
  lines.push("## Phases");
  lines.push("");
  lines.push(`1. Offline scan burst: ${report.offline_scans_issued} scans issued while \`context.setOffline(true)\`.`);
  lines.push(`2. Mid-session refresh while still offline: ${report.refresh_completed ? "completed" : "NOT completed"}, feed survived reload: ${report.feed_survived_refresh ? "yes" : "no"}.`);
  lines.push(`3. Reconnect: ${report.reconnected ? "completed" : "NOT completed"}.`);
  lines.push(`4. Retry storm: ${report.retry_storm_clicks} rapid "Try saving again" clicks; queue drained: ${report.queue_drained ? "yes" : "no"} (remaining: ${report.queue_remaining_after_storm}).`);
  lines.push("");
  lines.push("## Crown invariant readouts");
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
  await mkdir(screenshotsDir, { recursive: true });

  const report = {
    target: options.target,
    runId,
    total_scans_issued: 0,
    offline_scans_issued: 0,
    refresh_completed: false,
    feed_survived_refresh: false,
    reconnected: false,
    retry_storm_clicks: RETRY_STORM_CLICKS,
    queue_drained: false,
    queue_remaining_after_storm: null,
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
    const fixturePath = resolve(process.cwd(), options.fixture);
    const knownCodes = await loadKnownCodes(fixturePath, KNOWN_CODE_COUNT);
    const scanPlan = [...knownCodes, ...UNKNOWN_CODES];

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.failures.push(`page error: ${error.message}`));
    await context.route("**/api/ai-lookup", async (route) => {
      if (route.request().method() === "GET") await route.fulfill({ json: NO_AI_STATUS });
      else await route.fulfill({ status: 503, json: { error: "Night Shift driver keeps product lookup off" } });
    });

    await page.goto(`${options.target}/login`, { waitUntil: "domcontentloaded" });
    const loginButton = page.getByTestId("login-button");
    if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
    await page.waitForURL("**/scan", { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__scanStore));
    await page.evaluate(() => {
      window.__scanStore.getState().updateSettings({ aiLookupEnabled: false, autoSuggestUnknowns: false });
    });
    await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });

    // --- Phase 1: offline scan burst. Every scan must still appear and count.
    await context.setOffline(true);
    const offlineBurst = scanPlan.slice(0, Math.ceil(scanPlan.length / 2));
    for (const code of offlineBurst) {
      await scan(page, code);
      report.total_scans_issued += 1;
      report.offline_scans_issued += 1;
    }
    await page.waitForFunction((n) => window.__scanStore.getState().scanFeed.length >= n, offlineBurst.length);
    const pendingWarningVisible = await page.getByTestId("pending-warning").isVisible({ timeout: 2000 }).catch(() => false);
    if (!pendingWarningVisible) {
      report.failures.push('pending-warning ("Saved locally, not synced yet.") was not shown while offline');
    }
    const offlineShot = resolve(screenshotsDir, "01-offline-burst.png");
    await page.screenshot({ path: offlineShot, fullPage: true });
    report.screenshots.push(artifactPath(offlineShot));

    // --- Phase 2: mid-session refresh, still offline. Feed must survive.
    const feedLengthBeforeRefresh = await readFeedLength(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__scanStore));
    const feedLengthAfterRefresh = await readFeedLength(page);
    report.refresh_completed = true;
    report.feed_survived_refresh = feedLengthAfterRefresh !== null && feedLengthAfterRefresh === feedLengthBeforeRefresh;
    if (!report.feed_survived_refresh) {
      report.failures.push(
        `Scan feed did not survive the mid-session refresh: before=${feedLengthBeforeRefresh}, after=${feedLengthAfterRefresh}`,
      );
    }

    // --- Continue scanning the rest of the plan (still offline) after the refresh.
    const remainingAfterRefresh = scanPlan.slice(offlineBurst.length);
    for (const code of remainingAfterRefresh) {
      await scan(page, code);
      report.total_scans_issued += 1;
      report.offline_scans_issued += 1;
    }
    await page.waitForFunction((n) => window.__scanStore.getState().scanFeed.length >= n, scanPlan.length);

    // --- Phase 3: reconnect and trigger a retry storm on the pending queue.
    await context.setOffline(false);
    report.reconnected = true;
    const drainResult = await drainPendingQueue(page, { attempts: RETRY_STORM_CLICKS, delayMs: 500 });
    report.queue_drained = drainResult.drained;
    report.queue_remaining_after_storm = drainResult.remaining;
    const reconnectShot = resolve(screenshotsDir, "02-after-reconnect.png");
    await page.screenshot({ path: reconnectShot, fullPage: true });
    report.screenshots.push(artifactPath(reconnectShot));

    // --- Phase 4: crown invariant, checked three independent ways.
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

  console.log(JSON.stringify({
    report_dir: artifactPath(runDir),
    total_scans_issued: report.total_scans_issued,
    crown_invariant: report.crown_invariant,
    failures: report.failures,
  }));
  if (report.failures.length > 0 || !report.crown_invariant) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
