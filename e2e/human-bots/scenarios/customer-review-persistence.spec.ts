import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// P1 (2026-06-22): a CUSTOMER must keep their pending Needs-Review items across a full page reload.
// Before the fix, buildPersistedScanState dropped needsReviewQueue for the customer role, so a reload
// wiped every "Check these" row and the badge fell to 0 — the customer's unfinished work was lost and
// could never be approved/counted. This bot scans unknown codes as a customer (mock/auth-bypass = business
// level; no NEXT_PUBLIC_E2E_PLATFORM_OWNER), does a REAL reload, and proves the rows + badge survive and an
// item is still approvable + countable afterwards.

const PROOF = "e2e/proof/daily-2026-06-22";

async function scan(page: Page, code: string) {
  const i = page.getByTestId("scanner-input");
  await i.click();
  await i.fill(code);
  await i.press("Enter");
  await page.waitForTimeout(150);
}

const reviewRows = (page: Page) => page.locator('[data-testid^="review-row-"]');
const badge = (page: Page) => page.getByRole("link", { name: /Review/ }).locator("span");

test("CustomerReviewPersistenceBot: pending reviews + badge survive a full reload (P1)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  const codes = ["999000111222", "888000111222", "777000111222"]; // unknown -> Needs Review under E2E mock

  await page.goto("/scan");
  for (const c of codes) await scan(page, c);
  // Sanity: the most recent scan is in the feed as Needs Review (feed prepends).
  await expect(page.getByTestId("scan-feed-body").locator("tr").first()).toContainText(/needs review|not recognised/i);

  await page.goto("/review");
  await expect(reviewRows(page).first()).toBeVisible();
  const before = await reviewRows(page).count();
  expect(before, "all scanned unknowns should be in Check these before reload").toBe(codes.length);
  await page.screenshot({ path: `${PROOF}/01-review-before-reload.png`, fullPage: true });

  // FULL reload: state must rehydrate from localStorage, not memory.
  await page.reload();
  await page.goto("/review");
  await expect(reviewRows(page).first()).toBeVisible();
  const after = await reviewRows(page).count();
  await page.screenshot({ path: `${PROOF}/02-review-after-reload.png`, fullPage: true });

  expect(after, "pending reviews must survive a full reload").toBe(before);
  const badgeText = (await badge(page).textContent())?.trim();
  expect(Number(badgeText), "badge count must equal the rows rendered in Check these").toBe(after);

  // Approve-after-reload writes the alias + counts the item (proves the rehydrated review is fully usable).
  const firstRow = reviewRows(page).first();
  await firstRow.getByTestId("open-create").click();
  await firstRow.getByLabel("product name").fill("Rehydrated Test Product");
  await firstRow.getByTestId("create-save").click();
  await page.waitForTimeout(300);

  // The open badge drops by one (the rehydrated review was resolved), and the item is now counted.
  await expect(badge(page)).toHaveText(String(after - 1));
  await page.goto("/scan"); // FinalCountTable (the counts) lives on the scan page
  await expect(page.getByTestId("final-count-body")).toContainText("Rehydrated Test Product");
  await page.screenshot({ path: `${PROOF}/03-approved-after-reload-counted.png`, fullPage: true });
});
