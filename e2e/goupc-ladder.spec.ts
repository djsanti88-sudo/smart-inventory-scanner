import { test, expect, type Page, type Route } from "./fixtures";

// Task 17 (docs/archive/superpowers/plans/2026-07-08-decode-ladder-goupc.md): E2E proof of the Go-UPC decode
// rung's user-visible behavior. All provider traffic is mocked via page.route on /api/ai-lookup (the
// Playwright webServer runs IS_E2E=1, and E2E mode never calls a live rung anyway - see
// src/app/api/ai-lookup/route.ts runGoUpc/runFetchV2 e2eMode() short-circuits). This spec proves the
// CONTRACT between the route's response shape (src/server/upc/GoUpcProvider.ts toResult/
// verifiedDecision/suggestionDecision) and the UI, not the live Go-UPC API.
//
// Uses the generic (non-tire) fixture so scanContext defaults to "any" (see e2e/fetchv2-count-contract.
// spec.ts) - the Go-UPC rung's auto-count gate (catalogAutoVerify.planAutoVerify) is codeType/scanContext
// agnostic; this keeps the tire-specific spec-completeness gate (hasCountableTireIdentity) out of scope.

const PROOF = "e2e/proof";

const AI_ON_STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: true,
  openaiConfigured: true,
  premiumFallback: false,
  mode: "aggressive",
  dailyLimit: 200,
  missingKeys: [],
  e2e: true,
};

function emptyResult(over: Record<string, unknown> = {}) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0, needsHumanReview: true, ...over,
  };
}

// Mirrors GoUpcProvider.toResult() (exact hit): confidence 0.9, needsHumanReview false, verifiedFacts set.
function goUpcExactResult(code: string) {
  return emptyResult({
    productName: "Energizer MAX AA Batteries, 8 Pack",
    brand: "Energizer",
    category: "Batteries",
    specsShort: "8 Pack",
    specsFull: "8 Pack",
    primaryBarcode: code,
    gtin: code,
    upc: code,
    confidence: 0.9,
    verifiedFacts: ["Go-UPC exact barcode match"],
    needsHumanReview: false,
  });
}

// Mirrors GoUpcProvider.suggestResult() (inferred hit): confidence 0.4, needsHumanReview true, no verifiedFacts.
function goUpcInferredResult(code: string) {
  return emptyResult({
    productName: "Generic AA Battery Multipack",
    brand: "Energizer",
    category: "Batteries",
    primaryBarcode: code,
    gtin: code,
    upc: code,
    confidence: 0.4,
    needsHumanReview: true,
  });
}

// P5 Task 2 demotion (2026-07-20): Go-UPC's own exact-match response is a self-report, never an
// app-verified fetch, so GoUpcProvider.verifiedDecision() no longer exists / no longer returns
// status "verified". This fixture mirrors the CURRENT contract: a high-confidence SUGGESTION with
// honest evidence (evidenceStrength "none", exactCodeEvidenceVerifiedByApp false).
const GOUPC_EXACT_DECISION = {
  status: "suggested",
  confidence: 0.9,
  reason: "Suggested by Go-UPC (exact barcode match, API self-report - not app-verified).",
  evidenceStrength: "none",
  exactCodeEvidenceVerifiedByApp: false,
  crossCheck: {
    decision: "single_provider",
    confidence: 0.9,
    reason: "Go-UPC exact barcode.",
    brandSimilarity: 1,
    nameSimilarity: 1,
    contradictions: [],
  },
  corroborationPath: "single_source",
};

