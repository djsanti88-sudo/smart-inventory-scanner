import { test, expect, type Page } from "./fixtures";
import { mkdirSync, readFileSync } from "node:fs";

// Historical coverage gap 4/G1-G2 (see docs/HISTORY.md): the existing
// e2e/human-bots/scenarios/export-leak.spec.ts only reads CSV HEADERS and is report-only (writes a
// markdown report, never fails the run). This spec parses the real exported CSV ROWS and hard-asserts
// them 1:1 against the store's own finalCounts, and hard-fails the run if a private field (unit cost)
// ever leaks into the export - in the header OR in any cell value.

const PROOF = "e2e/proof/export-content-correctness";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false, mode: "off",
  dailyLimit: 200, missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

async function stubAiLookup(page: Page) {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

// Minimal RFC-4180 CSV parser matching src/reports/export/exportFormats.ts's parseCsv (BOM + CRLF + quoting) -
// reimplemented locally since e2e specs do not resolve the app's `@/` path alias.
const BOM = "﻿";
function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const text = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); records.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  const headers = records.shift() ?? [];
  return { headers, rows: records };
}

type StoreCount = { productId: string; quantity: number };
type StoreProduct = { id: string; name: string };
type StoreHandle = {
  getState: () => {
    finalCounts: StoreCount[];
    products: StoreProduct[];
    correctProduct: (id: string, fields: Record<string, unknown>) => void;
  };
};

async function readStore(page: Page): Promise<{ finalCounts: StoreCount[]; products: StoreProduct[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __scanStore: StoreHandle };
    const s = w.__scanStore.getState();
    return { finalCounts: s.finalCounts, products: s.products };
  });
}

test("exported final-counts CSV matches store quantities row-for-row and never leaks unit cost", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  await stubAiLookup(page);
  await login(page);

  // A known mix: 3 distinct seeded products at 3 distinct quantities.
  await scan(page, "6419440485331"); // Nokian
  await scan(page, "6419440485331");
  await scan(page, "6419440485331"); // -> qty 3
  await scan(page, "049000028904"); // Coca-Cola
  await scan(page, "049000028904"); // -> qty 2
  await scan(page, "848983012906"); // Falken -> qty 1

  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("3");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");

  // Plant a distinctive, unmistakable PRIVATE unit-cost value on one counted product via the app's own
  // correctProduct action (the same call FinalCountTable's cost input makes, src/components/
  // FinalCountTable.tsx:427-432) - proves the export excludes a real private VALUE, not merely an
  // absent example.
  const PRIVATE_COST_MARKER = "137.42";
  await page.evaluate((cost) => {
    const w = window as unknown as { __scanStore: StoreHandle };
    w.__scanStore.getState().correctProduct("prod-nokian", { unitCost: Number(cost) });
  }, PRIVATE_COST_MARKER);

  const store = await readStore(page);
  const expectedByName = new Map<string, number>();
  for (const c of store.finalCounts) {
    const p = store.products.find((pr) => pr.id === c.productId);
    if (!p) continue;
    expectedByName.set(p.name, (expectedByName.get(p.name) ?? 0) + c.quantity);
  }
  expect(expectedByName.size, "expected exactly 3 distinct counted products").toBe(3);

  await page.getByTestId("export-menu-trigger").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-final-counts").click(),
  ]);
  const path = `${PROOF}/final-counts.csv`;
  await download.saveAs(path);
  const csvText = readFileSync(path, "utf-8");

  const { headers, rows } = parseCsv(csvText);

  // Row count == number of distinct products counted.
  expect(rows.length, "exported row count must equal the number of distinct counted products").toBe(expectedByName.size);

  const qtyIdx = headers.indexOf("quantity");
  const nameIdx = headers.indexOf("product_name");
  expect(qtyIdx).toBeGreaterThanOrEqual(0);
  expect(nameIdx).toBeGreaterThanOrEqual(0);

  const seenNames = new Set<string>();
  for (const row of rows) {
    const name = row[nameIdx];
    const qty = Number(row[qtyIdx]);
    expect(expectedByName.has(name), `unexpected product in export: "${name}"`).toBe(true);
    expect(qty, `exported quantity for "${name}" must equal the store's finalCounts`).toBe(expectedByName.get(name));
    seenNames.add(name);
  }
  expect(seenNames.size, "every expected product must appear exactly once").toBe(expectedByName.size);

  // No private field ever appears - not in the header, not in any cell value.
  const FORBIDDEN_HEADER_PATTERNS = [/unit.?cost/i, /\bcost\b/i, /\bprice\b/i, /\bmargin\b/i];
  for (const h of headers) {
    for (const pattern of FORBIDDEN_HEADER_PATTERNS) {
      expect(h, `forbidden header "${h}" matched ${pattern}`).not.toMatch(pattern);
    }
  }
  for (const cell of rows.flat()) {
    expect(cell, `private unit-cost value leaked into an export cell: "${cell}"`).not.toContain(PRIVATE_COST_MARKER);
  }
  expect(csvText, "private unit-cost value must never appear anywhere in the exported CSV").not.toContain(PRIVATE_COST_MARKER);

  await page.screenshot({ path: `${PROOF}/export-content-correctness.png`, fullPage: true });
});
