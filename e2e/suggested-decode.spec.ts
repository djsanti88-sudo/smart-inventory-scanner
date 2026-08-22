import { test, expect, type Page, type Route } from "./fixtures";

// Task 10 (docs/archive/superpowers/plans/2026-07-09-decode-ux-fixes.md, Step 2) + the auto-applied
// band/Approve contract (owner decision 2026-08-19, production-found gap): browser proof for the
// suggested-decode UX end to end. A mocked decode with confidence 0.92 (>= 0.8) and decision.status
// "suggested" - the same shape a retail-corpus exact hit (0.85) produces on production - must:
//   1. Show the suggested identity on the scan feed (not the "Unidentified item" placeholder) and
//      count immediately.
//   2. Tag it with the app-derived band "(Suggested - medium confidence)", never a raw percentage
//      and never the old neutral "unconfirmed" word, with a one-tap Approve + Edit + Reassign.
//   3. OWNER ORDER 2026-07-10 (unchanged): any decode with confidence >= 0.8 must no longer sit in
//      Needs Review at all - the identity auto-applies onto the counted row and the review
//      auto-closes (scanStore.ts autoSuggestApplyOk); the Review nav badge excludes it.
//   4. Approve confirms the identity through the human-approval core (tenant alias), keeps scanner
//      focus, and the rescan resolves deterministically with no second decode.
// All provider traffic is mocked via page.route; the Playwright webServer runs IS_E2E=1
// (mock-only), so no live provider calls are made.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  openaiConfigured: true,
  mode: "aggressive",
  dailyLimit: 100,
  missingKeys: [],
  e2e: true,
};

const CODE = "086699212016";
const SUGGESTED_NAME = "Michelin Defender LTX M/S 275/60R20";