// Mirrors GoUpcProvider.suggestionDecision().
function suggestionDecision(reason: string) {
  return {
    status: "needs_review",
    confidence: 0.4,
    reason,
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: 0.4,
      reason,
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
}

// Route-level decode payload shape (matches route.ts's `payload` assembly for a settled Go-UPC rung).
function goUpcExactPayload(code: string) {
  return {
    mode: "decode",
    providerNames: ["go-upc"],
    results: [goUpcExactResult(code)],
    evidences: [{ verified: false, strength: "none", matchedCode: code, matchedSources: ["go-upc"], reason: "Go-UPC API self-report (not app page-verified)" }],
    providerStatuses: [{ provider: "go-upc", status: "ok", latencyMs: 12, sourceUrlsReturned: 0, exactCodeFound: true, identityFound: true }],
    decision: GOUPC_EXACT_DECISION,
    reasonCode: "ok",
    reasonText: "",
    timedOut: false,
    debug: { providersAttempted: ["go-upc"], evidenceStrengths: ["none"], sourceCounts: [0], ladderPath: "go-upc", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

function goUpcInferredPayload(code: string) {
  const reason = "Go-UPC inferred match (not exact). Confirm before counting.";
  return {
    mode: "decode",
    providerNames: ["go-upc"],
    results: [goUpcInferredResult(code)],
    evidences: [{ verified: false, strength: "snippet", matchedCode: code, matchedSources: ["go-upc"], reason }],
    providerStatuses: [{ provider: "go-upc", status: "ok", latencyMs: 12, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: true }],
    decision: suggestionDecision(reason),
    reasonCode: "needs_review",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["go-upc"], evidenceStrengths: ["snippet"], sourceCounts: [0], ladderPath: "go-upc", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

// Cap-reached: Go-UPC rung returns "goupc_unavailable" (reason "Go-UPC monthly cap reached"), then every
// other rung also misses in this fixture, so the route's all-miss branch classifies the per-rung reasons
// (allMissReasonCode, src/services/ai/decodeFallback.ts) into "provider_cap_reached" and uses its honest,
// token-free text (MISS_REASON_TEXT) as decision.reason/reasonText - never the raw vendor-named join
// (BUG #14 anti-leak law: "Go-UPC" must never reach a customer-facing field). The review row renders
// `review.reason`, which the store sets verbatim from `decision.reason`.
function goUpcCapPayload(code: string) {
  const honestCapReason = "A lookup service is at its usage limit right now. Saved to Needs Review; try again shortly.";
  return {
    mode: "decode",
    providerNames: ["go-upc", "fetchv2", "gpt"],
    results: [],
    evidences: [],
    providerStatuses: [{ provider: "go-upc", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: "Go-UPC monthly cap reached" }],
    decision: { status: "needs_review", confidence: 0, reason: honestCapReason, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
    reasonCode: "no_result",
    reasonText: honestCapReason,
    timedOut: false,
    debug: { providersAttempted: ["go-upc", "fetchv2", "gpt"], evidenceStrengths: [], sourceCounts: [], ladderPath: "none", missReasonCode: "provider_cap_reached", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test.describe("Go-UPC decode ladder (mocked)", () => {
  test("1. exact hit -> Suggested (DB), still auto-counts (high-confidence suggestion auto-applies)", async ({ page }) => {
    const code = "034000002702"; // checksum-valid UPC-A, no seeded alias
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcExactPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Feed row upgrades from "Decoding..." to "Suggested (DB)" (DecodeStatusBadge honest-provenance
    // label for a Go-UPC self-report - P5 demotion: Go-UPC's own exact-match claim is never
    // app-verified, so it never earns the green "Verified" badge, only an amber "Suggested (DB)").
    await expect(page.getByTestId("scan-feed-body")).toContainText("Suggested (DB)", { timeout: 15_000 });
    // Still auto-counted: a 0.9-confidence suggestion auto-applies onto the counted row even though
    // it is not verified (shouldAutoApplySuggestion gate) - the row appears with no human click.
    await expect(page.getByTestId("final-count-body")).toContainText("Energizer MAX AA Batteries", { timeout: 15_000 });
    await expect(page.getByTestId("scanner-input")).toBeFocused();

    await page.screenshot({ path: `${PROOF}/goupc-exact-autocount.png`, fullPage: true });
  });

  test("2. inferred hit -> inline suggestion on the counted row (Approve/Edit), product attached, not an open review", async ({ page }) => {
    const code = "034000002719"; // checksum-valid UPC-A, distinct from scenario 1
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcInferredPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Best-guess identity (owner 2026-08-19): a needs_review decode WITH a usable name no longer
    // sits in the open Needs Review queue. The best available identity is attached to the counted
    // feed row immediately, labeled as a suggestion with an app-derived confidence band (never a raw
    // percentage), with inline Approve / Edit controls; the review record is parked as "suggested".
    const feed = page.getByTestId("scan-feed-body");
    await expect(feed).toContainText("Generic AA Battery Multipack", { timeout: 15_000 });
    await expect(feed).toContainText("Suggested");
    await expect(feed).not.toContainText("%");
    await expect(page.locator('[data-testid^="approve-suggestion-"]')).toHaveCount(1);

    await page.goto("/review");
    await expect(page.getByTestId(`review-row-${code}`)).toHaveCount(0);

    await page.screenshot({ path: `${PROOF}/goupc-inferred-suggest.png`, fullPage: true });
  });

  test("3. cap reached -> row reason is the honest cap message, never the raw vendor name", async ({ page }) => {
    const code = "034000002726"; // checksum-valid UPC-A, distinct from scenarios 1-2
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcCapPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // The scan feed's Reason column surfaces decision.reason verbatim (scanStore: `reason: decision?.reason`).
    // Honest reasons law (root-cause fix 2026-07-20): the row must say WHY (a usage limit was hit) but must
    // NEVER leak the raw vendor name (BUG #14 anti-leak law - "Go-UPC" is a denylisted token).
    const feed = page.getByTestId("scan-feed-body");
    await expect(feed).toContainText("usage limit", { timeout: 15_000 });
    await expect(feed).not.toContainText("Go-UPC");

    await page.screenshot({ path: `${PROOF}/goupc-cap-reason.png`, fullPage: true });
  });

  test("4. all providers dead (500s) -> raw row persists in Needs Review after reload", async ({ page }) => {
    const code = "034000002733"; // checksum-valid UPC-A, distinct from scenarios 1-3
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      // Every provider is dead: the route itself fails. scanStore's decodeOnce() throws on !res.ok,
      // which the catch block turns into a COUNTED provisional "needs_review" row (count-first, HARD
      // RULE 0) - the scan is never lost even though decode totally failed.
      return route.fulfill({ status: 500, json: { error: "all providers down" } });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Count-first: the raw scan row is counted (provisional) even though every rung failed.
    await expect(page.getByTestId("scan-feed-body")).toContainText(code, { timeout: 15_000 });
    await expect(page.getByTestId("scan-feed-body")).toContainText("Suggested", { timeout: 15_000 });

    // Reload the page: the row must SURVIVE (Zustand persist -> localStorage), proving durability, not
    // just in-memory state that a refresh would wipe.
    await page.reload();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await page.goto("/review");
    const row = page.getByTestId(`review-row-${code}`);
    await expect(row).toBeVisible();

    await page.screenshot({ path: `${PROOF}/countfirst-survives.png`, fullPage: true });
  });
});
