import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const MAX_SCANS_PER_SECOND = 5;
const MAX_UNKNOWN_SCANS = 5;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  geminiEnabled: false,
  openaiEnabled: false,
  geminiConfigured: false,
  openaiConfigured: false,
  premiumFallback: false,
  mode: "off",
  dailyLimit: 500,
  missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
  e2e: true,
};

const INTENSITIES = {
  light: {
    scans: 100,
    contexts: 1,
    batchSize: 5,
    batchPauseMs: 1_000,
    refreshMidSession: false,
    offlineReconnect: false,
  },
  standard: {
    scans: 300,
    contexts: 3,
    batchSize: 5,
    batchPauseMs: 10_000,
    refreshMidSession: true,
    offlineReconnect: true,
  },
  heavy: {
    scans: 1_000,
    contexts: 5,
    batchSize: 5,
    batchPauseMs: 10_000,
    refreshMidSession: true,
    offlineReconnect: true,
  },
};

function parseArgs(argv) {
  const options = {
    target: "",
    intensity: "standard",
    allowCloud: false,
    unknownScans: 0,
    fixture: "tools/fable5/fixtures/stress-codes.json",
    corpus: "src/server/knowledge.generated.db",
    output: "reports/fable5/manual-stress/stress/report.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--intensity") options.intensity = argv[++index];
    else if (argument === "--allow-cloud") options.allowCloud = true;
    else if (argument === "--unknown-scans") options.unknownScans = Number(argv[++index]);
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--corpus") options.corpus = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--help") {
      console.log(
        "Usage: node e2e/stress-drive.mjs --target <url> [--intensity light|standard|heavy] " +
          "[--allow-cloud] [--unknown-scans N] [--output report.json]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.target) throw new Error("--target is required");
  if (!Object.hasOwn(INTENSITIES, options.intensity)) {
    throw new Error("--intensity must be light, standard, or heavy");
  }
  if (!Number.isInteger(options.unknownScans) || options.unknownScans < 0) {
    throw new Error("--unknown-scans must be a non-negative integer");
  }
  if (options.unknownScans > MAX_UNKNOWN_SCANS) {
    throw new Error(`--unknown-scans is capped at ${MAX_UNKNOWN_SCANS}`);
  }
  return options;
}

function validateTarget(options) {
  const target = new URL(options.target);
  const local = LOCAL_HOSTS.has(target.hostname);
  if (local && target.port !== "3400") {
    throw new Error("Local stress targets must use dedicated port 3400");
  }
  if (!local && !options.allowCloud) {
    throw new Error("Non-localhost stress targets require explicit --allow-cloud");
  }
  if (!local && target.protocol !== "https:") {
    throw new Error("Cloud stress targets must use HTTPS");
  }
  return { local, routeMock: local, target: target.href.replace(/\/$/, "") };
}

function validateFixture(fixturePath, corpusPath) {
  const completed = spawnSync(
    process.env.PYTHON || "python",
    [
      "-m",
      "tools.fable5.stress",
      "validate-fixture",
      "--fixture",
      fixturePath,
      "--corpus",
      corpusPath,
    ],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );
  if (completed.error || completed.status !== 0) {
    const detail = completed.error?.message || completed.stderr || completed.stdout || "unknown error";
    throw new Error(`Fixture revalidation failed at run start: ${detail.trim()}`);
  }
}

function artifactPath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function delay(milliseconds) {
  return new Promise((complete) => setTimeout(complete, milliseconds));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] * 100) / 100;
}

function maxObservedRate(timestamps) {
  let start = 0;
  let maximum = 0;
  for (let end = 0; end < timestamps.length; end += 1) {
    while (timestamps[end] - timestamps[start] >= 1_000) start += 1;
    maximum = Math.max(maximum, end - start + 1);
  }
  return maximum;
}

class ScanRateLimiter {
  constructor(safety) {
    this.safety = safety;
    this.recent = [];
    this.issuedAt = [];
  }

  async wait() {
    while (true) {
      const now = performance.now();
      this.recent = this.recent.filter((value) => now - value < 1_000);
      if (this.recent.length < MAX_SCANS_PER_SECOND) {
        const issued = performance.now();
        this.recent.push(issued);
        this.issuedAt.push(issued);
        return;
      }
      const waitMs = Math.max(1, 1_000 - (now - this.recent[0]));
      await this.safety.guard(delay(waitMs));
    }
  }
}

