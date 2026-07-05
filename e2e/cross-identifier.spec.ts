import { test, expect, type Page, type Route } from "@playwright/test";

// Cross-identifier proof: scan a UPC -> tire auto-counts (columns filled from confirmed data). The decode
// also surfaced an EXTRA identifier (a part number) as a DISCOVERED suggestion - it is NOT trusted until
// the human approves it with one click. After approval, scanning the part number counts the SAME product
// (qty -> 2). All provider traffic mocked.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, premiumFallback: true, mode: "aggressive",
  dailyLimit: 100, missingKeys: [], e2e: true,
};

function result(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.96, needsHumanReview: false, ...over,
  };
}

const DECODE: Record<string, object> = {
  "745125495781": {
    providerNames: ["gemini", "openai"], premiumUsed: false,
    results: [result({
      productName: "Falken Wildpeak AT3W 275/55R20 113T", brand: "Falken", specsShort: "275/55R20 113T",
      upc: "745125495781", aliases: ["PNQR7788"], // <-- extra identifier surfaced by the decode (discovered)
      sourceUrls: ["https://gs1.org/745125495781"],
    })],
    decision: {
      status: "verified", confidence: 0.96, reason: "Verified AI Decode: providers agree, code confirmed.",
      evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" },
    },
  },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("discovered part number: approve, then it counts the same product as the UPC", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: STATUS });
    const body = JSON.parse(req.postData() || "{}");
    return route.fulfill({ json: DECODE[body.cleanCode as string] ?? {} });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  // 1. Scan the UPC -> tire auto-counts with columns filled; the part number appears as DISCOVERED.
  await scan(page, "745125495781");
  const row = page.locator('[data-testid^="count-row-"]', { hasText: "Wildpeak" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(0)).toHaveText("1"); // qty 1
  await expect(row.locator("td").nth(2)).toContainText("Falken"); // brand from confirmed data
  // Column index +1 vs pre-Task-4: a Model column was inserted between Brand and Category.
  await expect(row.locator("td").nth(5)).toContainText("275/55R20 113T"); // specs (size)
  const approveBtn = row.locator('[data-testid^="approve-discovered-"]');
  await expect(approveBtn).toBeVisible(); // discovered part number offered, NOT yet trusted
  await page.screenshot({ path: `${PROOF}/cross-identifier-01-discovered.png`, fullPage: true });

  // 2. One-click approve the discovered part number.
  await approveBtn.click();
  await expect(approveBtn).toHaveCount(0); // approved -> no longer a discovered suggestion

  // 3. Scanning the part number now counts the SAME product (qty -> 2), no duplicate row.
  await scan(page, "PNQR7788");
  await expect(row.locator("td").nth(0)).toHaveText("2");
  await expect(page.locator('[data-testid^="count-row-"]', { hasText: "Wildpeak" })).toHaveCount(1);
  await page.screenshot({ path: `${PROOF}/cross-identifier-02-counted.png`, fullPage: true });
});
