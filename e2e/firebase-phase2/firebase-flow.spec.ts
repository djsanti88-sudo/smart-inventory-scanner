import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  adminDb,
  BIZ,
  UID,
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
  // 45s: the drain's transient-failure retry backoff can exceed 15s on the emulator; the assertion
  // still demands a FULL drain, it just gives the backoff room (proven: the counter reaches 0).
  try {
    await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0", { timeout: 45_000 });
  } catch (error) {
    const pending = await page.evaluate(() => {
      type Pending = {
        entityType?: string;
        operation?: string;
        status?: string;
        retryCount?: number;
        lastError?: string | null;
      };
      const store = (window as unknown as {
        __scanStore?: { getState: () => { pendingSyncQueue?: Pending[] } };
      }).__scanStore;
      return (store?.getState().pendingSyncQueue ?? []).map((item) => ({
        entityType: item.entityType,
        operation: item.operation,
        status: item.status,
        retryCount: item.retryCount,
        lastError: item.lastError,
      }));
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nPending queue: ${JSON.stringify(pending)}`);
  }
}

async function clearPersistedUserSnapshot(page: Page, uid: string) {
  const key = `sis-scan-${uid}`;
  const stampKey = `${key}::stamp`;

  // Flush the coalesced persist writer first. Its IndexedDB transaction starts synchronously on this
  // warmed-up page; the read below resolves only after that write commits, so the following delete
  // cannot race an older queued write that would resurrect the local snapshot.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(
    (persistKey) => new Promise<boolean>((resolve) => {
      const request = indexedDB.open("sis-persist", 1);
      request.onsuccess = () => {
        const transaction = request.result.transaction("kv", "readonly");
        const get = transaction.objectStore("kv").get(persistKey);
        get.onsuccess = () => resolve(typeof get.result === "string");
        get.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    }),
    key,
  )).toBe(true);

  await page.evaluate(
    ({ persistKey, persistedStampKey }) => new Promise<void>((resolve, reject) => {
      localStorage.removeItem(persistKey);
      localStorage.removeItem(persistedStampKey);
      const request = indexedDB.open("sis-persist", 1);
      request.onsuccess = () => {
        const transaction = request.result.transaction("kv", "readwrite");
        const store = transaction.objectStore("kv");
        store.delete(persistKey);
        store.delete(persistedStampKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("persist snapshot delete failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("persist snapshot delete aborted"));
      };
      request.onerror = () => reject(request.error ?? new Error("persist database open failed"));
    }),
    { persistKey: key, persistedStampKey: stampKey },
  );
}

// The "Sessions and export" secondary controls are a collapsed <details> for real users (P4) and only
// auto-expand under the auth-bypass flag, which this REAL-login suite rightly does not set. Expand it
// exactly like a user would before touching session/export/sync controls (idempotent).
async function openSecondaryControls(page: Page) {
  const details = page.locator("details").filter({ hasText: "Sessions and export" });
  if (!(await details.getAttribute("open").then((v) => v !== null))) {
    await details.locator("summary").click();
  }
}

async function loginWithFirebaseUser(page: Page, loginUrl = "/login") {
  await page.goto(loginUrl);
  await page.getByTestId("login-email").fill(EMAIL);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
}

async function assertFirebaseRestoredInventory(page: Page) {
  try {
    await expect(page.getByTestId(`qty-${KNOWN_PRODUCT_ID}`)).toHaveText("2", { timeout: 45_000 });
    await expect(page.getByTestId("final-count-body")).toContainText("FB Mystery", { timeout: 45_000 });
    await expect(page.getByText("4 scans", { exact: true })).toBeVisible({ timeout: 45_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      type StoreState = {
        businessId?: string | null;
        userId?: string | null;
        businessContextReady?: boolean;
        businessDataLoaded?: boolean;
        lastSyncError?: string | null;
        products?: Array<{ id: string; name?: string }>;
        finalCounts?: Array<{ sessionId: string; productId: string; quantity: number }>;
        scanFeed?: Array<{ sessionId: string; cleanCode: string; matchedProductId: string | null }>;
        sessions?: Array<{ id: string; status?: string; startedAt?: string }>;
      };
      const store = (window as unknown as { __scanStore?: { getState: () => StoreState } }).__scanStore;
      const current = store?.getState();
      return current
        ? {
            businessId: current.businessId,
            userId: current.userId,
            businessContextReady: current.businessContextReady,
            businessDataLoaded: current.businessDataLoaded,
            lastSyncError: current.lastSyncError,
            products: current.products?.map((p) => ({ id: p.id, name: p.name })),
            finalCounts: current.finalCounts,
            scanFeed: current.scanFeed,
            sessions: current.sessions,
          }
        : null;
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nStore state: ${JSON.stringify(state)}`);
  }
}

