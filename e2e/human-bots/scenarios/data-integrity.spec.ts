import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// DataIntegrityBot: browser-level checks that scanning math + persistence are sound. (Idempotent sync /
// no-double-count on retries and ambiguous-normalized routing are also locked by unit/store tests; this
// is the real-UI companion.)

const PROOF = "e2e/proof/agent-bots/data-integrity";
const OUT = "reports/agent-bots/latest";

async function scan(page: Page, code: string) {
  const i = page.getByTestId("scanner-input");
  await i.click();
  await i.fill(code);
  await i.press("Enter");
  await page.waitForTimeout(150);
}

test("DataIntegrityBot: increment correctness, refresh persistence, unknown -> Needs Review", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });
  const checks: Array<{ check: string; pass: boolean; detail: string }> = [];

  await page.goto("/scan");

  // 1. Scan a known code twice -> qty increments by exactly 1 each time (legit repeats; no accidental double).
  await scan(page, "049000028904"); // seed Coca-Cola
  await scan(page, "049000028904");
  const cokeRow = page.getByTestId("final-count-body").locator("tr", { hasText: "Coca-Cola" }).first();
  const qtyText = (await cokeRow.innerText()).trim().split(/\s+/)[0];
  checks.push({ check: "two scans of one code -> qty 2 (no accidental double)", pass: qtyText === "2", detail: `qty=${qtyText}` });
  await page.screenshot({ path: `${PROOF}/01-counted.png`, fullPage: true });

  // 2. Refresh -> the count persists (local persistence).
  await page.reload();
  await page.waitForTimeout(300);
  const persisted = await page.getByTestId("final-count-body").locator("tr", { hasText: "Coca-Cola" }).count();
  checks.push({ check: "count persists after refresh", pass: persisted > 0, detail: `coke rows after reload=${persisted}` });

  // 3. An unknown code goes to Needs Review (never auto-resolved to a wrong product).
  await scan(page, "999000111222");
  const feedRow = page.getByTestId("scan-feed-body").locator("tr", { hasText: "999000111222" }).first();
  const feedText = (await feedRow.innerText()).toLowerCase();
  checks.push({ check: "unknown code -> Needs Review (not auto-resolved)", pass: /needs review|unknown/.test(feedText), detail: feedText.slice(0, 80) });
  await page.screenshot({ path: `${PROOF}/02-unknown.png`, fullPage: true });

  const allPass = checks.every((c) => c.pass);
  writeFileSync(
    resolve(process.cwd(), `${OUT}/data_integrity_report.md`),
    `# DataIntegrityBot report\n\nAll pass: **${allPass}**\n\n| check | result | detail |\n|-------|--------|--------|\n${checks.map((c) => `| ${c.check} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail} |`).join("\n")}\n\n> Idempotent sync (no double-count on network retries), exact-alias-wins, and ambiguous-normalized -> Needs Review are additionally locked by unit/store tests (multiCodeResolution, multiCodeCapture, mismatchGuard, aliasRepair). Screenshots: ${PROOF}/\n`,
  );

  for (const c of checks) expect(c.pass, c.check).toBe(true);
});
