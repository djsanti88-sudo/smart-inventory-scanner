import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// RegressionBot (LIVE CLOUD) — the proof that was missing. Logs into Santiago's REAL god account, selects
// the real business, and pastes the Falken part number in every shape. Hard-fails if ANY shape resolves
// to Camel Crush Menthol Silver Cigarettes. This validates the exact data Santiago uses, not seed fixtures.
//
// Skips itself (does not false-pass) when creds are absent.

const EMAIL = process.env.GOD_EMAIL || "";
const PASSWORD = process.env.GOD_PASSWORD || "";
const BIZ = process.env.GOD_BUSINESS_ID || "biz-nDPz45mqDMaaucovnl4y5v5vhSH3";
const PROOF = "e2e/proof/human-bots/cloud";
const OUT = "reports/human-bots/latest";
const VARIANTS = ["2881-6861", "28816861", "2881 6861", "2881/6861"];

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
  await page.waitForTimeout(400); // cloud sync is async
}

test.skip(!EMAIL || !PASSWORD, "GOD_EMAIL / GOD_PASSWORD not set — live cloud regression skipped (not a pass).");

test("RegressionBot (live cloud): Falken part number must NOT resolve to Camel on the real god account", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });

  // Real login (no auth bypass).
  await page.goto("/login");
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan", { timeout: 30_000 });

  // Select the real business (loads its cloud catalog/aliases).
  await page.goto("/business");
  await page.getByTestId(`select-business-${BIZ}`).click();
  await page.waitForURL("**/scan", { timeout: 30_000 });
  await expect(page.getByTestId("scanner-input")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/00-context.png`, fullPage: true });

  const results: Array<{ code: string; rowText: string; resolvedToCamel: boolean; resolvedToFalken: boolean }> = [];
  for (let i = 0; i < VARIANTS.length; i++) {
    const code = VARIANTS[i];
    await scan(page, code);
    // The MOST RECENT feed row is this scan's result (feed prepends). Read the top row.
    const row = page.getByTestId("scan-feed-body").locator("tr").first();
    const rowText = (await row.count()) ? (await row.innerText()).replace(/\s+/g, " ").trim() : "(no row)";
    await page.screenshot({ path: `${PROOF}/var-${i}.png`, fullPage: true });
    results.push({ code, rowText, resolvedToCamel: /camel/i.test(rowText), resolvedToFalken: /falken/i.test(rowText) });
  }

  writeFileSync(resolve(process.cwd(), `${OUT}/cloud_tire_resolution_result.json`), JSON.stringify({ business: BIZ, results, resolvedToCamelAnywhere: results.some((r) => r.resolvedToCamel) }, null, 2) + "\n");

  // HARD: no tire-code scan resolves to Camel. (The Camel PRODUCT may still exist as its own counted item;
  // that's fine - we only fixed the wrong tire->Camel alias.)
  for (const r of results) {
    expect(r.resolvedToCamel, `${r.code} must NOT resolve to Camel on the live account`).toBe(false);
    expect(r.resolvedToFalken, `${r.code} should resolve to the Falken tire on the live account`).toBe(true);
  }
});