function suggestedDecodeResponse(code: string) {
  return {
    mode: "decode",
    providerNames: ["gpt-5.4-mini"],
    results: [
      {
        productName: SUGGESTED_NAME, brand: "Michelin", category: "tires",
        specsShort: "275/60R20", specsFull: "", primarySku: "", primaryBarcode: code,
        gtin: code, upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
        sourceUrls: ["https://example.com/michelin-defender"], confidence: 0.92,
        verifiedFacts: [], guesses: [], needsHumanReview: true,
      },
    ],
    evidences: [
      { verified: false, strength: "url_only", matchedCode: code, matchedSources: ["https://example.com/michelin-defender"], reason: "URL not independently verified" },
    ],
    decision: {
      status: "suggested", confidence: 0.92, reason: "Suggested, not trusted. Evidence is weak.",
      evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "agree", confidence: 0.92, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    },
    timedOut: false,
    debug: {},
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("auto-applied suggestion (0.92): counts, shows the medium band + Approve/Edit/Reassign, no %, review auto-closes; Approve teaches the alias and keeps scanner focus", async ({ page }) => {
  let posts = 0;
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: STATUS });
    posts += 1;
    return route.fulfill({ json: suggestedDecodeResponse(CODE) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI lookup (default off); with mocked keys configured, auto decode turns On.
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  // A clerk scans once, like a keyboard-wedge scanner would.
  await scan(page, CODE);

  // Counted immediately (TOP-LEVEL LAW), identity shown, not the placeholder.
  const feedRow = page.locator('[data-testid^="feed-product-"]').filter({ hasText: "Michelin Defender" });
  await expect(feedRow).toHaveCount(1);
  await expect(feedRow).toContainText(SUGGESTED_NAME);
  await expect(page.getByTestId("scan-feed-body")).not.toContainText("Unidentified item");
  const countRow = page.locator('[data-testid^="count-row-"]').filter({ hasText: "Michelin Defender" });
  await expect(countRow).toHaveCount(1);
  await expect(countRow.locator('[data-testid^="qty-"]')).toHaveText("1");

  // The app-derived band, never a percentage, never the old "unconfirmed" word - on the feed AND the count table.
  const tag = page.locator('[data-testid^="feed-review-suggestion-"]');
  await expect(tag).toHaveCount(1);
  await expect(tag).toContainText("(Suggested - medium confidence)");
  await expect(tag).not.toContainText("%");
  await expect(feedRow).not.toContainText("unconfirmed");
  await expect(countRow).toContainText("(Suggested - medium confidence)");
  await expect(countRow).not.toContainText("%");

  // Controls: one-tap Approve + Edit + Reassign, all pointer-only (scanner safety).
  const approveBtn = page.locator('[data-testid^="approve-applied-"]');
  const editBtn = page.locator('[data-testid^="edit-identity-"]');
  const reassignBtn = page.locator('[data-testid^="reassign-"]').filter({ hasText: "Reassign" });
  await expect(approveBtn).toHaveCount(1);
  await expect(editBtn).toHaveCount(1);
  await expect(reassignBtn).toHaveCount(1);
  await expect(approveBtn).toHaveAttribute("tabindex", "-1");
  const focusedAfterScan = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(focusedAfterScan).toBe("scanner-input");

  await page.screenshot({ path: `${PROOF}/suggested-decode.png`, fullPage: true });

  // OWNER ORDER 2026-07-10 (unchanged): >= 0.8 auto-applies and auto-closes the review - no red
  // open-count badge on the Review link.
  const reviewNavLink = page.getByRole("link", { name: "Review" });
  await expect(reviewNavLink.locator("span")).toHaveCount(0);

  // Approve: a real pointer click; the tag and Approve disappear, the row keeps its count, the
  // scanner keeps focus, and the identity is now confirmed (Edit-only row).
  const postsBefore = posts;
  await approveBtn.click();
  await expect(tag).toHaveCount(0);
  await expect(approveBtn).toHaveCount(0);
  await expect(page.locator('[data-testid^="edit-product-"]')).toHaveCount(1);
  await expect(countRow.locator('[data-testid^="qty-"]')).toHaveText("1");
  const focusedAfterApprove = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(focusedAfterApprove).toBe("scanner-input");

  // Rescan: deterministic via the approved alias - count 2, NO second decode POST.
  await scan(page, CODE);
  await expect(countRow.locator('[data-testid^="qty-"]')).toHaveText("2");
  await expect(page.locator('[data-testid^="feed-product-"]').filter({ hasText: "Michelin Defender" })).toHaveCount(2);
  expect(posts).toBe(postsBefore);
  await expect(reviewNavLink.locator("span")).toHaveCount(0);

  await page.screenshot({ path: `${PROOF}/suggested-decode-approved.png`, fullPage: true });

  // The auto-closed review never appears on /review.
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${CODE}`)).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// Task 9b (owner-ratified 2026-07-14): inline suggestion approve/decline on the feed row.
// A LOW-confidence suggestion (0.3, below the 0.8 auto-apply bar) counts immediately, shows the
// honest "(Suggested - low confidence)" band tag (app-derived band, never a raw percentage) with pointer-only ✓/✕ controls, and creates NO open Needs Review
// item. Approve = permanent alias via the existing human-approval core -> a rescan resolves
// deterministically with NO second decode call. Decline renames the row to the safe placeholder
// and ONLY THEN opens the review. All decode traffic is mocked (IS_E2E=1 webServer + page.route).
// ---------------------------------------------------------------------------------------------

const CODE_9B = "0792080004312";
const NAME_9B = "Original Anchor Bar Hot Sauce";

function lowConfSuggestedResponse(code: string) {
  return {
    mode: "decode",
    providerNames: ["gpt-5.4-mini"],
    results: [
      {
        productName: NAME_9B, brand: "Anchor Bar", category: "food",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
        gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
        sourceUrls: [`https://go-upc.com/search?q=${code}`], confidence: 0.3,
        verifiedFacts: [], guesses: ["g"], needsHumanReview: true,
      },
    ],
    evidences: [],
    decision: {
      status: "suggested", confidence: 0.3, reason: "Suggested", evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0.3, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
    timedOut: false,
    debug: {},
  };
}

async function setupNonTireSuggested(page: Page, counter: { posts: number }) {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: STATUS });
    counter.posts += 1;
    return route.fulfill({ json: lowConfSuggestedResponse(CODE_9B) });
  });
  // F5 bundle-surgery (wave 2, 2026-07-20): the 2.3MB derived prefix map is server-only now, so the
  // decline path's "Pellicano ... / product unconfirmed" floor name arrives via the async
  // /api/prefix-floor enrichment instead of a synchronous client lookup. Mock it (IS_E2E rule: all
  // decode/enrichment traffic in E2E is page.route-mocked, deterministic, no live/server data dependency).
  await page.route("**/api/prefix-floor*", async (route: Route) =>
    route.fulfill({
      json: {
        floor: {
          name: "Pellicano Specialty Food Distributors / product unconfirmed",
          brand: "Pellicano Specialty Food Distributors",
          familyLabel: null,
        },
      },
    }),
  );

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI lookup + set the shop context to "any" (the plain retail case; tire context keeps
  // its own background-verify escalation behavior, proven elsewhere).
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.getByTestId("setting-scan-context").selectOption("any");
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");
}

