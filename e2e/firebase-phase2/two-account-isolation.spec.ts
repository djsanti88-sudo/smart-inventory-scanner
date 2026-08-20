import { test, expect, type Page } from "@playwright/test";
import {
  adminDb,
  TWO_ACCOUNT_A,
  TWO_ACCOUNT_B,
  type AccountTenantFixture,
} from "./admin";

const SELECTED_BUSINESS_KEY = "sis-selected-business-v1";

async function signIn(page: Page, fixture: AccountTenantFixture) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(fixture.email);
  await page.getByTestId("login-password").fill(fixture.password);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
  await expect(page.getByTestId("business-loading")).toHaveCount(0);
  await expect(page.getByTestId("scanner-input")).toBeVisible();
}

async function signOutVisibly(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login**");
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
}

async function waitDrained(page: Page) {
  await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0", { timeout: 45_000 });
}

async function expectActiveTenantOnly(
  page: Page,
  active: AccountTenantFixture,
  foreign: AccountTenantFixture,
  expectedQuantity: string,
) {
  await expect(page.getByTestId(`qty-${active.productId}`)).toHaveText(expectedQuantity);
  await expect(page.getByTestId("final-count-body")).toContainText(active.productName);
  await expect(page.getByTestId("final-count-body")).not.toContainText(foreign.productName);
  await expect(page.locator("main")).toContainText(active.markerBarcode);
  await expect(page.locator("main")).not.toContainText(foreign.markerBarcode);

  const state = await page.evaluate(() => {
    const store = (window as unknown as {
      __scanStore?: {
        getState: () => {
          businessId: string;
          userId: string | null;
          products: Array<{ id: string; businessId?: string; name?: string }>;
          scanFeed: Array<{ businessId?: string; cleanCode?: string }>;
          finalCounts: Array<{ businessId?: string; productId?: string }>;
          needsReviewQueue: Array<{ businessId?: string; cleanCode?: string }>;
        };
      };
    }).__scanStore;
    if (!store) throw new Error("scan store is not exposed in dev/e2e mode");
    const s = store.getState();
    return {
      selectedBusiness: window.localStorage.getItem("sis-selected-business-v1"),
      businessId: s.businessId,
      userId: s.userId,
      productNames: s.products.map((p) => p.name ?? ""),
      productBusinessIds: s.products.map((p) => p.businessId ?? ""),
      scanBusinessIds: s.scanFeed.map((e) => e.businessId ?? ""),
      scanCodes: s.scanFeed.map((e) => e.cleanCode ?? ""),
      countBusinessIds: s.finalCounts.map((c) => c.businessId ?? ""),
      countProductIds: s.finalCounts.map((c) => c.productId ?? ""),
      reviewBusinessIds: s.needsReviewQueue.map((r) => r.businessId ?? ""),
      reviewCodes: s.needsReviewQueue.map((r) => r.cleanCode ?? ""),
    };
  });

  expect(state.selectedBusiness).toBe(active.businessId);
  expect(state.businessId).toBe(active.businessId);
  expect(state.userId).toBe(active.uid);
  expect(state.productNames).toContain(active.productName);
  expect(state.productNames).not.toContain(foreign.productName);
  expect(state.productBusinessIds.every((id) => id === active.businessId)).toBe(true);
  expect(state.scanBusinessIds.every((id) => id === active.businessId)).toBe(true);
  expect(state.countBusinessIds.every((id) => id === active.businessId)).toBe(true);
  expect(state.reviewBusinessIds.every((id) => id === active.businessId)).toBe(true);
  expect(state.scanCodes).toContain(active.markerBarcode);
  expect(state.scanCodes).not.toContain(foreign.markerBarcode);
  expect(state.countProductIds).toContain(active.productId);
  expect(state.countProductIds).not.toContain(foreign.productId);
  expect(state.reviewCodes).not.toContain(`${foreign.label}-review-marker`);
}

async function expectEmulatorTenantScoped(
  active: AccountTenantFixture,
  foreign: AccountTenantFixture,
  expectedQuantity: number,
) {
  const db = adminDb();
  const [activeCounts, foreignCounts, activeEvents, foreignEvents] = await Promise.all([
    db.collection(`businesses/${active.businessId}/inventoryCounts`).get(),
    db.collection(`businesses/${foreign.businessId}/inventoryCounts`).get(),
    db.collection(`businesses/${active.businessId}/scanEvents`).get(),
    db.collection(`businesses/${foreign.businessId}/scanEvents`).get(),
  ]);
  const activeLine = activeCounts.docs.map((d) => d.data()).find((d) => d.productId === active.productId);
  const foreignLine = foreignCounts.docs.map((d) => d.data()).find((d) => d.productId === foreign.productId);
  expect(activeLine?.businessId).toBe(active.businessId);
  expect(activeLine?.countedQuantity).toBe(expectedQuantity);
  expect(foreignLine?.businessId).toBe(foreign.businessId);
  expect(activeEvents.docs.every((d) => d.data().businessId === active.businessId)).toBe(true);
  expect(foreignEvents.docs.every((d) => d.data().businessId === foreign.businessId)).toBe(true);
}

test("same browser sign-in A to B to A never leaks selected business, store state, or tenant data", async ({ page }) => {
  // Seed a stale selected business for B before A logs in. Login/provisioning may use it as a hint, but
  // the scan page must fail closed to A's verified membership and overwrite the shared selected key.
  await page.goto("/login");
  await page.evaluate(
    ({ key, staleBusinessId }) => window.localStorage.setItem(key, staleBusinessId),
    { key: SELECTED_BUSINESS_KEY, staleBusinessId: TWO_ACCOUNT_B.businessId },
  );

  await signIn(page, TWO_ACCOUNT_A);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B, "1");
  await scan(page, TWO_ACCOUNT_A.scanBarcode);
  await waitDrained(page);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B, "2");
  await expectEmulatorTenantScoped(TWO_ACCOUNT_A, TWO_ACCOUNT_B, 2);

  await signOutVisibly(page);
  await expect(page.locator("body")).not.toContainText(TWO_ACCOUNT_A.productName);

  await signIn(page, TWO_ACCOUNT_B);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_B, TWO_ACCOUNT_A, "1");
  await scan(page, TWO_ACCOUNT_B.scanBarcode);
  await waitDrained(page);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_B, TWO_ACCOUNT_A, "2");
  await expectEmulatorTenantScoped(TWO_ACCOUNT_B, TWO_ACCOUNT_A, 2);

  await signOutVisibly(page);
  await expect(page.locator("body")).not.toContainText(TWO_ACCOUNT_B.productName);

  await signIn(page, TWO_ACCOUNT_A);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B, "2");
  await expectEmulatorTenantScoped(TWO_ACCOUNT_A, TWO_ACCOUNT_B, 2);
});
