import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_TARGET = "http://localhost:3400";
const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  openaiConfigured: false,
  mode: "off",
  dailyLimit: 200,
  missingKeys: ["OPENAI_API_KEY"],
  e2e: true,
};

function parseArgs(argv) {
  const values = { target: DEFAULT_TARGET, output: "reports/fable5/manual/personas/metrics.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") values.target = argv[++index];
    else if (argument === "--output") values.output = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node e2e/persona-drive.mjs [--target http://localhost:3400] [--output metrics.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.target || !values.output) throw new Error("--target and --output need values");
  const target = new URL(values.target);
  if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname) || target.port !== "3400") {
    throw new Error("Persona driver is restricted to localhost port 3400");
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = resolve(process.cwd(), options.output);
  const screenshotsDir = resolve(dirname(outputPath), "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const metrics = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let currentFailures = [];
  page.on("pageerror", (error) => currentFailures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") currentFailures.push(`console error: ${message.text()}`);
  });
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: NO_AI_STATUS });
    else await route.fulfill({ status: 503, json: { error: "Persona proof keeps product lookup off" } });
  });

  async function flow(name, steps, action) {
    const screenshotPath = resolve(screenshotsDir, `${name}.png`);
    currentFailures = [];
    const started = performance.now();
    try {
      await action();
    } catch (error) {
      currentFailures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (error) {
      currentFailures.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`);
    }
    metrics.push({
      flow: name,
      ms: Math.round((performance.now() - started) * 100) / 100,
      steps,
      failures: [...currentFailures],
      screenshot: artifactPath(screenshotPath),
    });
  }

  try {
    await page.goto(`${options.target}/login`, { waitUntil: "domcontentloaded" });
    const loginButton = page.getByTestId("login-button");
    if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
    await page.waitForURL("**/scan");
    await page.waitForFunction(() => Boolean(window.__scanStore));
    await page.evaluate(() => {
      window.__scanStore.getState().updateSettings({ aiLookupEnabled: false, scanContext: "any" });
    });

    await flow("scan-known-x5", 5, async () => {
      for (let count = 0; count < 5; count += 1) await scan(page, "049000028904");
      await page.waitForFunction(() => window.__scanStore.getState().scanFeed.length === 5);
      const quantity = await page.evaluate(() =>
        window.__scanStore.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0),
      );
      if (quantity !== 5) throw new Error(`Expected 5 counted scans, found ${quantity}`);
    });

    await flow("scan-unknown", 1, async () => {
      await scan(page, "PERSONAUNKNOWN001");
      await page.waitForFunction(() => window.__scanStore.getState().scanFeed.length === 6);
      await page.getByTestId("scan-feed-body").getByText("PERSONAUNKNOWN001").first().waitFor();
    });

    await flow("resolve-needs-review", 4, async () => {
      await page.goto(`${options.target}/review`);
      const row = page.getByTestId("review-row-PERSONAUNKNOWN001");
      await row.waitFor();
      await row.getByLabel("link to product").selectOption({ label: "Coca-Cola 12 pack 12 oz cans" });
      await row.getByTestId("link-existing").click();
      await row.waitFor({ state: "detached" });
    });

    await flow("view-counts", 2, async () => {
      await page.goto(`${options.target}/scan`);
      const state = await page.evaluate(() => {
        const store = window.__scanStore.getState();
        return {
          scans: store.scanFeed.length,
          counted: store.finalCounts.reduce((sum, row) => sum + row.quantity, 0),
        };
      });
      if (state.scans !== 6 || state.counted !== 6) {
        throw new Error(`Expected 6 scans and 6 counted rows, found ${state.scans} and ${state.counted}`);
      }
      await page.getByTestId("final-count-body").waitFor();
    });

    await flow("export-csv", 2, async () => {
      await page.getByTestId("export-menu-trigger").click();
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("export-final-counts").click();
      const download = await downloadPromise;
      await download.saveAs(resolve(dirname(outputPath), "final-counts.csv"));
    });
  } finally {
    await writeFile(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    await context.close();
    await browser.close();
  }

  const failureCount = metrics.reduce((sum, metric) => sum + metric.failures.length, 0);
  console.log(JSON.stringify({ metrics: artifactPath(outputPath), flows: metrics.length, failures: failureCount }));
  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
