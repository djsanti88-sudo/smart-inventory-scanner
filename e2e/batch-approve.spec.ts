import { test, expect, type Page, type Route } from "./fixtures";

// Build 3 (docs/superpowers/specs/2026-07-05-batch-approve-design.md): batch-approve screen for
// the Suggested pile. Seeds 6 suggested unknown codes (all mocked - IS_E2E webServer, page.route,
// zero live calls), selects all on the /review "Suggested" tab, approves once, and proves every
// count landed exactly once. Then proves re-approval (a retried batch / double-click) is a no-op:
// nothing is approved twice and no count is doubled. Screenshots: e2e/proof/batch-approve/.

const PROOF = "e2e/proof/batch-approve";

const AI_ON_STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: true,
  openaiConfigured: true,
  premiumFallback: false,
  mode: "aggressive",
  dailyLimit: 100,
  missingKeys: [],
  e2e: true,
};

function result(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.6, needsHumanReview: false, ...over,
  };
}

// 6 distinct 12-digit unknowns, no seeded alias.
const CODES = Array.from({ length: 6 }, (_, i) => `749333114${400 + i}`);

// Every code decodes as "suggested" with WEAK (url_only) evidence - never auto-counted, always
// lands open + hasSuggestion in Needs Review, which is exactly the Suggested pile this screen targets.
function suggestedPayload(code: string, n: number) {
  return {
    providerNames: ["gemini"],
    results: [
      result({
        productName: `Batch Widget ${n}`,
        brand: "BatchBrand",
        upc: code,
        sourceUrls: [`https://example.com/batch-${n}`],
      }),
    ],
    decision: {
      status: "suggested",
      confidence: 0.55,
      reason: "Suggested, not trusted. Evidence is weak.",
      evidenceStrength: "url_only",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider" },
    },
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("batch-approve: select all suggested rows, approve once, all counts land; re-approve is a no-op", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
    const body = JSON.parse(req.postData() || "{}") as { cleanCode?: string };
    const code = body.cleanCode ?? "";
    const n = CODES.indexOf(code) + 1 || 1;
    return route.fulfill({ json: suggestedPayload(code, n) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  for (const code of CODES) await scan(page, code);

  // All 6 scans land + eventually settle to the "Suggested" decode badge (weak evidence -> never
  // auto-counted -> stays open in Needs Review with a suggestion attached).
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(CODES.length);
  // Owner order 2026-07-10: "Your counts" now has its own Status column reusing the same
  // decode-row-status testid, so this locator must be scoped to the scan feed body - otherwise it
  // also picks up the counts table's badges on the same page and the count doubles.
  await expect(
    page.getByTestId("scan-feed-body").getByTestId("decode-row-status").filter({ hasText: "Suggested" }),
  ).toHaveCount(CODES.length, {
    timeout: 20_000,
  });

  await page.goto("/review");
  await page.getByTestId("review-tab-suggested").click();
  await expect(page.getByTestId("suggested-body").locator("tr")).toHaveCount(CODES.length);
  await page.screenshot({ path: `${PROOF}/01-suggested-pile.png`, fullPage: true });

  // Capture the pending suggested review ids up front for the direct store-level idempotency proof
  // below. owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b) - suggestion-bearing
  // reviews are now parked at status "suggested" instead of "open"; the pile itself is unchanged.
  const reviewIds = await page.evaluate(() => {
    type Store = { getState: () => { needsReviewQueue: Array<{ id: string; status: string; hasSuggestion: boolean }> } };
    const w = window as unknown as { __scanStore: Store };
    return w.__scanStore
      .getState()
      .needsReviewQueue.filter((r) => (r.status === "open" || r.status === "suggested") && r.hasSuggestion)
      .map((r) => r.id);
  });
  expect(reviewIds).toHaveLength(CODES.length);

  await page.getByTestId("suggested-select-all").check();
  await expect(page.getByTestId("approve-selected")).toContainText(`Approve selected (${CODES.length})`);
  await page.getByTestId("approve-selected").click();

  await expect(page.getByTestId("batch-approve-result")).toContainText(`Approved ${CODES.length} product(s).`);
  await expect(page.getByTestId("suggested-body")).toContainText("Nothing suggested");
  await page.screenshot({ path: `${PROOF}/02-approved.png`, fullPage: true });

  // Every approved suggestion is now a real, counted product.
  await page.goto("/scan");
  for (let i = 1; i <= CODES.length; i++) {
    await expect(page.getByTestId("final-count-body")).toContainText(`Batch Widget ${i}`);
  }

  type CountSnapshot = { productId: string; quantity: number };
  const readCounts = () =>
    page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string; quantity: number }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts.map((c) => ({ productId: c.productId, quantity: c.quantity }));
    });
  const countsAfterFirstApproval: CountSnapshot[] = await readCounts();

  // RE-APPROVE IS A NO-OP: calling batchApprove again with the SAME review ids (a retried batch, or
  // a double-click the UI itself already guards against by hiding resolved rows) must approve
  // nothing and must not double-count anything - resolveUnknown's own open-status guard makes every
  // row idempotent.
  const secondResult = await page.evaluate((ids: string[]) => {
    type Store = {
      getState: () => {
        batchApprove: (ids: string[]) => { approved: string[]; failed: Array<{ id: string; reason: string }> };
      };
    };
    const w = window as unknown as { __scanStore: Store };
    return w.__scanStore.getState().batchApprove(ids);
  }, reviewIds);
  expect(secondResult.approved).toHaveLength(0);
  expect(secondResult.failed).toHaveLength(0);

  const countsAfterSecondApproval: CountSnapshot[] = await readCounts();
  expect(countsAfterSecondApproval).toEqual(countsAfterFirstApproval);
  await page.reload();
  for (let i = 1; i <= CODES.length; i++) {
    await expect(page.getByTestId("final-count-body")).toContainText(`Batch Widget ${i}`);
  }
  await page.screenshot({ path: `${PROOF}/03-reapprove-no-op.png`, fullPage: true });
});
