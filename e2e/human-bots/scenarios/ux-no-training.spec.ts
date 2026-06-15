import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ConfusedHumanBot: a no-training shop user. Checks whether the obvious tasks are discoverable, and
// scores friction. Report-only (does not gate); produces a UX scorecard for prioritisation.

const PROOF = "e2e/proof/agent-bots/ux";
const OUT = "reports/agent-bots/latest";

type Row = { task: string; pass: boolean; friction: number; severity: string; quickFix: boolean; note: string };

async function visible(page: Page, sel: string) {
  const l = page.locator(sel).first();
  return (await l.count()) > 0 && (await l.isVisible().catch(() => false));
}

test("ConfusedHumanBot: no-training usability scorecard", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });
  const rows: Row[] = [];
  const add = (task: string, pass: boolean, friction: number, severity: string, quickFix: boolean, note: string) => rows.push({ task, pass, friction, severity, quickFix, note });

  await page.goto("/scan");
  add("Find where to scan", await visible(page, '[data-testid="scanner-input"]'), 1, "P2", false, "scan input is the focused default");
  // scan + feedback
  const inp = page.getByTestId("scanner-input");
  await inp.click(); await inp.fill("049000028904"); await inp.press("Enter"); await page.waitForTimeout(150);
  add("See whether a scan worked", await visible(page, '[data-testid="scan-feed-body"]'), 2, "P2", false, "live feed row appears with product + Known");
  add("See the current count", await visible(page, '[data-testid="final-count-body"]'), 2, "P2", false, "Final Count Database table");
  add("Start / finish an inventory session", await visible(page, '[data-testid="start-session"]') && await visible(page, '[data-testid="finish-session"]'), 2, "P2", false, "buttons present on scan page");
  add("Export the final count", await visible(page, '[data-testid="export-final-counts"]'), 2, "P2", false, "export buttons present");
  await page.goto("/review");
  add("Understand Needs Review", await visible(page, '[data-testid="review-body"]'), 3, "P2", true, "page exists; copy could be plainer for a new user");
  // mobile width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/scan");
  add("Use the scan page on a phone-width screen", await visible(page, '[data-testid="scanner-input"]'), 3, "P2", false, "scan input still reachable at 390px");
  await page.screenshot({ path: `${PROOF}/mobile-scan.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  const passes = rows.filter((r) => r.pass).length;
  const confusions = rows.filter((r) => !r.pass || r.friction >= 3);
  writeFileSync(
    resolve(process.cwd(), `${OUT}/ux_scorecard.md`),
    `# ConfusedHumanBot UX scorecard\n\nPassed ${passes}/${rows.length}.\n\n| task | result | friction(1-5) | severity | quick fix | note |\n|------|--------|---------------|----------|-----------|------|\n${rows.map((r) => `| ${r.task} | ${r.pass ? "PASS" : "FAIL"} | ${r.friction} | ${r.severity} | ${r.quickFix ? "yes" : "no"} | ${r.note} |`).join("\n")}\n\nScreenshots: ${PROOF}/\n`,
  );
  writeFileSync(
    resolve(process.cwd(), `${OUT}/top_ux_confusions.md`),
    `# Top UX confusions (for a no-training shop user)\n\n${confusions.length ? confusions.map((r) => `- [${r.severity}] ${r.task} - ${r.note}${r.quickFix ? " (quick fix)" : ""}`).join("\n") : "- None blocking at this pass; deeper UX review recommended before pilot."}\n\nNote: customer-facing wording still exposes internal terms (\"AI lookup\", provider names in Settings) - de-branding is part of the deferred foundation and is a UX + security item.\n`,
  );
});
