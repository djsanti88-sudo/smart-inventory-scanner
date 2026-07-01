import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FALKEN_PRODUCT_NAME, CAMEL_PRODUCT_NAME, FALKEN_PART_NUMBER_VARIANTS, FALKEN_BARCODE } from "../fixtures/known-codes";

// PlatformOwnerBot — the CRITICAL proof. Pastes the Falken part number in every separator shape into the
// real scan input and reads the result from the UI. The headline question: does 2881-6861 (or any shape)
// still resolve to Camel Crush Menthol Silver Cigarettes? Screenshots + a JSON result are written for proof.

const PROOF = "e2e/proof/human-bots/tire-resolution";
const OUT = "reports/human-bots/latest";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
  await page.waitForTimeout(150); // let the optimistic UI settle
}

// Read the MOST RECENT feed row (top; feed prepends) and classify what it resolved to. Role-agnostic:
// classifies by the visible Product column (raw/clean code columns are hidden from customer roles).
async function classifyResult(page: Page, _cleanCode: string): Promise<{ product: string; status: string; rowText: string }> {
  const row = page.getByTestId("scan-feed-body").locator("tr").first();
  const rowText = (await row.count()) ? ((await row.innerText()).replace(/\s+/g, " ").trim()) : "(no feed row)";
  const lower = rowText.toLowerCase();
  let product = "(none)";
  if (lower.includes("falken")) product = "Falken";
  else if (lower.includes("camel")) product = "Camel";
  const status = /counted/.test(lower) ? "known" : /needs review|not recognised|conflict/.test(lower) ? "needs_review" : "other";
  return { product, status, rowText };
}

test("PlatformOwnerBot: Falken part number never resolves to Camel (every separator shape)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });

  await page.goto("/scan");
  await expect(page.getByTestId("scanner-input")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/00-scan-page.png`, fullPage: true });

  // Baseline: the seed catalog must NOT contain any Camel product (so a Camel resolution can only come
  // from a real bug, never seed data).
  await expect(page.locator("body")).not.toContainText(CAMEL_PRODUCT_NAME);

  const results: Array<{ code: string; label: string; product: string; status: string; resolvedToCamel: boolean; rowText: string }> = [];

  // 1. The retail barcode (sanity: resolves to Falken).
  await scan(page, FALKEN_BARCODE);
  const barcodeRes = await classifyResult(page, FALKEN_BARCODE);
  await page.screenshot({ path: `${PROOF}/01-barcode.png`, fullPage: true });
  results.push({ code: FALKEN_BARCODE, label: "retail barcode", ...barcodeRes, resolvedToCamel: barcodeRes.product === "Camel" });

  // 2. The part number in every separator shape.
  for (let i = 0; i < FALKEN_PART_NUMBER_VARIANTS.length; i++) {
    const { code, label } = FALKEN_PART_NUMBER_VARIANTS[i];
    await scan(page, code);
    const cleanForRow = code.replace(/ /g, " ").trim();
    const res = await classifyResult(page, cleanForRow);
    await page.screenshot({ path: `${PROOF}/02-variant-${i}-${code.replace(/[^a-z0-9]/gi, "_")}.png`, fullPage: true });
    results.push({ code, label, ...res, resolvedToCamel: res.product === "Camel" });
  }

  // ---- write the proof artifact ----
  const headline = {
    question: "Does the Falken part number resolve to Camel Crush Menthol Silver Cigarettes?",
    resolvedToCamelAnywhere: results.some((r) => r.resolvedToCamel),
    dashed: results.find((r) => r.code === "2881-6861"),
    noDash: results.find((r) => r.code === "28816861"),
    results,
  };
  writeFileSync(resolve(process.cwd(), `${OUT}/tire_resolution_result.json`), JSON.stringify(headline, null, 2) + "\n");

  // ---- HARD assertions ----
  // (a) Nothing ever resolves to Camel.
  for (const r of results) {
    expect(r.product, `${r.code} (${r.label}) must NOT resolve to Camel`).not.toBe("Camel");
  }
  // (b) EVERY separator shape of the part number resolves to the correct Falken tire (Known) - dashed,
  //     no-dash, space, AND slash (the slash case was a real gap the bot caught and we then fixed).
  for (const v of FALKEN_PART_NUMBER_VARIANTS) {
    expect(results.find((r) => r.code === v.code)?.product, `${v.code} (${v.label}) should resolve to Falken`).toBe("Falken");
  }
  // (c) The final count shows the Falken tire and never a Camel product.
  await expect(page.getByTestId("final-count-body")).toContainText(FALKEN_PRODUCT_NAME);
  await expect(page.getByTestId("final-count-body")).not.toContainText("Camel");
});
