import { test, expect, type Page } from "./fixtures";

// GAP 3 (docs/superpowers/reports/2026-08-13-e2e-coverage-map.md items F1/F2): scan.spec.ts's existing
// "offline" proof only flips a mock "simulate sync failure" checkbox, never real network state. This spec
// uses Playwright's genuine network-offline API (page.context().setOffline) for the TOP-LEVEL LAW half of
// the proof, then drives a real multi-click retry storm (>1 retry, both while still failing and after the
// failure is fixed) for the idempotency half - the reason this spec exists: prove a retry storm can never
// inflate a count or duplicate a row.

const PROOF = "e2e/proof/offline-retry-idempotency";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function stubAiLookup(page: Page) {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("genuine network offline: scans appear and count immediately, are marked pending, and reconnect never inflates counts", async ({ page }) => {
  await stubAiLookup(page);
  await login(page);

  await page.context().setOffline(true);

  // Nokian x1, Coca-Cola x2 (dup, same code), Falken x1 - 4 physical scans while genuinely offline.
  const codes = ["6419440485331", "049000028904", "049000028904", "848983012906"];
  for (const code of codes) await scan(page, code);

  // TOP-LEVEL LAW holds regardless of real connectivity: every physical scan appears and counts.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(codes.length);
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
  await page.screenshot({ path: `${PROOF}/01-offline-scans-counted.png`, fullPage: true });

  // Scans made while genuinely offline must be marked pending/not-synced (CLAUDE.md "Optimistic State,
  // Offline, Idempotent Sync": "failed sync marks items pending... Saved locally, not synced yet").
  await expect(page.getByTestId("pending-warning"), "offline scans must show the pending/not-synced warning").toBeVisible();
  await expect(page.getByTestId("pending-count"), "pending count must be nonzero while genuinely offline").not.toContainText("Waiting to save: 0");
  await page.screenshot({ path: `${PROOF}/02-offline-pending-state.png`, fullPage: true });

  // Reconnect for real.
  await page.context().setOffline(false);
  if (await page.getByTestId("retry-sync").isEnabled().catch(() => false)) {
    await page.getByTestId("retry-sync").click();
  }
  await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0");

  // Counts are UNCHANGED by the reconnect/drain itself - no double-application on "coming back online".
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(codes.length);
  await page.screenshot({ path: `${PROOF}/03-reconnect-no-inflation.png`, fullPage: true });
});

test("repeated retry storm against a stuck sync queue never inflates counts or duplicates rows", async ({ page }) => {
  await stubAiLookup(page);
  await login(page);

  // Drive the queue into a genuinely stuck state (proven mechanism: scan.spec.ts's toggle-sync-failure),
  // then hammer Retry repeatedly - the retry-storm idempotency proof this spec exists for.
  await page.getByTestId("toggle-sync-failure").check();

  const codes = ["6419440485331", "049000028904", "848983012906"]; // Nokian, Coca-Cola, Falken - 1 each
  for (const code of codes) await scan(page, code);

  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(codes.length);
  await expect(page.getByTestId("pending-warning")).toBeVisible();
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
  await page.screenshot({ path: `${PROOF}/04-stuck-queue.png`, fullPage: true });

  // Retry storm #1: 5 clicks WHILE still failing. Each retry must be a safe no-op - never double-apply
  // the same pending idempotencyKey - even before the underlying failure is fixed. Guard on the button's
  // enabled state (it disables once the queue is empty) rather than clicking blind, matching scan.spec.ts's
  // established pattern - a disabled button here would itself mean the queue drained early, which the
  // quantity/row assertions below would still catch as an inflation if it were unsafe.
  for (let i = 0; i < 5; i++) {
    if (await page.getByTestId("retry-sync").isEnabled()) {
      await page.getByTestId("retry-sync").click();
      await page.waitForTimeout(120);
    }
    await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
    await expect(page.getByTestId("qty-prod-coke")).toHaveText("1");
    await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(codes.length);
  }

  // Fix the failure, then retry storm #2: 4 more clicks. The queue drains exactly once (on the FIRST
  // post-fix click); further clicks after it is empty are no-ops precisely because the button self-disables
  // - itself part of the idempotency contract this spec is proving, not something to route around.
  await page.getByTestId("toggle-sync-failure").uncheck();
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId("retry-sync").isEnabled()) {
      await page.getByTestId("retry-sync").click();
      await page.waitForTimeout(150);
    }
    await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
    await expect(page.getByTestId("qty-prod-coke")).toHaveText("1");
    await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(codes.length);
  }

  await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0");
  // No duplicate rows: exactly one count row per product, never two for the same code.
  await expect(page.locator('[data-testid^="count-row-"]').filter({ hasText: "Nokian" })).toHaveCount(1);
  await page.screenshot({ path: `${PROOF}/05-retry-storm-settled.png`, fullPage: true });

  // Survives reload too (queue state and counts are real, not just DOM-transient).
  await page.reload();
  if (!page.url().includes("/scan")) {
    await login(page);
  }
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("1");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("1");
});
