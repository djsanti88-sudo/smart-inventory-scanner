// e2e/virtual-shops/drivers/legacy-tires.mjs
//
// Virtual shop (c) "Legacy Tires" - the "we found you $X" demo generator.
// Design: docs/superpowers/specs/2026-07-29-virtual-shops-design.md section (c).
//
// Flow (real UI, mock backend only):
//   1. Generate an ugly, messy legacy-style spreadsheet (reuses
//      e2e/teach/sheets.mjs's generateInventorySheet, as-is) representing the
//      shop's first-pass physical count, and import it through the real
//      Universal Import flow on /products. Import establishes the app's own
//      counted quantity for each SKU (matches the app's real import
//      contract: import sets counted quantity directly, no scanning needed).
//   2. Physically scan a deliberate subset of barcodes on /scan, on top of
//      the import, to push a few SKUs further away from the ground truth -
//      this is the "found extra stock on the shelf" half of the variance.
//   3. Generate a ground-truth "records" file (reuses generateShopwareCsv,
//      as-is) and run it through the real Reconcile flow on /reconcile.
//   4. Extract the rendered variance buckets from the DOM for evidence, and
//      independently compute the dollar variance from a LOCAL fixture
//      unit-cost column (never sent to the app or any network call) so the
//      headline number in the report is provably correct math, not a parsed
//      guess at the app's own bucket delta sign convention.
//   5. Write a demo-ready markdown report: "Records say N, counted M, ~$X
//      variance across K SKUs."
//
// Mock-only: /api/ai-lookup is routed to a local stub (same NO_AI_STATUS
// shape as e2e/persona-drive.mjs / e2e/stress-drive.mjs); AI lookup is also
// disabled through app settings before anything is scanned. Restricted to
// localhost:3500, the port reserved for virtual shops in the design doc.
//
// NOTE (wave-3 dedup): this file was built before e2e/virtual-shops/drivers/
// _shared.mjs existed. The NO_AI_STATUS stub, target-validation guard, and
// scan()/artifactPath() helpers below are intentionally local copies of the
// same small helpers used elsewhere in e2e/. Once _shared.mjs lands, these
// should be de-duplicated to import from it instead of redefining them.

import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { generateInventorySheet, generateShopwareCsv } from "../../teach/sheets.mjs";

const DEFAULT_TARGET = "http://localhost:3500";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const KNOWN_BUCKETS = [
  "agreement",
  "variance",
  "expected_not_counted",
  "ambiguous",
  "unmatched",
  "non_tire",
  "uom_review",
  "unparseable",
];

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

// ---------------------------------------------------------------------------
// LOCAL fixture: SKUs with a book/records quantity (what the reconcile file
// says should be on hand), a first-pass import quantity (what the messy
// legacy spreadsheet reports as physically counted), a subset of extra units
// physically scanned on top of the import, and a unit cost. Unit costs never
// leave this file - the dollar math below runs entirely in-process.
// ---------------------------------------------------------------------------

const PRODUCTS = [
  { partNumber: "28034300", brand: "Falken", model: "Wildpeak A/T3W", size: "265/70R17", barcode: "848983006257", bookQty: 6, importQty: 6, scanExtra: 0, unitCost: 145.0 },
  { partNumber: "90000027117", brand: "Cooper", model: "Discoverer SRX", size: "265/70R17", barcode: "029142869870", bookQty: 4, importQty: 4, scanExtra: 2, unitCost: 128.5 },
  { partNumber: "44953", brand: "Michelin", model: "Premier LTX", size: "225/65R17", barcode: "086699449535", bookQty: 8, importQty: 5, scanExtra: 0, unitCost: 162.0 },
  { partNumber: "142367", brand: "Bridgestone", model: "Dueler H/P Sport AS", size: "225/65R17", barcode: "092971251802", bookQty: 5, importQty: 5, scanExtra: 0, unitCost: 138.75 },
  { partNumber: "15493460000", brand: "Continental", model: "ProContact TX", size: "235/60R18", barcode: "051342150847", bookQty: 3, importQty: 3, scanExtra: 1, unitCost: 121.0 },
  { partNumber: "3655800", brand: "Pirelli", model: "Cinturato P7 All Season", size: "235/55R18", barcode: "054137079934", bookQty: 7, importQty: 3, scanExtra: 0, unitCost: 175.25 },
  { partNumber: "2159273", brand: "Kumho", model: "Eco Solus KL21", size: "225/65R17", barcode: "8808956132873", bookQty: 2, importQty: 2, scanExtra: 0, unitCost: 99.99 },
  { partNumber: "18773NXK", brand: "Nexen", model: "Roadian ATX", size: "265/70R17", barcode: "191563016307", bookQty: 5, importQty: 5, scanExtra: 2, unitCost: 110.0 },
];

