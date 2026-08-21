import { test, expect, type Page, type Route } from "./fixtures";

// ---------------------------------------------------------------------------------------------
// Best-guess identity (owner decision 2026-08-19, DECISIONS.md "Identity philosophy: best available
// guess, honest label, easy correction, pay once").
//
// Browser proof, driven like a clerk: every step types into the REAL scan input and clicks the REAL
// visible row controls. Nothing reaches into the store. All decode traffic is page.route-mocked and
// COUNTED per code, so "pay once" (no second decode call for a code whose guess is already on
// screen) is proven by the route handler's own invocation count.
//
// TEST SAFETY: the Playwright webServer runs IS_E2E=1 (AI route mock-only) and every /api/ai-lookup
// + /api/prefix-floor request is intercepted here - no live provider is ever called.
// ---------------------------------------------------------------------------------------------

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

// Codes from the owner's real unknown batch - none of them are in the E2E seed catalog.
const CODE_GUESS = "697662129691";
const CODE_TYPED = "697662131854";
const CODE_NONE = "697662137658";
const TEN_CODES = [
  "086699368492", "715459275427", "5452000649706", "049000042566", "012000161155",
  "697662129692", "697662129693", "697662129694", "697662129695", "697662129696",
];

const GUESS_NAME = "Anchor Bar Hot Sauce";
const GUESS_BRAND = "Anchor Bar";

/** A WEAK decode: a usable name, but an honestly "needs_review" decision with no evidence. This is
 *  exactly the case the owner decision widened - it must now show as a banded best guess on the row. */
function weakGuessResponse(name: string, brand: string) {
  return {
    mode: "decode",
    providerNames: ["mock-ladder"],
    results: [
      {
        productName: name, brand, category: "food",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
        gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
        sourceUrls: [], confidence: 0.45, verifiedFacts: [], guesses: ["weak evidence"],
        needsHumanReview: true,
      },
    ],
    evidences: [],
    decision: {
      status: "needs_review", confidence: 0.45, reason: "Weak evidence - suggestion only.",
      evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0.45, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
    reasonText: "Weak evidence - suggestion only.",
    timedOut: false,
    debug: {},
  };
}

/** No candidate at all: the ladder ran and found nothing. The row must still appear and count. */
function noCandidateResponse() {
  return {
    mode: "decode",
    providerNames: ["mock-ladder"],
    results: [],
    evidences: [],
    decision: {
      status: "needs_review", confidence: 0, reason: "No candidate found.",
      evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
    reasonText: "No candidate found.",
    timedOut: false,
    debug: {},
  };
}

type Posts = Map<string, number>;

/**
 * Installs the mocked decode surface and logs in with AI lookup on.
 * `guesses` maps a cleanCode -> the weak guess that code decodes to; every other code decodes to
 * "no candidate". The returned map counts POST /api/ai-lookup calls PER cleanCode.
 */
async function setup(page: Page, guesses: Record<string, { name: string; brand: string }> = {}): Promise<Posts> {
  const posts: Posts = new Map();
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: STATUS });
    const body = (req.postDataJSON() ?? {}) as { cleanCode?: string };
    const code = body.cleanCode ?? "";
    posts.set(code, (posts.get(code) ?? 0) + 1);
    const guess = guesses[code];
    return route.fulfill({ json: guess ? weakGuessResponse(guess.name, guess.brand) : noCandidateResponse() });
  });
  // Keep the "no identity" case honest and deterministic: no GS1 prefix floor name is ever supplied,
  // so an unidentifiable row keeps the "Unidentified item" placeholder.
  await page.route("**/api/prefix-floor*", async (route: Route) => route.fulfill({ json: { floor: null } }));

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.getByTestId("setting-scan-context").selectOption("any");
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  return posts;
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

function feedRows(page: Page) {
  return page.getByTestId("scan-feed-body").locator("tr");
}

function rowFor(page: Page, code: string) {
  return feedRows(page).filter({ hasText: code });
}

function countRows(page: Page) {
  return page.getByTestId("final-count-body").locator("tr");
}

/** The feed header's own total ("N scans"), computed over the FULL scanFeed by LiveScanFeed. */
function feedTotal(page: Page) {
  return page.locator("#scan-feed-heading ~ span");
}

// ---------------------------------------------------------------------------------------------

