import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ManagerBot: checks whether the app gives a shop manager the operational pieces they expect. Reports
// present vs missing and classifies missing items. Report-only (does not invent features).

const PROOF = "e2e/proof/agent-bots/manager";
const OUT = "reports/agent-bots/latest";

async function present(page: Page, sel: string) {
  return (await page.locator(sel).first().count()) > 0;
}

test("ManagerBot: shop-manager workflow coverage", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });

  await page.goto("/scan");
  const i = page.getByTestId("scanner-input");
  await i.click(); await i.fill("049000028904"); await i.press("Enter"); await page.waitForTimeout(150);

  const items: Array<{ feature: string; present: boolean; classify: string }> = [];
  const check = async (feature: string, sel: string, classifyIfMissing: string) =>
    items.push({ feature, present: await present(page, sel), classify: classifyIfMissing });

  await check("Latest scans / scan log (live feed)", '[data-testid="scan-feed-body"]', "");
  await check("Current inventory count (final count table)", '[data-testid="final-count-body"]', "");
  await check("Start/finish inventory session", '[data-testid="finish-session"]', "");
  await check("Export final count", '[data-testid="export-final-counts"]', "");
  await check("Export raw scan log", '[data-testid="export-raw-log"]', "");
  await page.goto("/review");
  await check("Needs Review queue", '[data-testid="review-body"]', "");
  await page.goto("/products");
  await check("Product database", '[data-testid="products-body"]', "");
  await check("Alias repair (Codes panel - platformOwner-scope today)", '[data-testid^="manage-codes-"]', "");
  await page.screenshot({ path: `${PROOF}/manager.png`, fullPage: true });

  // Known-missing manager features (do not invent UI; report honestly).
  const missing = [
    { feature: "Who scanned what (per-user attribution in the feed)", classify: "important soon" },
    { feature: "Finished-sessions history list", classify: "important soon" },
    { feature: "Product search / filter on Products page", classify: "important soon" },
    { feature: "Products missing barcode / missing part number views", classify: "nice to have" },
    { feature: "Recently created / recently repaired lists", classify: "nice to have" },
    { feature: "Audit history viewer (audit is written; no UI)", classify: "important soon" },
    { feature: "Low-stock / overstock & stock-target memory", classify: "paid add-on candidate" },
    { feature: "Multi-location inventory", classify: "future enterprise feature" },
    { feature: "Part-number-only CSV import + enrichment", classify: "paid add-on candidate (deferred)" },
  ];

  const presentList = items.filter((x) => x.present).map((x) => x.feature);
  const absentList = items.filter((x) => !x.present).map((x) => x.feature);
  writeFileSync(
    resolve(process.cwd(), `${OUT}/manager_insights.md`),
    `# ManagerBot insights\n\n## Present today\n${presentList.map((f) => `- ${f}`).join("\n") || "- (none)"}\n\n## Present-check came back absent\n${absentList.map((f) => `- ${f}`).join("\n") || "- (none)"}\n\n## Missing but recommended (classified)\n${missing.map((m) => `- [${m.classify}] ${m.feature}`).join("\n")}\n\n> Critical-before-pilot: the customer/role data-protection foundation (so managers/employees don't see\n> the raw code DB) - tracked in docs/HOTFIX_FOLLOWUPS.md. Screenshots: ${PROOF}/\n`,
  );
});
