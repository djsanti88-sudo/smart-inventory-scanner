import { test, expect, type Page, type Route } from "@playwright/test";

// Live-scan auto-count proof: a deterministically-corroborated tire auto-counts on scan (no Needs Review
// detour), while the poisoned tire UPC (go-upc -> "Manstel rivet kit") is still blocked by the firewall
// and stays in review. All provider traffic mocked.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, premiumFallback: true, mode: "aggressive",
  dailyLimit: 100, missingKeys: [], e2e: true,
};

function r(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.92, needsHumanReview: false, ...over,
  };
}

const DECODE: Record<string, object> = {
  // Corroborated tire (strong prefix family 029142 = Cooper, full specs, app-verified code) -> verified.
  "029142712886": {
    providerNames: ["gemini"],
    results: [r({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", category: "Tire", specsShort: "LT245/75R16 120R", upc: "029142712886", sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"] })],
    decision: { status: "verified", confidence: 0.92, reason: "Verified AI Decode: tire corroborated by prefix family + specs.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
  },
  // Poison: even though the (mocked) model claims verified, the firewall must block the non-tire product.
  "745125495781": {
    providerNames: ["gemini"],
    results: [r({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", category: "Hardware", upc: "745125495781", sourceUrls: ["https://go-upc.com/745125495781"] })],
    decision: { status: "verified", confidence: 0.92, reason: "(poisoned source)", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
  },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("corroborated tire auto-counts on live scan; poison stays in Needs Review", async ({ page }) => {
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
  await expect(page.getByTestId("scan-category")).toHaveValue("tire"); // default tire context
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  // 1. Scan the corroborated tire -> AUTO-COUNTS (no manual approval), columns filled.
  await scan(page, "029142712886");
  const row = page.locator('[data-testid^="count-row-"]', { hasText: "Discoverer" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(0)).toHaveText("1"); // qty 1
  await expect(row.locator("td").nth(2)).toContainText("Cooper"); // brand
  // Column index +1 vs pre-Task-4: a Model column was inserted between Brand and Category.
  await expect(row.locator("td").nth(5)).toContainText("LT245/75R16 120R"); // specs
  await page.screenshot({ path: `${PROOF}/auto-count-tire-01-counted.png`, fullPage: true });

  // 2. Scan the poison -> firewall blocks it: NOT counted, no rivet identity anywhere on the page.
  await scan(page, "745125495781");
  await expect(page.getByTestId("final-count-body")).not.toContainText(/manstel|rivet/i);
  await expect(page.locator('[data-testid^="count-row-"]', { hasText: "Discoverer" })).toHaveCount(1); // only the tire

  // 3. The poison sits in Needs Review (routed, never auto-counted).
  await page.goto("/review");
  await expect(page.getByTestId("review-row-745125495781")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/auto-count-tire-02-poison-review.png`, fullPage: true });
});