test("1. a weak decode with a usable name shows the best guess, a banded label (never a percentage), and Approve + Edit - and it counts", async ({ page }) => {
  const posts = await setup(page, { [CODE_GUESS]: { name: GUESS_NAME, brand: GUESS_BRAND } });

  await scan(page, CODE_GUESS);

  const row = rowFor(page, CODE_GUESS);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(GUESS_NAME);

  // The honest label is an app-derived band, never a raw provider percentage.
  const band = row.locator('[data-testid^="feed-suggestion-"]');
  await expect(band).toHaveCount(1);
  await expect(band).toContainText("(Suggested - low confidence)");
  expect(await row.innerText()).not.toContain("%");

  // Row controls for a pending guess: Approve (✓) + Edit (confirm sheet) + Not this product (✕).
  await expect(row.locator('[data-testid^="approve-suggestion-"]')).toHaveCount(1);
  await expect(row.locator('[data-testid^="edit-identity-"]')).toHaveCount(1);
  await expect(row.locator('[data-testid^="decline-suggestion-"]')).toHaveCount(1);

  // TOP-LEVEL LAW: it counted. One scan = one feed row = one counted unit.
  await expect(feedTotal(page)).toHaveText("1 scans");
  await expect(countRows(page)).toHaveCount(1);
  await expect(page.locator('[data-testid^="qty-"]')).toHaveText("1");
  expect(posts.get(CODE_GUESS)).toBe(1);

  await page.screenshot({ path: `${PROOF}/best-guess-1-suggested-row.png`, fullPage: true });
});

test("2. rescanning the same code counts again and repeats the SAME guess without a second decode call (pay once)", async ({ page }) => {
  const posts = await setup(page, { [CODE_GUESS]: { name: GUESS_NAME, brand: GUESS_BRAND } });

  await scan(page, CODE_GUESS);
  await expect(rowFor(page, CODE_GUESS).locator('[data-testid^="feed-suggestion-"]')).toHaveCount(1);
  expect(posts.get(CODE_GUESS)).toBe(1);

  await scan(page, CODE_GUESS);

  // Both physical scans appear and count.
  await expect(rowFor(page, CODE_GUESS)).toHaveCount(2);
  await expect(feedTotal(page)).toHaveText("2 scans");
  await expect(countRows(page)).toHaveCount(1);
  await expect(page.locator('[data-testid^="qty-"]')).toHaveText("2");

  // The second row carries the SAME best guess, same band, still correctable.
  const bands = rowFor(page, CODE_GUESS).locator('[data-testid^="feed-suggestion-"]');
  await expect(bands).toHaveCount(2);
  await expect(bands.first()).toContainText("(Suggested - low confidence)");
  await expect(rowFor(page, CODE_GUESS).first()).toContainText(GUESS_NAME);

  // PAY ONCE: the decode route was never invoked a second time for this code. The settle window
  // makes this a real assertion rather than a race - a late/async second decode would be counted.
  await page.waitForTimeout(1500);
  expect(posts.get(CODE_GUESS)).toBe(1);

  await page.screenshot({ path: `${PROOF}/best-guess-2-rescan-no-second-decode.png`, fullPage: true });
});

