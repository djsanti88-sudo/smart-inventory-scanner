import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  adminDb,
  EMAIL,
  PASSWORD,
  UID,
  PILOT_BIZ,
  PILOT_COUNTER_UID,
  PILOT_VIEWER_UID,
  PILOT_TIRE_PRODUCT_ID,
  PILOT_TIRE_BARCODE,
  PILOT_TIRE_SKU,
  PILOT_TIRE_UNKNOWN,
} from "./admin";

// Stage 2 - CONTROLLED AUTOMATED PILOT (not a physical shop pilot). Drives the REAL app against the
// Firebase EMULATOR through a tire-shop count session: known tire barcode, alias SKU, a legit repeat,
// an unknown tire approved into the catalog, survive-refresh, finish, and CSV export. Role membership
// (owner/counter/viewer) is seeded and asserted here; role ENFORCEMENT is proven at the rules layer in
// src/services/db/firebase/tenantIsolation.rules.test.ts and scripts/cloud-smoke.mjs. No live AI.

const PROOF = "e2e/proof/controlled-pilot";
const METRICS = "reports/benchmark/controlled_pilot_metrics.json";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
}
async function waitDrained(page: Page) {
  await expect(page.getByTestId("pending-count")).toContainText("Pending sync: 0", { timeout: 15_000 });
}

