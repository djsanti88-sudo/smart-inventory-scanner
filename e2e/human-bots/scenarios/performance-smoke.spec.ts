import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// PerformanceBot: lightweight smoke only (no load testing, no cloud spam). Measures load + scan
// responsiveness, and checks the customer browser isn't carrying a huge local DB payload.

const PROOF = "e2e/proof/agent-bots/performance";
const OUT = "reports/agent-bots/latest";

async function scan(page: Page, code: string) {
  const i = page.getByTestId("scanner-input");
  await i.click(); await i.fill(code); await i.press("Enter");
}

test("PerformanceBot: load + scan responsiveness + local payload smoke", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });

  const t0 = Date.now();
  await page.goto("/scan");
  await page.getByTestId("scanner-input").waitFor({ state: "visible" });
  const loadMs = Date.now() - t0;

  const s0 = Date.now();
  await scan(page, "049000028904");
  await page.getByTestId("scan-feed-body").locator("tr", { hasText: "Coca-Cola" }).first().waitFor({ timeout: 5000 });
  const scanMs = Date.now() - s0;

  const localStorageBytes = await page.evaluate(() => {
    let total = 0;
    for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k)!; total += (localStorage.getItem(key) || "").length + key.length; }
    return total;
  });
  await page.screenshot({ path: `${PROOF}/perf.png`, fullPage: true });

  const checks = [
    { metric: "scan page load (ms)", value: loadMs, budget: 8000, pass: loadMs < 8000 },
    { metric: "scan -> feed row (ms)", value: scanMs, budget: 3000, pass: scanMs < 3000 },
    { metric: "localStorage size (bytes)", value: localStorageBytes, budget: 2_000_000, pass: localStorageBytes < 2_000_000 },
  ];
  writeFileSync(
    resolve(process.cwd(), `${OUT}/performance_smoke.md`),
    `# PerformanceBot smoke\n\n| metric | value | budget | result |\n|--------|------:|------:|--------|\n${checks.map((c) => `| ${c.metric} | ${c.value} | ${c.budget} | ${c.pass ? "PASS" : "WARN"} |`).join("\n")}\n\n> Note: today the local store includes the alias/catalog DB (a correctness + security concern flagged by\n> SecurityLeakBot). As the catalog grows, localStorage size will grow with it - another reason the deferred\n> server-side customer resolution matters. Screenshots: ${PROOF}/\n`,
  );
});
