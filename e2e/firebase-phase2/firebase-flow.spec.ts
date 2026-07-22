import { test, expect, type Page } from "@playwright/test";
import {
  adminDb,
  BIZ,
  EMAIL,
  PASSWORD,
  KNOWN_PRODUCT_ID,
  KNOWN_BARCODE,
  ALIAS_CODE,
  UNKNOWN_CODE,
} from "./admin";

// Loop 7 proof: genuine end-to-end Firebase-backed flow against the EMULATOR, with REAL Auth-emulator
// sign-in through the login UI and REAL business-context wiring. Separate from the 11 mock specs.
// Screenshots -> e2e/proof/firebase-phase2/. Persistence is also asserted directly against the emulator
// via the Admin SDK (genuine cloud-shape proof; no fake proof).

const PROOF = "e2e/proof/firebase-phase2";

async function scan(page: Page, code: string) {
  // Use fill() + Enter to mimic a hardware scanner (value lands atomically, then Enter submits). This
  // avoids the input's 80ms no-Enter debounce fallback firing between simulated keystrokes when the main
  // thread is busy with cloud writes/re-renders - a test-harness artifact, not real scanner behavior.
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
}

async function waitDrained(page: Page) {
  // Cloud sync is async; wait until everything queued has reached the emulator before asserting/refresh.
  await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0", { timeout: 15_000 });
}

test("Firebase-backed end-to-end (real auth, real business context, survive-refresh)", async ({ page }) => {
  // Never call live AI in this run.
  const aiCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/ai-lookup") && r.method() === "POST") aiCalls.push(r.url());
  });

  // 1. REAL sign-in through the login UI (Auth emulator).
  await page.goto("/login");
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // 2. No business selected yet -> the gate shows a clear message (no fake context).
  await expect(page.getByTestId("business-context-banner")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/01-needs-business.png`, fullPage: true });

  // 3. Select the real business -> the gate wires setBusinessContext(businessId, realUid).
  await page.goto("/business");
  await page.getByTestId(`select-business-${BIZ}`).click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0); // context ready
  await expect(page.getByTestId("scanner-input")).toBeFocused(); // scanner focus intact
  await page.screenshot({ path: `${PROOF}/02-context-ready.png`, fullPage: true });

  // 4. Start a real count session (persists a CountSession for survive-refresh).
  await page.getByTestId("start-session").click();

  // 5. Scan a known product, then an alias code for the SAME product (two codes -> one product).
  await scan(page, KNOWN_BARCODE);
  await expect(page.getByTestId(`qty-${KNOWN_PRODUCT_ID}`)).toHaveText("1");
  await scan(page, ALIAS_CODE);
  await expect(page.getByTestId(`qty-${KNOWN_PRODUCT_ID}`)).toHaveText("2");

  // 6. Scan an unknown code -> Needs Review.
  await scan(page, UNKNOWN_CODE);
  await waitDrained(page);
  await page.screenshot({ path: `${PROOF}/03-scanned.png`, fullPage: true });

  // 7. Approve the unknown as a new product (+ approved alias). applyToCount counts it once.
  await page.goto("/review");
  const row = page.getByTestId(`review-row-${UNKNOWN_CODE}`);
  await expect(row).toBeVisible();
  await row.getByTestId("open-create").click();
  await row.getByLabel("product name").fill("FB Mystery");
  await row.getByTestId("create-save").click();
  await expect(row).toBeHidden(); // resolved rows leave the queue immediately (owner rule 2026-07-22)
  await waitDrained(page); // ensure SAVE_PRODUCT + RESOLVE_ALIAS reached the emulator before reloading /scan
  await page.screenshot({ path: `${PROOF}/04-approved.png`, fullPage: true });

  // 8. Rescan the now-learned code -> resolves Known (no new review), and appears in final counts.
  await page.goto("/scan");
  await scan(page, UNKNOWN_CODE);
  await expect(page.getByTestId("final-count-body")).toContainText("FB Mystery");
  await waitDrained(page);

  // 9. REFRESH: the session, counts, products, and aliases reload from Firestore (survive-refresh).
  await page.reload();
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
  await expect(page.getByTestId(`qty-${KNOWN_PRODUCT_ID}`)).toHaveText("2"); // counts persisted, not doubled
  await expect(page.getByTestId("final-count-body")).toContainText("FB Mystery"); // learned product persisted
  await expect(page.getByTestId("scanner-input")).toBeFocused(); // scanner focus still works after reload
  await page.screenshot({ path: `${PROOF}/05-after-refresh.png`, fullPage: true });

  // 10. Finish the session (persists completed state + audit), then export a CSV.
  await page.getByTestId("finish-session").click();
  await waitDrained(page);
  await page.getByTestId("export-menu-trigger").click(); // exports now live in the unified Export dropdown
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-final-counts").click(),
  ]);
  expect(download.suggestedFilename()).toBe("final-counts.csv");
  await download.saveAs(`${PROOF}/final-counts.csv`);
  await page.screenshot({ path: `${PROOF}/06-finished-exported.png`, fullPage: true });

  // No live AI was ever called.
  expect(aiCalls).toHaveLength(0);

  // ---- Genuine persistence proof: assert the EMULATOR state directly via the Admin SDK ----
  const db = adminDb();

  // Known product count line persisted with quantity 2 (idempotent: two scans, not doubled by reload).
  const knownCounts = await db.collection(`businesses/${BIZ}/inventoryCounts`).get();
  const knownLine = knownCounts.docs.map((d) => d.data()).find((c) => c.productId === KNOWN_PRODUCT_ID);
  expect(knownLine?.countedQuantity).toBe(2);

  // The learned alias for the unknown code persisted + approved, mapping to a new product.
  const aliases = (await db.collection(`businesses/${BIZ}/aliases`).get()).docs.map((d) => d.data());
  const learned = aliases.find((a) => a.cleanCode === UNKNOWN_CODE);
  expect(learned?.approved).toBe(true);
  const products = (await db.collection(`businesses/${BIZ}/products`).get()).docs.map((d) => d.data());
  expect(products.some((p) => p.name === "FB Mystery")).toBe(true);

  // A count session persisted and was completed.
  const sessions = (await db.collection(`businesses/${BIZ}/countSessions`).get()).docs.map((d) => d.data());
  expect(sessions.some((s) => s.status === "completed")).toBe(true);

  // Audit trail persisted (business-scoped, append-only collection).
  const audits = (await db.collection(`businesses/${BIZ}/auditLog`).get()).docs.map((d) => d.data());
  const actions = audits.map((a) => a.action);
  for (const expected of ["session_started", "session_completed", "unknown_review_created", "product_created", "csv_export"]) {
    expect(actions, `audit should include ${expected}`).toContain(expected);
  }
  expect(audits.every((a) => a.businessId === BIZ)).toBe(true);
});