test("controlled automated pilot: tire count session, no double count, survive-refresh, export, audit, roles", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  const steps: Record<string, boolean> = {};
  const aiCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/ai-lookup") && r.method() === "POST") aiCalls.push(r.url());
  });

  // 1. Real sign-in (Auth emulator) + select the pilot tire business.
  await page.goto("/login");
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/business");
  await page.getByTestId(`select-business-${PILOT_BIZ}`).click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  await page.screenshot({ path: `${PROOF}/01-context-ready.png`, fullPage: true });
  steps.signInAndSelectBusiness = true;

  // 2. Start session, scan known tire barcode + alias SKU (two codes -> one tire).
  await page.getByTestId("start-session").click();
  await scan(page, PILOT_TIRE_BARCODE);
  await expect(page.getByTestId(`qty-${PILOT_TIRE_PRODUCT_ID}`)).toHaveText("1");
  await scan(page, PILOT_TIRE_SKU);
  await expect(page.getByTestId(`qty-${PILOT_TIRE_PRODUCT_ID}`)).toHaveText("2");
  steps.knownAndAliasResolve = true;

  // 3. Legit repeat scan (a second physical tire) -> increments to 3 (not a duplicate product row).
  await scan(page, PILOT_TIRE_BARCODE);
  await expect(page.getByTestId(`qty-${PILOT_TIRE_PRODUCT_ID}`)).toHaveText("3");
  steps.repeatIncrements = true;

  // 4. Unknown tire code -> Needs Review.
  await scan(page, PILOT_TIRE_UNKNOWN);
  await waitDrained(page);
  await page.screenshot({ path: `${PROOF}/02-scanned.png`, fullPage: true });

  // 5. Approve unknown as a new tire (+ approved alias).
  await page.goto("/review");
  const row = page.getByTestId(`review-row-${PILOT_TIRE_UNKNOWN}`);
  await expect(row).toBeVisible();
  await row.getByTestId("open-create").click();
  await row.getByLabel("product name").fill("Pilot Mystery Tire");
  await row.getByTestId("create-save").click();
  await expect(row).toContainText(/resolved|create_new/i);
  await waitDrained(page);
  steps.unknownApproved = true;

  // 6. Rescan the learned code -> resolves Known and appears in final counts.
  await page.goto("/scan");
  await scan(page, PILOT_TIRE_UNKNOWN);
  await expect(page.getByTestId("final-count-body")).toContainText("Pilot Mystery Tire");
  await waitDrained(page);
  steps.learnedCodeResolves = true;

  // 7. REFRESH: counts/products/aliases/session reload from Firestore; known tire stays at 3 (no double count).
  await page.reload();
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
  await expect(page.getByTestId(`qty-${PILOT_TIRE_PRODUCT_ID}`)).toHaveText("3");
  await expect(page.getByTestId("final-count-body")).toContainText("Pilot Mystery Tire");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  await page.screenshot({ path: `${PROOF}/03-after-refresh.png`, fullPage: true });
  steps.surviveRefreshNoDoubleCount = true;

  // 8. Finish session + export CSV (saved as the pilot sample).
  await page.getByTestId("finish-session").click();
  await waitDrained(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-final-counts").click(),
  ]);
  expect(download.suggestedFilename()).toBe("final-counts.csv");
  await download.saveAs(`${PROOF}/final-counts.csv`);
  await page.screenshot({ path: `${PROOF}/04-finished-exported.png`, fullPage: true });
  steps.finishAndExport = true;

  // No live AI was ever called in the pilot.
  expect(aiCalls).toHaveLength(0);
  steps.noLiveAi = true;

  // ---- Direct emulator assertions (genuine persistence + role proof) ----
  const db = adminDb();

  // Known tire counted to 3 (idempotent across reload), learned tire product + approved alias persisted.
  const counts = (await db.collection(`businesses/${PILOT_BIZ}/inventoryCounts`).get()).docs.map((d) => d.data());
  expect(counts.find((c) => c.productId === PILOT_TIRE_PRODUCT_ID)?.countedQuantity).toBe(3);
  const products = (await db.collection(`businesses/${PILOT_BIZ}/products`).get()).docs.map((d) => d.data());
  expect(products.some((p) => p.name === "Pilot Mystery Tire")).toBe(true);
  const aliases = (await db.collection(`businesses/${PILOT_BIZ}/aliases`).get()).docs.map((d) => d.data());
  expect(aliases.find((a) => a.cleanCode === PILOT_TIRE_UNKNOWN)?.approved).toBe(true);

  // Session completed + business-scoped audit trail.
  const sessions = (await db.collection(`businesses/${PILOT_BIZ}/countSessions`).get()).docs.map((d) => d.data());
  expect(sessions.some((s) => s.status === "completed")).toBe(true);
  const audits = (await db.collection(`businesses/${PILOT_BIZ}/auditLog`).get()).docs.map((d) => d.data());
  const actions = audits.map((a) => a.action);
  for (const expected of ["session_started", "session_completed", "unknown_review_created", "product_created", "csv_export"]) {
    expect(actions, `audit should include ${expected}`).toContain(expected);
  }
  expect(audits.every((a) => a.businessId === PILOT_BIZ)).toBe(true);
  steps.auditTrail = true;

  // Three roles seeded for the pilot business (enforcement proven at the rules layer).
  const owner = (await db.doc(`businessMembers/${PILOT_BIZ}_${UID}`).get()).data();
  const counter = (await db.doc(`businessMembers/${PILOT_BIZ}_${PILOT_COUNTER_UID}`).get()).data();
  const viewer = (await db.doc(`businessMembers/${PILOT_BIZ}_${PILOT_VIEWER_UID}`).get()).data();
  expect(owner?.role).toBe("owner");
  expect(counter?.role).toBe("counter");
  expect(viewer?.role).toBe("viewer");
  steps.threeRolesSeeded = true;

  // ---- Write the pilot metrics artifact ----
  const knownTireCount = counts.find((c) => c.productId === PILOT_TIRE_PRODUCT_ID)?.countedQuantity ?? 0;
  mkdirSync("reports/benchmark", { recursive: true });
  writeFileSync(
    METRICS,
    JSON.stringify(
      {
        pilotType: "controlled_automated_pilot",
        note: "Controlled automated pilot against the Firebase emulator. NOT a physical shop pilot.",
        business: PILOT_BIZ,
        roles: { owner: owner?.role, counter: counter?.role, viewer: viewer?.role },
        rolesEnforcementProvenIn: ["src/services/db/firebase/tenantIsolation.rules.test.ts", "scripts/cloud-smoke.mjs"],
        knownTireCountedQuantity: knownTireCount,
        doubleCountObserved: knownTireCount !== 3,
        learnedProductPersisted: products.some((p) => p.name === "Pilot Mystery Tire"),
        sessionCompleted: sessions.some((s) => s.status === "completed"),
        auditActions: actions,
        liveAiCalls: aiCalls.length,
        steps,
        proofDir: PROOF,
        exportedCsv: `${PROOF}/final-counts.csv`,
      },
      null,
      2,
    ) + "\n",
  );
});