function computeExpectedVariance(products) {
  const rows = products.map((p) => {
    const finalQty = p.importQty + p.scanExtra;
    const deltaUnits = finalQty - p.bookQty;
    return {
      ...p,
      finalQty,
      deltaUnits,
      deltaDollars: Math.round(deltaUnits * p.unitCost * 100) / 100,
    };
  });
  const recordsTotal = products.reduce((sum, p) => sum + p.bookQty, 0);
  const countedTotal = rows.reduce((sum, r) => sum + r.finalQty, 0);
  const varianceRows = rows.filter((r) => r.deltaUnits !== 0);
  const totalDollarVariance = Math.round(
    varianceRows.reduce((sum, r) => sum + Math.abs(r.deltaDollars), 0) * 100,
  ) / 100;
  return { rows, recordsTotal, countedTotal, varianceRows, totalDollarVariance };
}

function parseArgs(argv) {
  const values = { target: DEFAULT_TARGET, outputDir: "reports/virtual-shops/legacy-tires" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") values.target = argv[++index];
    else if (argument === "--output-dir") values.outputDir = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node e2e/virtual-shops/drivers/legacy-tires.mjs [--target http://localhost:3500] [--output-dir reports/virtual-shops/legacy-tires]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.target || !values.outputDir) throw new Error("--target and --output-dir need values");
  const target = new URL(values.target);
  if (!LOCAL_HOSTS.has(target.hostname) || target.port !== "3500") {
    throw new Error("Legacy Tires driver is restricted to localhost port 3500 (the virtual-shops port)");
  }
  return values;
}

function artifactPath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

async function scan(page, code) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

async function readReconcileReport(page) {
  const rows = [];
  for (const bucket of KNOWN_BUCKETS) {
    const section = page.getByTestId(`bucket-${bucket}`);
    const visible = await section.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) continue;
    const bodyRows = section.locator("tbody tr");
    const rowCount = await bodyRows.count().catch(() => 0);
    for (let i = 0; i < rowCount; i += 1) {
      const row = bodyRows.nth(i);
      const cells = row.locator("td");
      const cellCount = await cells.count().catch(() => 0);
      const cellTexts = [];
      for (let c = 0; c < cellCount; c += 1) {
        cellTexts.push((await cells.nth(c).innerText().catch(() => "")).trim());
      }
      const deltaText = (await row.getByTestId("reconcile-delta").innerText().catch(() => "")).trim();
      rows.push({ bucket, partNumbers: cellTexts[0] ?? "", delta: deltaText });
    }
  }
  return rows;
}

function findAppRow(reportRows, partNumber) {
  const needle = String(partNumber).toLowerCase();
  return reportRows.find((r) => r.partNumbers.toLowerCase().includes(needle));
}

function moneyFmt(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

async function buildDemoMarkdown({ expected, appBuckets, runId, target }) {
  const lines = [];
  lines.push("# Legacy Tires - \"We found you money\" variance report");
  lines.push("");
  lines.push(`Run: ${runId}`);
  lines.push(`Target: ${target} (mock backend only)`);
  lines.push("");
  lines.push(
    `**Records say ${expected.recordsTotal} units. We counted ${expected.countedTotal}. ` +
      `That's ${moneyFmt(expected.totalDollarVariance)} in variance across ${expected.varianceRows.length} SKUs.**`,
  );
  lines.push("");
  lines.push(
    "Records = the shop's book/records file, run through the app's real Reconcile flow. " +
      "Counted = physical quantities the app has on hand today, from an imported first-pass " +
      "spreadsheet plus a follow-up physical scan of a few SKUs. Every dollar figure below is " +
      "computed from a local unit-cost fixture - nothing about pricing or cost is ever sent to " +
      "the app or any network call.",
  );
  lines.push("");
  lines.push("## Variance detail");
  lines.push("");
  lines.push("| SKU | Brand | Model | Size | Records Qty | Counted Qty | Delta (units) | Unit Cost | Delta ($) | App bucket |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const row of expected.rows) {
    const appRow = findAppRow(appBuckets, row.partNumber);
    lines.push(
      `| ${row.partNumber} | ${row.brand} | ${row.model} | ${row.size} | ${row.bookQty} | ${row.finalQty} | ` +
        `${row.deltaUnits > 0 ? "+" : ""}${row.deltaUnits} | $${row.unitCost.toFixed(2)} | ${moneyFmt(row.deltaDollars)} | ` +
        `${appRow ? appRow.bucket : "(not found in report)"} |`,
    );
  }
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push("1. Generated an ugly, renamed-header legacy spreadsheet (level-5 messiness) and imported it through the real Universal Import flow on `/products`.");
  lines.push("2. Physically scanned a subset of barcodes on `/scan` to represent stock found during a walk-through, on top of the import.");
  lines.push("3. Generated a ground-truth records file and ran it through the real Reconcile flow on `/reconcile`.");
  lines.push("4. Read the rendered variance buckets from the report UI as evidence (`App bucket` column above).");
  lines.push("5. Computed the dollar variance independently from a local, never-transmitted unit-cost fixture.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(process.cwd(), options.outputDir, runId);
  const screenshotsDir = resolve(runDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const expected = computeExpectedVariance(PRODUCTS);
  const report = {
    target: options.target,
    runId,
    records_total: expected.recordsTotal,
    counted_total: expected.countedTotal,
    total_dollar_variance: expected.totalDollarVariance,
    variance_sku_count: expected.varianceRows.length,
    per_sku: [],
    app_reconcile_rows: [],
    screenshots: [],
    failures: [],
  };

  let browser;
  try {
    const bookSheet = await generateInventorySheet({
      level: 5,
      products: PRODUCTS.map((p) => ({
        partNumber: p.partNumber,
        brand: p.brand,
        model: p.model,
        size: p.size,
        quantity: p.importQty,
        barcode: p.barcode,
        name: `${p.brand} ${p.model}`,
      })),
      outDir: runDir,
      fileBase: "legacy-book",
    });

    const groundTruth = await generateShopwareCsv({
      products: PRODUCTS.map((p) => ({
        partNumber: p.partNumber,
        brand: p.brand,
        model: p.model,
        size: p.size,
        barcode: p.barcode,
        quantity: p.bookQty,
      })),
      outDir: runDir,
      fileBase: "legacy-ground-truth",
    });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.failures.push(`page error: ${error.message}`));
    await context.route("**/api/ai-lookup", async (route) => {
      if (route.request().method() === "GET") await route.fulfill({ json: NO_AI_STATUS });
      else await route.fulfill({ status: 503, json: { error: "Legacy Tires driver keeps product lookup off" } });
    });

    await page.goto(`${options.target}/login`, { waitUntil: "domcontentloaded" });
    const loginButton = page.getByTestId("login-button");
    if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
    await page.waitForURL("**/scan", { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__scanStore));
    await page.evaluate(() => {
      window.__scanStore.getState().updateSettings({ aiLookupEnabled: false, autoSuggestUnknowns: false });
    });

    // --- Step 1: import the ugly legacy spreadsheet through the real Universal Import flow.
    await page.goto(`${options.target}/products`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("universal-import-file").setInputFiles(bookSheet.filePath);
    const preview = await Promise.race([
      page.getByTestId("import-preview").waitFor({ state: "visible", timeout: 15_000 }).then(() => "preview"),
      page.getByTestId("column-mapping").waitFor({ state: "visible", timeout: 15_000 }).then(() => "mapping"),
    ]);
    if (preview === "mapping") {
      const confirmButton = page.getByTestId("mapping-confirm");
      if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) await confirmButton.click();
    }
    const importErrorVisible = await page.getByTestId("import-error").isVisible({ timeout: 1000 }).catch(() => false);
    if (importErrorVisible) throw new Error("import-error was visible on the level-5 messy legacy spreadsheet");
    const importPreviewShot = resolve(screenshotsDir, "01-import-preview.png");
    await page.screenshot({ path: importPreviewShot, fullPage: true });
    report.screenshots.push(artifactPath(importPreviewShot));
    await page.getByTestId("import-apply").click();
    await page.getByTestId("import-summary").waitFor({ state: "visible", timeout: 15_000 });

    // --- Step 2: physically scan the deliberate variance subset on top of the import.
    await page.goto(`${options.target}/scan`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
    for (const product of PRODUCTS) {
      for (let i = 0; i < product.scanExtra; i += 1) {
        await scan(page, product.barcode);
      }
    }
    const totalExtraScans = PRODUCTS.reduce((sum, p) => sum + p.scanExtra, 0);
    if (totalExtraScans > 0) {
      await page.waitForFunction(
        (min) => window.__scanStore.getState().scanFeed.length >= min,
        totalExtraScans,
      );
    }

    // --- Step 3: run the ground-truth records file through the real Reconcile flow.
    await page.goto(`${options.target}/reconcile`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("reconcile-file").setInputFiles(groundTruth.filePath);
    await page.getByTestId("reconcile-run").click();
    await page.getByTestId("reconcile-report").waitFor({ state: "visible", timeout: 20_000 });
    const reconcileShot = resolve(screenshotsDir, "02-reconcile-report.png");
    await page.screenshot({ path: reconcileShot, fullPage: true });
    report.screenshots.push(artifactPath(reconcileShot));

    // --- Step 4: extract the app's own variance buckets as evidence.
    const appRows = await readReconcileReport(page);
    report.app_reconcile_rows = appRows;
    report.per_sku = expected.rows.map((row) => ({
      partNumber: row.partNumber,
      brand: row.brand,
      model: row.model,
      size: row.size,
      recordsQty: row.bookQty,
      countedQty: row.finalQty,
      deltaUnits: row.deltaUnits,
      deltaDollars: row.deltaDollars,
      appBucket: findAppRow(appRows, row.partNumber)?.bucket ?? null,
    }));

    // --- Step 5: write the demo-ready markdown report.
    const markdown = await buildDemoMarkdown({ expected, appBuckets: appRows, runId, target: options.target });
    await writeFile(resolve(runDir, "report.md"), markdown, "utf8");

    await context.close();
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeFile(resolve(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    report_dir: artifactPath(runDir),
    records_total: report.records_total,
    counted_total: report.counted_total,
    total_dollar_variance: report.total_dollar_variance,
    failures: report.failures,
  }));
  if (report.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
