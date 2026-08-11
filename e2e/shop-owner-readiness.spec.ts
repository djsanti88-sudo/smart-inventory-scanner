import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, type Page } from "./fixtures";

const PROOF = "e2e/proof/shop-owner-readiness";
const IMPORT_FIXTURES = path.join(__dirname, "..", "src", "services", "import", "__fixtures__");

const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  geminiConfigured: false,
  openaiConfigured: false,
  mode: "off",
  missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
  e2e: true,
};

type UploadPayload = string | { name: string; mimeType: string; buffer: Buffer };

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
}

async function guardLocalNetwork(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/ai-lookup", async (route) => {
    requests.push(`${route.request().method()} ${route.request().url()}`);
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: { status: "blocked-by-readiness-test" } });
  });
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  return requests;
}

async function uploadUniversalImport(page: Page, file: UploadPayload) {
  await page.goto("/products");
  await expect(page.getByTestId("universal-import-panel")).toBeVisible();
  await page.getByTestId("universal-import-file").setInputFiles(file);
  await expect(page.getByTestId("import-preview")).toBeVisible();
  await expect(page.getByTestId("import-headline")).toContainText(/Matched \d+ of \d+ automatically/);
}

function importCases() {
  const xlsxBytes = Buffer.from(readFileSync(path.join(IMPORT_FIXTURES, "generic.xlsx.base64.txt"), "utf8").trim(), "base64");
  return [
    { label: "csv", file: path.join(IMPORT_FIXTURES, "shopware.csv") },
    { label: "tsv", file: path.join(IMPORT_FIXTURES, "reordered-renamed.tsv") },
    {
      label: "semicolon",
      file: {
        name: "shop-owner-semicolon.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("Part Number;Brand;Description;Size;Qty\n28030703;Falken;Wildpeak A/T3W;LT275/70R18;2\n"),
      },
    },
    {
      label: "xlsx",
      file: {
        name: "shop-owner-generic.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: xlsxBytes,
      },
    },
  ] as const;
}

test("shop-owner browser import matrix drives CSV TSV semicolon and XLSX through the UI @shop-owner:import-format-ui-matrix", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  const requests = await guardLocalNetwork(page);
  const start = Date.now();
  await signIn(page);

  for (const entry of importCases()) {
    await uploadUniversalImport(page, entry.file);
    await page.screenshot({ path: `${PROOF}/import-${entry.label}.png`, fullPage: true });
  }

  const elapsedMs = Date.now() - start;
  expect(elapsedMs).toBeLessThan(30_000);
  expect(requests.filter((request) => request.includes("/api/ai-lookup") && request.startsWith("POST "))).toEqual([]);
});

test("shop-owner downloaded CSV XLSX PDF and HTML remain parseable after a new browser context @shop-owner:download-restart-parse", async ({ browser, page }) => {
  mkdirSync(PROOF, { recursive: true });
  await signIn(page);
  await page.getByTestId("export-menu-trigger").click();
  await expect(page.getByTestId("export-menu")).toBeVisible();

  const downloads: Record<string, string> = {};
  for (const [format, testId, filename] of [
    ["csv", "export-products", "products.csv"],
    ["xlsx", "export-products-xlsx", "products.xlsx"],
    ["pdf", "export-products-pdf", "products.pdf"],
    ["html", "export-products-html", "products.html"],
  ] as const) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId(testId).click(),
    ]);
    expect(download.suggestedFilename()).toBe(filename);
    downloads[format] = path.join(PROOF, filename);
    await download.saveAs(downloads[format]);
    expect(statSync(downloads[format]).size).toBeGreaterThan(100);
  }

  const csv = readFileSync(downloads.csv, "utf8");
  expect(csv).toContain("name");
  expect(csv.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(1);

  const ExcelJS = await import("exceljs");
  const { Workbook } = (ExcelJS.default ?? ExcelJS) as typeof import("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.readFile(downloads.xlsx);
  expect(workbook.worksheets[0].rowCount).toBeGreaterThan(1);

  const pdfBytes = readFileSync(downloads.pdf);
  expect(pdfBytes.subarray(0, 4).toString("utf8")).toBe("%PDF");

  const restarted = await browser.newContext();
  try {
    const restartedPage = await restarted.newPage();
    await restartedPage.goto(pathToFileURL(path.resolve(downloads.html)).href);
    await expect(restartedPage.getByPlaceholder("Search...")).toBeVisible();
    await expect(restartedPage.locator("table tbody tr").first()).toBeVisible();
    await restartedPage.screenshot({ path: `${PROOF}/download-html-after-context-restart.png`, fullPage: true });
  } finally {
    await restarted.close();
  }
});