test("3. Approve settles the guess and teaches the code; typing an identity on a different code teaches that one too", async ({ page }) => {
  const posts = await setup(page, { [CODE_GUESS]: { name: GUESS_NAME, brand: GUESS_BRAND } });

  // --- Approve path -------------------------------------------------------------------------
  await scan(page, CODE_GUESS);
  const approve = rowFor(page, CODE_GUESS).locator('[data-testid^="approve-suggestion-"]');
  await expect(approve).toHaveCount(1);
  await approve.click();

  // The suggested tag settles: no pending guess controls remain on the row.
  await expect(rowFor(page, CODE_GUESS).locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);
  await expect(rowFor(page, CODE_GUESS)).toContainText(GUESS_NAME);
  // SCANNER SAFETY: the pointer-only control never stole focus from the scan input.
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // A third scan of the same code now resolves deterministically - no suggestion, no decode call.
  const postsBefore = posts.get(CODE_GUESS) ?? 0;
  await scan(page, CODE_GUESS);
  await expect(rowFor(page, CODE_GUESS)).toHaveCount(2);
  await expect(rowFor(page, CODE_GUESS).first()).toContainText(GUESS_NAME);
  await expect(rowFor(page, CODE_GUESS).locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);
  await expect(rowFor(page, CODE_GUESS).locator('[data-testid^="approve-suggestion-"]')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(posts.get(CODE_GUESS) ?? 0).toBe(postsBefore);

  // --- Typed-identity path (a code with no candidate at all) --------------------------------
  await scan(page, CODE_TYPED);
  const typedRow = rowFor(page, CODE_TYPED);
  await expect(typedRow).toHaveCount(1);
  const identify = typedRow.locator('[data-testid^="identify-row-"]');
  await expect(identify).toHaveCount(1);
  await identify.click();

  await typedRow.locator('[data-testid^="identity-name-"]').fill("Blue Shop Rag 50 Pack");
  await typedRow.locator('[data-testid^="identity-brand-"]').fill("Shopline");
  const confirm = typedRow.locator('[data-testid^="identity-save-"]');
  await expect(confirm).toHaveText("Confirm identity");
  await confirm.click();

  await expect(rowFor(page, CODE_TYPED)).toContainText("Blue Shop Rag 50 Pack");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // The next scan of that code is known: no suggestion controls, no decode call.
  const typedPostsBefore = posts.get(CODE_TYPED) ?? 0;
  await scan(page, CODE_TYPED);
  await expect(rowFor(page, CODE_TYPED)).toHaveCount(2);
  await expect(rowFor(page, CODE_TYPED).first()).toContainText("Blue Shop Rag 50 Pack");
  await expect(rowFor(page, CODE_TYPED).locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(posts.get(CODE_TYPED) ?? 0).toBe(typedPostsBefore);

  await page.screenshot({ path: `${PROOF}/best-guess-3-approve-and-confirm.png`, fullPage: true });
});

test("4. a code with no candidate at all still appears, counts, reads 'Unidentified item', and offers Identify", async ({ page }) => {
  await setup(page);

  await scan(page, CODE_NONE);

  const row = rowFor(page, CODE_NONE);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Unidentified item");
  await expect(feedTotal(page)).toHaveText("1 scans");
  await expect(countRows(page)).toHaveCount(1);
  await expect(page.locator('[data-testid^="qty-"]')).toHaveText("1");
  await expect(row.locator('[data-testid^="identify-row-"]')).toHaveCount(1);

  await page.screenshot({ path: `${PROOF}/best-guess-4-unidentified-counts.png`, fullPage: true });
});

test("5. ten distinct codes scanned rapidly produce ten rows and a session total of ten", async ({ page }) => {
  await setup(page);

  const input = page.getByTestId("scanner-input");
  await input.click();
  for (const code of TEN_CODES) {
    await input.pressSequentially(code, { delay: 1 });
    await input.press("Enter");
  }

  await expect(feedRows(page)).toHaveCount(TEN_CODES.length);
  await expect(feedTotal(page)).toHaveText(`${TEN_CODES.length} scans`);
  await expect(countRows(page)).toHaveCount(TEN_CODES.length);

  await page.screenshot({ path: `${PROOF}/best-guess-5-ten-rapid-scans.png`, fullPage: true });
});

test("6. a settled (known) row offers Edit and not Approve; editing the name updates the row with no decode call", async ({ page }) => {
  const posts = await setup(page, { [CODE_GUESS]: { name: GUESS_NAME, brand: GUESS_BRAND } });

  await scan(page, CODE_GUESS);
  await rowFor(page, CODE_GUESS).locator('[data-testid^="approve-suggestion-"]').click();
  await expect(rowFor(page, CODE_GUESS).locator('[data-testid^="feed-suggestion-"]')).toHaveCount(0);

  // Scan it again: this row resolved from the approved alias, so it is a settled identity.
  await scan(page, CODE_GUESS);
  const settled = rowFor(page, CODE_GUESS).first();
  await expect(settled.locator('[data-testid^="approve-suggestion-"]')).toHaveCount(0);
  const edit = settled.locator('[data-testid^="edit-product-"]');
  await expect(edit).toHaveCount(1);
  await expect(edit).toHaveText("Edit");

  const postsBefore = posts.get(CODE_GUESS) ?? 0;
  await edit.click();
  await settled.locator('[data-testid^="identity-name-"]').fill("Anchor Bar Hot Sauce 12oz");
  const save = settled.locator('[data-testid^="identity-save-"]');
  await expect(save).toHaveText("Save details");
  await save.click();

  await expect(rowFor(page, CODE_GUESS).first()).toContainText("Anchor Bar Hot Sauce 12oz");
  expect(posts.get(CODE_GUESS) ?? 0).toBe(postsBefore);

  // Focus came back to the scanner, and the very next typed scan still lands.
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  const before = await feedRows(page).count();
  await scan(page, CODE_GUESS);
  await expect(feedRows(page)).toHaveCount(before + 1);

  await page.screenshot({ path: `${PROOF}/best-guess-6-edit-metadata.png`, fullPage: true });
});