async function proveLogoutReloginRestoresFirebaseState(page: Page) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await loginWithFirebaseUser(page);
  await assertFirebaseRestoredInventory(page);
}

async function proveFreshContextRestoresFirebaseState(browser: Browser, sourceSessionId: string) {
  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage();
    await loginWithFirebaseUser(freshPage, "http://localhost:3200/login");

    // Auto sessions are deliberately per-device; this proof does not require a second browser to
    // take over the first browser's active scan session. Persistence means that the original session
    // is loaded into the cloud session list and remains counted, inspectable, and exportable in History.
    await expect.poll(() => freshPage.evaluate((expectedId) => {
      type SessionState = {
        sessions?: Array<{ id: string; deviceId?: string }>;
      };
      const state = (window as unknown as {
        __scanStore?: { getState: () => SessionState };
      }).__scanStore?.getState();
      return state?.sessions?.some((session) => session.id === expectedId) ?? false;
    }, sourceSessionId), { timeout: 45_000 }).toBe(true);

    await freshPage.goto("http://localhost:3200/history");
    const sourceRow = freshPage.getByTestId(`history-row-${sourceSessionId}`);
    await expect(sourceRow).toBeVisible({ timeout: 45_000 });
    await expect(freshPage.getByTestId(`history-units-${sourceSessionId}`)).toHaveText("4", { timeout: 45_000 });
    await expect(freshPage.getByTestId(`history-products-${sourceSessionId}`)).toHaveText("2", { timeout: 45_000 });

    const downloadButton = freshPage.getByTestId(`history-download-${sourceSessionId}`);
    await expect(downloadButton).toBeEnabled({ timeout: 45_000 });
    const [download] = await Promise.all([
      freshPage.waitForEvent("download"),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toContain(sourceSessionId);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const exported = await readFile(downloadPath!, "utf8");
    expect(exported).toContain("FB Known Widget");
    expect(exported).toContain("FB Mystery");

    await sourceRow.click({ position: { x: 20, y: 20 } });
    await expect(freshPage).toHaveURL(new RegExp(`/sessions/${sourceSessionId}$`));
    await expect(freshPage.getByTestId("session-timeline-table").locator("tbody tr")).toHaveCount(4, { timeout: 45_000 });
    await freshPage.screenshot({ path: `${PROOF}/05c-fresh-context-restored.png`, fullPage: true });
  } finally {
    await freshContext.close();
  }
}

test("Firebase-backed end-to-end (real auth, real business context, survive-refresh) @shop-owner:real-auth-relogin @shop-owner:browser-context-restart", async ({ browser, page }) => {
  // Never call live AI in this run. Auto-decode MAY fire /api/ai-lookup (default settings), but
  // IS_E2E=1 forces the route mock-only - so the safety net asserts every response came from the
  // mock provider, not that zero calls happened (the old zero-calls assert predates auto-decode).
  // We track both the request URLs (decode was attempted - free/local rungs run even without paid
  // keys) and the response bodies (no live/paid provider ever returned data).
  const decodeCalls: string[] = [];
  const aiResponses: Array<Promise<unknown>> = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/ai-lookup")) decodeCalls.push(r.url());
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/ai-lookup") && r.request().method() === "POST") {
      aiResponses.push(r.json().catch(() => null));
    }
  });

  // 1. REAL sign-in through the login UI (Auth emulator).
  await loginWithFirebaseUser(page);

  // 2. The only valid membership is preserved and selected by the authenticated server flow.
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0); // context ready
  await expect(page.getByTestId("scanner-input")).toBeFocused(); // scanner focus intact
  await page.screenshot({ path: `${PROOF}/01-context-ready.png`, fullPage: true });

  // 4. Start a real count session (persists a CountSession for survive-refresh).
  await openSecondaryControls(page);
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
  await openSecondaryControls(page);
  await scan(page, UNKNOWN_CODE);
  await expect(page.getByTestId("final-count-body")).toContainText("FB Mystery");
  await waitDrained(page);

  // 9. EMPTY-DEVICE REFRESH: remove the user's local snapshot so the next page cannot satisfy these
  // assertions from IndexedDB/localStorage. The session, counts, products, aliases, and scan feed must
  // reconstruct from the Firebase emulator.
  await clearPersistedUserSnapshot(page, UID);
  await page.reload();
  await expect(page.getByTestId("business-context-banner")).toHaveCount(0);
  await expect(page.getByTestId(`qty-${KNOWN_PRODUCT_ID}`)).toHaveText("2"); // counts persisted, not doubled
  await expect(page.getByTestId("final-count-body")).toContainText("FB Mystery"); // learned product persisted
  await expect(page.getByText("4 scans", { exact: true })).toBeVisible(); // scan feed also rebuilt from Firestore
  await expect(page.getByTestId("scanner-input")).toBeFocused(); // scanner focus still works after reload
  await openSecondaryControls(page); // expand AFTER the focus assert - the summary click takes focus
  await page.screenshot({ path: `${PROOF}/05-after-refresh.png`, fullPage: true });

  // 9b. REAL auth logout/re-login must restore from the Firebase emulator after the sign-out wipe.
  // No new scan is performed, so the final Firestore scan-event invariant below remains exactly four
  // physical scans.
  await proveLogoutReloginRestoresFirebaseState(page);

  // 9c. FRESH BROWSER CONTEXT: a truly empty browser/device has no IndexedDB/localStorage app
  // snapshot. It must rebuild products/counts/feed from Firestore after signing in as the same user.
  // Check through the Admin SDK immediately beforehand so a failure distinguishes a server-write
  // defect from a fresh-client hydration defect. Same-browser Firestore can serve pending local-cache
  // writes, so its successful reload alone is not proof that another device can see the data.
  const preFreshDb = adminDb();
  const preFreshSessions = await preFreshDb.collection(`businesses/${BIZ}/countSessions`).get();
  const preFreshCounts = await preFreshDb.collection(`businesses/${BIZ}/inventoryCounts`).get();
  const preFreshEvents = await preFreshDb.collection(`businesses/${BIZ}/scanEvents`).get();
  expect(preFreshSessions.docs.some((doc) => doc.data().status === "active")).toBe(true);
  const sourceCount = preFreshCounts.docs.find((doc) => doc.data().productId === KNOWN_PRODUCT_ID);
  expect(sourceCount).toBeTruthy();
  const sourceSessionId = String(sourceCount!.data().countSessionId ?? "");
  expect(sourceSessionId).not.toBe("");
  expect(preFreshEvents.size).toBe(4);
  await proveFreshContextRestoresFirebaseState(browser, sourceSessionId);

  // 10. Open History/session detail before finishing: the active session's scan timeline must be
  // readable from Firestore after reload, not just the product-count summary.
  await Promise.all([
    page.waitForURL("**/history"),
    page.getByRole("link", { name: "History", exact: true }).click(),
  ]);
  const historyTable = page.getByTestId("history-table");
  const businessContextError = page.getByTestId("business-context-error");
  await expect(historyTable.or(businessContextError)).toBeVisible({ timeout: 120_000 });
  if (await businessContextError.isVisible()) {
    throw new Error(`History business bootstrap failed: ${await businessContextError.textContent()}`);
  }
  await expect(historyTable).toBeVisible();
  const activeHistoryRow = page.locator('[data-testid^="history-row-"]').first();
  await expect(activeHistoryRow).toContainText("4");
  await Promise.all([
    page.waitForURL("**/sessions/**"),
    activeHistoryRow.click({ position: { x: 20, y: 20 } }),
  ]);
  await expect(page.getByTestId("session-timeline-table").locator("tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("session-timeline-table")).toContainText(UNKNOWN_CODE);
  await page.screenshot({ path: `${PROOF}/05b-history-detail-timeline.png`, fullPage: true });
  await Promise.all([
    page.waitForURL("**/scan"),
    page.getByRole("link", { name: "Scan", exact: true }).click(),
  ]);

  // 11. Finish the session (persists completed state + audit), then export a CSV.
  await page.getByText("Sessions and export", { exact: true }).click();
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

  // Server decode was attempted, but in this Firebase proof it is mock-only (IS_E2E=1), not live AI.
  expect(decodeCalls.length).toBeGreaterThanOrEqual(1);

  // No LIVE AI was ever called: every ai-lookup response must come from the mock provider.
  // A whole-body string match is too broad here: the ladder honestly LABELS every rung it evaluated
  // (e.g. providerNames/ladderReasons naming "fetchv2" or "gpt") even when that rung was SKIPPED under
  // e2e mock mode (IS_E2E forces the route to wire only mockProvider - see api/ai-lookup/route.ts
  // e2eMode() branch), so those labels legitimately appear in a mock-only response. The real signal
  // that a rung actually EXECUTED and returned data is providerStatuses[].status === "ok" paired with
  // a non-mock provider name; a "skipped"/other status entry naming a paid provider is honest bookkeeping,
  // not a live call.
  const BANNED_LIVE_PROVIDERS = /go-?upc|fetchv2|firecrawl|openai|gemini|brave/i;
  const aiBodies = (await Promise.all(aiResponses)).filter(Boolean) as Array<Record<string, unknown>>;
  for (const b of aiBodies) {
    const statuses = Array.isArray((b as { providerStatuses?: unknown }).providerStatuses)
      ? ((b as { providerStatuses: Array<Record<string, unknown>> }).providerStatuses)
      : [];
    for (const st of statuses) {
      const provider = String(st.provider ?? "");
      const status = String(st.status ?? "");
      if (status === "ok") {
        expect(provider.toLowerCase(), "a live/paid provider must never report status=ok in e2e mock mode").not.toMatch(BANNED_LIVE_PROVIDERS);
        expect(provider.toLowerCase(), "any non-mock provider reporting status=ok is a live leak").toMatch(/mock/);
      }
    }
    // Debug/decision fields never claim a live provider VERIFIED evidence in mock mode.
    const decision = (b as { decision?: { evidenceStrength?: string } }).decision;
    if (decision?.evidenceStrength && decision.evidenceStrength !== "none") {
      const evidences = Array.isArray((b as { evidences?: unknown }).evidences)
        ? ((b as { evidences: Array<Record<string, unknown>> }).evidences)
        : [];
      for (const ev of evidences) {
        const sources = Array.isArray(ev.matchedSources) ? (ev.matchedSources as unknown[]).join(",") : "";
        if (ev.verified === true) {
          expect(sources.toLowerCase(), "verified evidence must never cite a live/paid provider in e2e mock mode").not.toMatch(BANNED_LIVE_PROVIDERS);
        }
      }
    }
  }

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

  // The four-event timeline exists in Firestore, not only in the browser's formerly persisted feed.
  const scanEvents = (await db.collection(`businesses/${BIZ}/scanEvents`).get()).docs.map((d) => d.data());
  expect(scanEvents).toHaveLength(4);
  expect(scanEvents.some((event) => event.cleanCode === UNKNOWN_CODE)).toBe(true);

  // Audit trail persisted (business-scoped, append-only collection).
  const audits = (await db.collection(`businesses/${BIZ}/auditLog`).get()).docs.map((d) => d.data());
  const actions = audits.map((a) => a.action);
  for (const expected of ["session_started", "session_completed", "unknown_review_created", "product_created", "csv_export"]) {
    expect(actions, `audit should include ${expected}`).toContain(expected);
  }
  expect(audits.every((a) => a.businessId === BIZ)).toBe(true);
});