class SafetyTrip {
  constructor() {
    this.error = null;
    this.reject = null;
    this.promise = new Promise((_, reject) => {
      this.reject = reject;
    });
    this.promise.catch(() => {});
  }

  trip(message) {
    if (this.error) return;
    this.error = new Error(message);
    this.reject(this.error);
  }

  async guard(promise) {
    if (this.error) throw this.error;
    const value = await Promise.race([promise, this.promise]);
    if (this.error) throw this.error;
    return value;
  }
}

async function readDailyCap(page) {
  return page.evaluate(() => {
    const exposed = window.__scanStore;
    if (exposed?.getState) {
      const settings = exposed.getState().settings;
      return { used: settings.dailyLookupCount, limit: settings.dailyLookupLimit };
    }
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith("sis-scan-v1")) continue;
      try {
        const payload = JSON.parse(window.localStorage.getItem(key) || "null");
        const settings = payload?.state?.settings;
        if (Number.isFinite(settings?.dailyLookupCount) && Number.isFinite(settings?.dailyLookupLimit)) {
          return { used: settings.dailyLookupCount, limit: settings.dailyLookupLimit };
        }
      } catch {
        // A malformed local blob is not trusted. Continue looking, then fail closed below.
      }
    }
    return null;
  });
}

async function assertDailyCap(page, safety) {
  const cap = await safety.guard(readDailyCap(page));
  if (!cap || !Number.isInteger(cap.used) || !Number.isInteger(cap.limit)) {
    safety.trip("Shared daily cap could not be read before the batch");
    throw safety.error;
  }
  if (cap.used < 0 || cap.limit < 0 || cap.used >= cap.limit) {
    safety.trip(`Shared daily cap unavailable before batch: ${cap.used} of ${cap.limit}`);
    throw safety.error;
  }
  return cap;
}

async function disableProductLookup(page, target) {
  await page.goto(`${target}/login`, { waitUntil: "domcontentloaded" });
  const loginButton = page.getByTestId("login-button");
  if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
  await page.waitForURL("**/scan", { timeout: 30_000 });

  const disabledThroughStore = await page.evaluate(() => {
    const exposed = window.__scanStore;
    if (!exposed?.getState) return false;
    exposed.getState().updateSettings({ aiLookupEnabled: false, autoSuggestUnknowns: false });
    return true;
  });
  if (!disabledThroughStore) {
    await page.goto(`${target}/settings`, { waitUntil: "domcontentloaded" });
    const toggle = page.getByTestId("setting-ai-enabled");
    if (!(await toggle.isVisible().catch(() => false))) {
      throw new Error("Could not prove product lookup is disabled for this target and signed-in role");
    }
    if (await toggle.isChecked()) await toggle.uncheck();
  }
  await delay(100);
  await page.goto(`${target}/scan`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
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
        // Keep looking. The exported CSV remains the primary persisted-state assertion.
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
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines[0] !== "quantity,product_name,brand,category,specs,part_number,location,counted_at,session_id" &&
      !lines[0]?.startsWith("quantity,")) {
    throw new Error("Final-count CSV has an unexpected header");
  }
  return lines.slice(1).reduce((sum, line) => {
    const comma = line.indexOf(",");
    const quantity = Number(comma === -1 ? line : line.slice(0, comma));
    if (!Number.isFinite(quantity)) throw new Error(`Invalid quantity in exported CSV: ${line}`);
    return sum + quantity;
  }, 0);
}

async function exportContextCounts(page, outputDir, index, safety) {
  const trigger = page.getByTestId("export-menu-trigger");
  if (!(await trigger.isVisible().catch(() => false))) {
    const summary = page.getByText("Sessions and export", { exact: true });
    if (await summary.isVisible().catch(() => false)) await summary.click();
  }
  await safety.guard(trigger.click());
  const downloadPromise = page.waitForEvent("download");
  await safety.guard(page.getByTestId("export-final-counts").click());
  const download = await safety.guard(downloadPromise);
  const csvPath = resolve(outputDir, `context-${index + 1}-final-counts.csv`);
  await safety.guard(download.saveAs(csvPath));
  const csv = await readFile(csvPath, "utf8");
  return { csvPath, count: sumCsvQuantities(csv) };
}

