import { test, expect, type Page } from "@playwright/test";

// Regression proof for the real UI bug: a single-provider, Tier-3 (barcode DB) decode that the app
// independently verified (exact code in strong evidence) must show the PRODUCT and count it - never
// "Verified AI Decode + Product '-' + Unknown". Mocked decode (IS_E2E + page.route), no live tokens.

const PROOF = "e2e/proof";
const CODE_A = "7705471100046";
const CODE_B = "816218028015";
const CODE_NONAME = "000000000000"; // exact evidence but no usable product identity

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, mode: "aggressive", dailyLimit: 100, missingKeys: [], e2e: true,
};

// Single provider, Tier-3 source (upcitemdb), app-confirmed exact evidence - the exact failure shape.
const verifiedSingleTier3 = (code: string, name: string) => ({
  mode: "decode", providerNames: ["gpt-5.4-mini"],
  results: [{
    productName: name, brand: "TestBrand", category: "General", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: code, gtin: "", upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: ["https://www.upcitemdb.com/upc/" + code], confidence: 0.9, verifiedFacts: [], guesses: [],
  }],
  evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["https://www.upcitemdb.com/upc/" + code], reason: "" }],
  decision: {
    status: "verified", confidence: 0.9,
    reason: "Verified AI Decode: single provider, but the app independently confirmed the exact code in strong evidence.",
    evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "single_provider", confidence: 0.9, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  timedOut: false, debug: {},
});

// Exact evidence but NO usable product name.
const verifiedNoName = (code: string) => {
  const r = verifiedSingleTier3(code, "");
  return r;
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("verified single-provider Tier-3 decode shows product + counts (never Verified Unknown)", async ({ page }) => {
  let decodePosts = 0;
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: STATUS });
    decodePosts++;
    const body = JSON.parse(route.request().postData() || "{}");
    const code = body.cleanCode || body.rawCode || "";
    if (code === CODE_NONAME) return route.fulfill({ json: verifiedNoName(code) });
    return route.fulfill({ json: verifiedSingleTier3(code, code === CODE_A ? "Producto Test 770" : "Producto Test 816") });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");

  // CODE_A: auto-verifies -> product shows in the Final Count, NOT Unknown.
  await scan(page, CODE_A);
  await expect(page.getByTestId("final-count-body")).toContainText("Producto Test 770");
  expect(decodePosts).toBe(1);

  // CODE_B: same.
  await scan(page, CODE_B);
  await expect(page.getByTestId("final-count-body")).toContainText("Producto Test 816");
  expect(decodePosts).toBe(2);

  // Catalog learned them as verified.
  await page.goto("/settings");
  await expect(page.getByTestId("catalog-status")).not.toHaveText("0");

  // Second scan of CODE_A resolves with NO new AI call.
  await page.goto("/scan");
  const before = decodePosts;
  await scan(page, CODE_A);
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  expect(decodePosts).toBe(before);
  await page.screenshot({ path: `${PROOF}/verified-decode-not-unknown.png`, fullPage: true });

  // Bad case: exact evidence but no usable name -> Needs Review with a clear reason (not Verified Unknown).
  await scan(page, CODE_NONAME);
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${CODE_NONAME}`)).toBeVisible();
  await expect(page.getByTestId(`review-row-${CODE_NONAME}`)).toContainText("no usable product identity");
});
