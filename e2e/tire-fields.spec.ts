import { test, expect, type Page, type Route } from "@playwright/test";

// Phase 10 proof: a decoded TIRE fills Size (Specs) / Brand / Part number with a CLEAN description,
// instead of dumping the raw blob into one cell. Also proves "blank, not fabricated": a tire with no
// SKU shows "-" for Part number rather than an invented one. All provider traffic is mocked.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, mode: "aggressive",
  dailyLimit: 100, missingKeys: [], e2e: true,
};

function result(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.95, needsHumanReview: false, ...over,
  };
}

const verified = (reason: string) => ({
  status: "verified", confidence: 0.96, reason, evidenceStrength: "snippet",
  exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" },
});

const DECODE: Record<string, object> = {
  // Messy blob: brand + size + load/speed all jammed into the name. Has a SKU.
  "745125495781": {
    providerNames: ["gpt-5.4-mini"], premiumUsed: false,
    results: [result({
      productName: "MICHELIN DEFENDER LTX M/S 235/65R18 104H BSW",
      brand: "Michelin", specsShort: "235/65R18 104H", primarySku: "MICH-99812",
      upc: "745125495781", sourceUrls: ["https://gs1.org/745125495781"],
    })],
    decision: verified("Verified AI Decode: providers agree, code confirmed."),
  },
  // Real tire, full specs, but NO SKU -> Part number must be blank ("-"), never invented.
  "036625112231": {
    providerNames: ["gpt-5.4-mini"], premiumUsed: false,
    results: [result({
      productName: "Falken Wildpeak AT3W 275/55R20 113T",
      brand: "Falken", specsShort: "275/55R20 113T",
      upc: "036625112231", sourceUrls: ["https://gs1.org/036625112231"],
    })],
    decision: verified("Verified AI Decode: providers agree, code confirmed."),
  },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("decoded tire fills Size / Brand / Part number with a clean description", async ({ page }) => {
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

  // Tire A: messy blob decodes + auto-counts with STRUCTURED columns.
  await scan(page, "745125495781");
  const rowA = page.locator('[data-testid^="count-row-"]', { hasText: "Defender" });
  await expect(rowA).toBeVisible();
  await expect(rowA.locator("td").nth(1)).toContainText("DEFENDER LTX M/S BSW"); // clean description
  await expect(rowA.locator("td").nth(1)).not.toContainText("235/65R18"); // size NOT dumped in the name cell
  await expect(rowA.locator("td").nth(2)).toContainText("Michelin"); // brand
  // Column index +1 vs pre-Task-4: a Model column was inserted between Brand and Category.
  // Column index +1 again (fc2188a, 2026-07-01, predates this test's last update): a plain-digits
  // "Size" column was inserted between Specs and Part number (Image column dropped elsewhere, net
  // column count unchanged - see FinalCountTable.tsx header order).
  // c4174f2 (2026-07-09): the Size cell now shows the canonical size ("235/65R18"), not the
  // digit-mash - the digit-mash moved to the cell's title attribute instead. Column index unchanged.
  await expect(rowA.locator("td").nth(5)).toContainText("235/65R18 104H"); // size in Specs
  await expect(rowA.locator("td").nth(6)).toContainText("235/65R18"); // canonical Size column
  await expect(rowA.locator("td").nth(7)).toContainText("MICH-99812"); // part number

  // Tire B: real tire, NO SKU -> Part number blank ("-"), not fabricated.
  await scan(page, "036625112231");
  const rowB = page.locator('[data-testid^="count-row-"]', { hasText: "Wildpeak" });
  await expect(rowB).toBeVisible();
  await expect(rowB.locator("td").nth(2)).toContainText("Falken");
  await expect(rowB.locator("td").nth(5)).toContainText("275/55R20 113T");
  await expect(rowB.locator("td").nth(7)).toHaveText("-"); // blank, NOT an invented part number

  await page.screenshot({ path: `${PROOF}/tire-fields.png`, fullPage: true });
});