async function issueScan({ page, code, expectedScans, safety, activeScans, limiter, latencies }) {
  await limiter.wait();
  const started = performance.now();
  activeScans.set(page, code);
  const input = page.getByTestId("scanner-input");
  try {
    await safety.guard(input.click());
    await safety.guard(input.pressSequentially(code, { delay: 2 }));
    await safety.guard(input.press("Enter"));
    await safety.guard(page.getByText(`${expectedScans} scans`, { exact: true }).waitFor());
    latencies.push(performance.now() - started);
  } finally {
    if (!safety.error) activeScans.delete(page);
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const targetPolicy = validateTarget(options);
  const config = INTENSITIES[options.intensity];
  const fixturePath = resolve(process.cwd(), options.fixture);
  const corpusPath = resolve(process.cwd(), options.corpus);
  const outputPath = resolve(process.cwd(), options.output);
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  const report = {
    target: targetPolicy.target,
    intensity: options.intensity,
    fixture_revalidated: false,
    fixture_codes: 0,
    unknown_scans: options.unknownScans,
    contexts: config.contexts,
    total_scans_requested: config.scans + options.unknownScans,
    total_scans_issued: 0,
    exported_count: 0,
    persisted_count: 0,
    dom_count: 0,
    ai_lookup_requests: 0,
    rate_limit_429s: 0,
    max_observed_scans_per_second: 0,
    scan_latency_ms: { p50: 0, p95: 0, max: 0 },
    refresh_completed: false,
    offline_reconnect_completed: false,
    route_mocked: targetPolicy.routeMock,
    crown_invariant: false,
    context_results: [],
    console_errors: [],
    failures: [],
  };
  const safety = new SafetyTrip();
  const activeScans = new Map();
  const latencies = [];
  const limiter = new ScanRateLimiter(safety);
  let browser;
  const sessions = [];
  let monitoringArmed = false;

  try {
    validateFixture(fixturePath, corpusPath);
    report.fixture_revalidated = true;
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const codes = fixture.codes;
    if (!Array.isArray(codes) || codes.length !== 40 || new Set(codes).size !== 40) {
      throw new Error("Validated fixture did not contain exactly 40 unique codes");
    }
    report.fixture_codes = codes.length;

    browser = await chromium.launch({ headless: true });
    for (let index = 0; index < config.contexts; index += 1) {
      const context = await browser.newContext({ acceptDownloads: true });
      if (targetPolicy.routeMock) {
        await context.route("**/api/ai-lookup", async (route) => {
          if (route.request().method() === "GET") await route.fulfill({ json: NO_AI_STATUS });
          else await route.fulfill({ status: 503, json: { error: "Stress safety mock" } });
        });
      }
      context.on("request", (request) => {
        if (!monitoringArmed) return;
        const path = new URL(request.url()).pathname.replace(/\/$/, "");
        if (path !== "/api/ai-lookup") return;
        let page;
        try { page = request.frame().page(); } catch { page = null; }
        const scan = (page && activeScans.get(page)) || "no active scan";
        report.ai_lookup_requests += 1;
        safety.trip(`/api/ai-lookup request detected; offending scan: ${scan}`);
      });
      context.on("response", (response) => {
        if (!monitoringArmed) return;
        if (!(response.status() === 429)) return;
        let page;
        try { page = response.request().frame().page(); } catch { page = null; }
        const scan = (page && activeScans.get(page)) || "no active scan";
        report.rate_limit_429s += 1;
        safety.trip(`429 detected; stopped on offending scan: ${scan}`);
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => report.console_errors.push(`context ${index + 1}: ${error.message}`));
      await disableProductLookup(page, targetPolicy.target);
      sessions.push({ context, page, issued: 0 });
    }

    monitoringArmed = true;
    for (const session of sessions) await assertDailyCap(session.page, safety);

    const scanPlan = Array.from({ length: config.scans }, (_, index) =>
      codes[Math.floor(index / config.batchSize) % codes.length],
    );
    for (let index = 0; index < options.unknownScans; index += 1) {
      scanPlan.push(`FABLE5UNKNOWN${String(index + 1).padStart(3, "0")}`);
    }
    const refreshAt = Math.floor(scanPlan.length / 2);
    const offlineAt = Math.floor((scanPlan.length * 2) / 3);

    for (let batchStart = 0; batchStart < scanPlan.length; batchStart += config.batchSize) {
      for (const session of sessions) await assertDailyCap(session.page, safety);
      const batch = scanPlan.slice(batchStart, batchStart + config.batchSize);
      for (let offset = 0; offset < batch.length; offset += 1) {
        const absoluteIndex = batchStart + offset;
        if (config.refreshMidSession && !report.refresh_completed && absoluteIndex >= refreshAt) {
          monitoringArmed = false;
          await safety.guard(sessions[0].page.reload({ waitUntil: "domcontentloaded" }));
          await safety.guard(sessions[0].page.getByTestId("scanner-input").waitFor());
          monitoringArmed = true;
          report.refresh_completed = true;
        }

        let sessionIndex = absoluteIndex % sessions.length;
        let offlineThisScan = false;
        if (config.offlineReconnect && !report.offline_reconnect_completed && absoluteIndex >= offlineAt) {
          sessionIndex = 0;
          offlineThisScan = true;
          await safety.guard(sessions[0].context.setOffline(true));
        }
        const session = sessions[sessionIndex];
        try {
          await issueScan({
            page: session.page,
            code: batch[offset],
            expectedScans: session.issued + 1,
            safety,
            activeScans,
            limiter,
            latencies,
          });
          session.issued += 1;
          report.total_scans_issued += 1;
        } finally {
          if (offlineThisScan) {
            await session.context.setOffline(false);
            report.offline_reconnect_completed = true;
          }
        }
      }
      if (batchStart + config.batchSize < scanPlan.length) {
        await safety.guard(delay(config.batchPauseMs));
      }
    }

    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const exported = await exportContextCounts(session.page, outputDir, index, safety);
      const persistedCount = await safety.guard(readPersistedCount(session.page));
      const domCount = await safety.guard(readDomCount(session.page));
      const screenshotPath = resolve(outputDir, `context-${index + 1}-final.png`);
      await safety.guard(session.page.screenshot({ path: screenshotPath, fullPage: true }));
      const contextResult = {
        context: index + 1,
        scans_issued: session.issued,
        exported_count: exported.count,
        persisted_count: persistedCount,
        dom_count: domCount,
        csv: artifactPath(exported.csvPath),
        screenshot: artifactPath(screenshotPath),
      };
      report.context_results.push(contextResult);
      report.exported_count += exported.count;
      report.persisted_count += persistedCount ?? 0;
      report.dom_count += domCount;
      if (exported.count !== session.issued) {
        throw new Error(
          `Crown invariant failed in context ${index + 1}: issued ${session.issued}, exported ${exported.count}`,
        );
      }
      if (persistedCount !== null && persistedCount !== session.issued) {
        throw new Error(
          `Persisted-state mismatch in context ${index + 1}: issued ${session.issued}, persisted ${persistedCount}`,
        );
      }
      if (domCount !== session.issued) {
        throw new Error(
          `DOM secondary mismatch in context ${index + 1}: issued ${session.issued}, DOM ${domCount}`,
        );
      }
    }

    report.crown_invariant =
      report.total_scans_issued === report.total_scans_requested &&
      report.exported_count === report.total_scans_issued;
    if (!report.crown_invariant) {
      throw new Error(
        `Crown invariant failed: issued ${report.total_scans_issued}, exported ${report.exported_count}`,
      );
    }
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    monitoringArmed = false;
    report.ai_lookup_requests = Math.max(report.ai_lookup_requests, safety.error?.message.includes("/api/ai-lookup") ? 1 : 0);
    report.rate_limit_429s = Math.max(report.rate_limit_429s, safety.error?.message.includes("429") ? 1 : 0);
    report.max_observed_scans_per_second = maxObservedRate(limiter.issuedAt);
    report.scan_latency_ms = {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.round(Math.max(...latencies) * 100) / 100 : 0,
    };
    for (const session of sessions) {
      await session.context.setOffline(false).catch(() => {});
      await session.context.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    report: artifactPath(outputPath),
    issued: report.total_scans_issued,
    exported: report.exported_count,
    crown_invariant: report.crown_invariant,
    failures: report.failures,
  }));
  if (report.failures.length > 0 || !report.crown_invariant) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
