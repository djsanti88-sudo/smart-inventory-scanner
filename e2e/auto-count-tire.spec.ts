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
  // Poison: WEAK/unverified exact-code evidence (go-upc url_only, not app-verified) - the firewall must
  // block the non-tire product. owner-ratified 2026-07-14: advisory-when-app-verified (fixture migrated
  // to real weak evidence shape) - the real EvidenceVerifier never marks a go-upc url_only source
  // app-verified (go-upc is the canonical poison source, not a trusted host). Assertions unchanged.
  "745125495781": {
    providerNames: ["gemini"],
    results: [r({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", category: "Hardware", upc: "745125495781", sourceUrls: ["https://go-upc.com/745125495781"] })],
    decision: { status: "suggested", confidence: 0.6, reason: "(poisoned source)", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
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
  // NOTE: the category selector is hidden (SHOW_CATEGORY = false in scan/page.tsx, owner request
  // aeb3218 2026-06-25) - scanning is category-agnostic now, so there is no "scan-category" control
  // to assert on. See CLAUDE.md "Aggressive Auto Decode Mode".
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

  // 2. Scan the poison -> the context-conflict firewall blocks the VERIFIED/auto-verify path (owner
  //    rule "decode-everything", e81d716 2026-07-01: provisional counting is never blocked, so the
  //    rivet kit still shows up as its own provisional row - it just never becomes a verified,
  //    permanently-aliased identity, and the tire row's own count is untouched).
  await scan(page, "745125495781");
  await expect(page.locator('[data-testid^="count-row-"]', { hasText: "Discoverer" })).toHaveCount(1); // tire count unaffected
  const poisonRow = page.locator('[data-testid^="count-row-"]', { hasText: "Manstel" });
  await expect(poisonRow).toBeVisible();
  await expect(poisonRow.locator("td").nth(0)).toHaveText("1");

  // 3. The poison sits in Needs Review (routed, never auto-verified/permanently aliased).
  await page.goto("/review");
  const poisonReview = page.getByTestId("review-row-745125495781");
  await expect(poisonReview).toBeVisible();
  await expect(poisonReview).toContainText(/category conflict/i);
  await page.screenshot({ path: `${PROOF}/auto-count-tire-02-poison-review.png`, fullPage: true });
});
