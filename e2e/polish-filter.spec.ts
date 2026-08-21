import { test, expect, type Page, type Route } from "./fixtures";

// Build 2 / Task 4: Playwright proof for the final-count table's Brand/Model/Size columns and the
// single "polish-filter" input. Follows e2e/gpt-decode-burst.spec.ts's pattern: the decode API is
// mocked (IS_E2E; zero live AI calls) with gpt-5.4-mini "verified" payloads so each scanned code
// auto-counts into its own product, whose structured fields (structuredBrand/structuredModel/
// sizeTag) are stamped by the deterministic hot path (scanStore.ts resolveUnknown create_new).
//
//   1. Three tire codes scan and auto-count, each with a distinct tire size.
//   2. Typing the FULL size ("2055516") narrows the table to exactly the one matching row.
//   3. Clearing and typing a shared PREFIX ("205") matches every row whose size starts with it.
// Screenshots: e2e/proof/polish/.

const PROOF = "e2e/proof/polish";

const AI_ON_STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, mode: "live",
  dailyLimit: 200, missingKeys: [], e2e: true,
  gptDecode: { spentTodayUsd: 0, capUsd: 3, callsToday: 0, enabled: true },
};

interface FixtureRow {
  code: string;
  productName: string;
  brand: string;
  specsShort: string;
}

// Two rows share the "205" size prefix; the third is a distinct "225" size, so the prefix filter
// proof has a real multi-row match and the exact-size filter proof has a real single-row match.
const ROWS: FixtureRow[] = [
  { code: "740000000104", productName: "Cooper Discoverer AT3 205/55R16", brand: "Cooper", specsShort: "205/55R16" },
  { code: "740000000111", productName: "Michelin Defender 205/65R15", brand: "Michelin", specsShort: "205/65R15" },
  { code: "740000000128", productName: "Falken Wildpeak AT3W 225/45R17", brand: "Falken", specsShort: "225/45R17" },
];

function gptVerifiedPayload(row: FixtureRow) {
  return {
    mode: "decode",
    providerNames: ["gpt-5.4-mini"],
    providerStatuses: [],
    results: [{
      productName: row.productName, brand: row.brand, category: "tires",
      specsShort: row.specsShort, specsFull: "", primarySku: "", primaryBarcode: row.code,
      gtin: row.code, upc: row.code, ean: "", aliases: [], sourceUrls: ["https://example.com/p"],
      confidence: 0.9, verifiedFacts: [], guesses: [], needsHumanReview: false,
    }],
    evidences: [],
    // P5 Task 1 demotion (2026-07-20): a bare GPT self-report never mints an app-verified identity
    // (the gptTrusted auto-count escape hatch was deleted); mapGptDecodeResult now maps this
    // tier to status "suggested", not "verified".
    decision: {
      status: "suggested", confidence: 0.9, reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
      evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0.9, reason: "single provider", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
      corroborationPath: "gpt_self_report",
    },
    reasonCode: "gpt_decode",
    reasonText: "gpt-5.5 ladder verified",
    timedOut: false,
    debug: {},
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 1 });
  await input.press("Enter");
}

test("polish filter: full size narrows to one row, a shared prefix matches every row with it", async ({ page }) => {
  const byCode = new Map(ROWS.map((r) => [r.code, r]));

  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
    const body = route.request().postDataJSON() as { cleanCode?: string };
    const row = byCode.get(body?.cleanCode ?? "");
    if (!row) return route.fulfill({ status: 500, json: { error: "unexpected code" } });
    return route.fulfill({ json: gptVerifiedPayload(row) });
  });

  await page.goto("/scan");
  const login = page.getByTestId("login-button");
  if (await login.isVisible().catch(() => false)) await login.click();
  await expect(page.getByTestId("scanner-input")).toBeVisible();

  for (const row of ROWS) await scan(page, row.code);

  // All three high-confidence GPT suggestions auto-apply as counted products (Brand/Model/Size
  // columns populated by the hot-path structurer) even though none earns a "verified" badge post-P5
  // demotion. Poll on the table body text rather than a fixed sleep.
  await expect(page.getByTestId("scan-feed-body")).toContainText("Suggested (AI)", { timeout: 20_000 });
  await expect(page.getByTestId("final-count-body")).toContainText("Discoverer", { timeout: 20_000 });
  await expect(page.getByTestId("final-count-body")).toContainText("Defender", { timeout: 20_000 });
  await expect(page.getByTestId("final-count-body")).toContainText("Wildpeak", { timeout: 20_000 });
  await page.screenshot({ path: `${PROOF}/01-three-tires-counted.png`, fullPage: true });

  const filter = page.getByTestId("polish-filter");
  await expect(filter).toBeVisible();

  // Full size: exactly one row (the Cooper 205/55R16 -> sizeTag "2055516").
  await filter.fill("2055516");
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(1);
  await expect(page.getByTestId("final-count-body")).toContainText("Discoverer");
  await expect(page.getByTestId("final-count-body")).not.toContainText("Wildpeak");
  await page.screenshot({ path: `${PROOF}/02-exact-size-one-row.png`, fullPage: true });

  // Clear, then a shared prefix: both "205..." rows match, the "225..." row does not.
  await filter.fill("");
  await filter.fill("205");
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(2);
  await expect(page.getByTestId("final-count-body")).toContainText("Discoverer");
  await expect(page.getByTestId("final-count-body")).toContainText("Defender");
  await expect(page.getByTestId("final-count-body")).not.toContainText("Wildpeak");
  await page.screenshot({ path: `${PROOF}/03-prefix-two-rows.png`, fullPage: true });

  // Clearing the filter restores every row.
  await filter.fill("");
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(3);
  await page.screenshot({ path: `${PROOF}/04-cleared-all-rows.png`, fullPage: true });
});