test("Task 9b APPROVE: low-conf suggestion shows the (Suggested - low confidence) band + controls, no open review; approve clears the tag, keeps scanner focus, and the rescan is deterministic-known (no second decode)", async ({ page }) => {
  const counter = { posts: 0 };
  await setupNonTireSuggested(page, counter);

  await scan(page, CODE_9B);

  // The counted row shows the suggested identity + the honest confidence tag + the two controls.
  const tag = page.locator('[data-testid^="feed-suggestion-"]');
  await expect(tag).toHaveCount(1);
  await expect(tag).toContainText("(Suggested - low confidence)");
  await expect(tag).not.toContainText("%");
  const approveBtn = page.locator('[data-testid^="approve-suggestion-"]');
  const declineBtn = page.locator('[data-testid^="decline-suggestion-"]');
  await expect(approveBtn).toHaveCount(1);
  await expect(declineBtn).toHaveCount(1);
  // SCANNER SAFETY: pointer-only targets, never in the tab/Enter path.
  await expect(approveBtn).toHaveAttribute("tabindex", "-1");
  await expect(declineBtn).toHaveAttribute("tabindex", "-1");
  await expect(page.getByTestId("scan-feed-body")).toContainText(NAME_9B);

  // THE change: no open Needs Review item for a suggestion (no red badge on the Review link).
  const reviewNavLink = page.getByRole("link", { name: "Review" });
  await expect(reviewNavLink.locator("span")).toHaveCount(0);

  await page.screenshot({ path: `${PROOF}/suggestion-inline-pending.png`, fullPage: true });

  // Approve: a real pointer click that must NOT steal focus from the scanner input.
  await approveBtn.click();
  await expect(tag).toHaveCount(0); // tag + controls cleared
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(focused).toBe("scanner-input");

  // Rescan: resolves deterministically via the approved alias - NO second decode POST.
  const postsBefore = counter.posts;
  await scan(page, CODE_9B);
  await expect(page.locator('[data-testid^="feed-product-"]').filter({ hasText: NAME_9B })).toHaveCount(2);
  await expect(page.locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);
  expect(counter.posts).toBe(postsBefore); // deterministic-known, AI never called again
  await expect(reviewNavLink.locator("span")).toHaveCount(0);

  await page.screenshot({ path: `${PROOF}/suggestion-inline-approved.png`, fullPage: true });
});

test("Task 9b DECLINE: ✕ renames the row to the safe placeholder and ONLY THEN opens the review", async ({ page }) => {
  const counter = { posts: 0 };
  await setupNonTireSuggested(page, counter);

  await scan(page, CODE_9B);
  const declineBtn = page.locator('[data-testid^="decline-suggestion-"]');
  await expect(declineBtn).toHaveCount(1);

  await declineBtn.click();
  // Tag + controls gone; the row never keeps the declined identity. This code's GS1 prefix maps to
  // a known company, so the row gets the Task 8 PREFIX FLOOR name (brand stated with confidence,
  // product flagged unconfirmed) - never a fabricated product, never "verified".
  await expect(page.locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);
  await expect(page.getByTestId("scan-feed-body")).not.toContainText(NAME_9B);
  await expect(page.getByTestId("scan-feed-body")).toContainText("Pellicano");
  await expect(page.getByTestId("scan-feed-body")).toContainText("product unconfirmed");
  // Scanner focus survives the decline click too.
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(focused).toBe("scanner-input");

  // Decline is the ONLY suggestion path that creates a review - it is open, with the honest reason.
  const reviewNavLink = page.getByRole("link", { name: "Review" });
  await expect(reviewNavLink.locator("span")).toContainText("1");
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${CODE_9B}`)).toHaveCount(1);
  await expect(page.getByTestId(`review-row-${CODE_9B}`)).toContainText("Suggestion declined");

  await page.screenshot({ path: `${PROOF}/suggestion-inline-declined.png`, fullPage: true });
});
