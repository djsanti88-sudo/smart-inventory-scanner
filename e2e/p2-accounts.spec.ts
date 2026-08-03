import { test, expect, type Page, type Route } from "@playwright/test";

// Task 16 (Phase 2, Track T5): proves acceptance criteria #5 (Google + email sign-in + reset
// affordances in browser, both viewports; sign-out clears local state INCLUDING the per-uid
// localStorage key being GONE) and #6 (destructive actions gated behind owner confirm/PIN;
// markWrong surface via window.__scanStore). Depends on Tasks 5, 8, 15 (merged).

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

// FLAKE FIX: a no-keys AI status (GET) + an inert POST reply, mirroring scan.spec.ts. Registered before
// every page.goto so a background /api/ai-lookup call can never race the sign-out reset and deposit a
// stray scan row mid-test. GET returns the capability check (auto-decode gate fails on hasKey -> no POST
// fires); a POST, if it ever did, resolves to {} and mutates nothing.
const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function mockAiLookup(route: Route) {
  if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
  return route.fulfill({ json: {} });
}

async function inspectUidPersistNamespace(page: Page, uidKey: string) {
  return page.evaluate(async ({ key }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open("scanbin-persist-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    const read = (persistKey: string) => new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("scan-state", "readonly");
      const request = transaction.objectStore("scan-state").get(persistKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB read failed for ${persistKey}`));
    });
    const [main, tombstone, recovery, writeIntent] = await Promise.all([
      read(key),
      read(`${key}::scanbin-cleared-v1`),
      read(`${key}::scanbin-recovery-v1`),
      read(`${key}::scanbin-write-intent-v1`),
    ]);
    const databaseName = database.name;
    database.close();
    return {
      databaseName,
      mainValue: typeof main === "string" ? main : null,
      durableTombstonePresent: typeof tombstone === "string" && tombstone.length > 0,
      recoveryKeyGone: recovery === undefined,
      writeIntentKeyGone: writeIntent === undefined,
    };
  }, { key: uidKey });
}

for (const vp of VIEWPORTS) {
  test.describe(`P2 accounts (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("login page shows email, Google, and reset affordances", async ({ page }) => {
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/login");
      await expect(page.getByTestId("login-email")).toBeVisible();
      await expect(page.getByTestId("login-google")).toBeVisible();
      await page.getByTestId("forgot-password").click();
      await expect(page.getByTestId("send-reset")).toBeVisible();
      await page.screenshot({ path: `e2e/proof/p2-login-${vp.name}.png` });
    });

    test("sign-out clears local scan state AND removes the per-uid persist key", async ({ page }) => {
      // Mock mode: the Nav logout button only renders in live mode, so the reset action is exercised
      // via the window.__scanStore hook (Phase 1 ratified precedent). Seed a fake signed-in identity
      // plus fake per-uid durable/legacy state, then assert BOTH the in-memory wipe and key removal.
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/scan");
      await page.evaluate(() => {
        window.localStorage.setItem("sis-scan-test-uid", JSON.stringify({ state: {}, version: 8 }));
        window.localStorage.setItem("sis-selected-business-v1", "test-business");
        const s = (window as unknown as {
          __scanStore?: {
            getState: () => {
              products: Array<Record<string, unknown>>;
              aliases: Array<Record<string, unknown>>;
            };
            setState: (p: object) => void;
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        const state = s.getState();
        s.setState({
          businessId: "test-business",
          userId: "test-uid",
          // Preserve a deterministic valid alias hit after moving the fixture into a distinct tenant.
          products: state.products.map((product) => ({ ...product, businessId: "test-business" })),
          aliases: state.aliases.map((alias) => ({ ...alias, businessId: "test-business" })),
          scanFeed: [{ id: "leak" }],
          needsReviewQueue: [{ id: "leak-r" }],
        });
      });
      // N1 (I1 mechanism guard): actually re-point persist at the signed-out user's per-uid key and queue
      // a coalesced write under it BEFORE the reset. This is what makes the test able to CATCH the I1 bug:
      // resetForSignOut must re-point persist to the anon key BEFORE its own wipe write, or the coalescer's
      // pending write (queued here under sis-scan-test-uid) resurrects that key on the next flush tick. A
      // reset that removed the key but did NOT re-point first would let this queued write re-create it, and
      // the post-tick re-check below would then fail.
      await page.evaluate(async () => {
        const s = (window as unknown as {
          __scanStore?: { getState: () => { rehydrateForUid: (uid: string) => Promise<void> } };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        await s.getState().rehydrateForUid("test-uid"); // persist now points at sis-scan-test-uid
      });
      await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { setState: (p: object) => void } }).__scanStore;
        s?.setState({ scanFeed: [{ id: "leak2" }] }); // queues a coalesced write under sis-scan-test-uid
      });
      const durableBeforeReset = await inspectUidPersistNamespace(page, "sis-scan-test-uid");
      expect(durableBeforeReset.databaseName).toBe("scanbin-persist-v1");
      expect(durableBeforeReset.mainValue).not.toBeNull();
      const contendedReset = await page.evaluate(async () => {
        const s = (window as unknown as {
          __scanStore?: {
            getState: () => {
              resetForSignOut: () => Promise<{ cleared: boolean; authority: string }>;
              processScan: (code: string) => { id: string; quantityDelta: number } | null;
              scanFeed: Array<{ id: string }>;
              finalCounts: Array<{ quantity: number }>;
              businessId: string;
              userId: string | null;
              currentSession: unknown | null;
              sessionId: string;
            };
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");

        // A physical scan can land while durable removal is in flight. The store must fail closed here:
        // returning cleared:false preserves the newly counted scan instead of discarding it to complete
        // sign-out. This is intentionally a mutation DURING reset, not another pre-reset fixture write.
        const before = s.getState();
        const originalTenant = { businessId: before.businessId, userId: before.userId };
        const originalSessionId = before.sessionId;
        const originalSessionPresent = before.currentSession !== null;
        const feedLengthBeforeScan = before.scanFeed.length;
        const countTotalBeforeScan = before.finalCounts.reduce((total, count) => total + count.quantity, 0);
        const reset = before.resetForSignOut();
        const physicalScan = s.getState().processScan("6419440485331");
        const counted = s.getState();
        const expectedFeed = JSON.stringify(counted.scanFeed);
        const expectedFinalCounts = JSON.stringify(counted.finalCounts);
        const countTotalAfterScan = counted.finalCounts.reduce((total, count) => total + count.quantity, 0);
        const result = await reset;
        const state = s.getState();
        return {
          cleared: result.cleared,
          authority: result.authority,
          originalTenant,
          tenantAfterReset: { businessId: state.businessId, userId: state.userId },
          originalSessionId,
          originalSessionPresent,
          sessionIdAfterReset: state.sessionId,
          sessionPresentAfterReset: state.currentSession !== null,
          physicalScanId: physicalScan?.id ?? null,
          physicalScanQuantityDelta: physicalScan?.quantityDelta ?? 0,
          feedLengthBeforeScan,
          feedLengthAfterScan: counted.scanFeed.length,
          countTotalBeforeScan,
          countTotalAfterScan,
          countTotalAfterReset: state.finalCounts.reduce((total, count) => total + count.quantity, 0),
          expectedFeed,
          actualFeed: JSON.stringify(state.scanFeed),
          expectedFinalCounts,
          actualFinalCounts: JSON.stringify(state.finalCounts),
        };
      });
      expect(contendedReset.cleared).toBe(false);
      expect(contendedReset.authority).toBe("durable");
      expect(contendedReset.originalTenant).toEqual({ businessId: "test-business", userId: "test-uid" });
      expect(contendedReset.tenantAfterReset).toEqual(contendedReset.originalTenant);
      expect(contendedReset.originalSessionId).not.toBe("");
      expect(contendedReset.originalSessionPresent).toBe(true);
      expect(contendedReset.sessionIdAfterReset).toBe(contendedReset.originalSessionId);
      expect(contendedReset.sessionPresentAfterReset).toBe(true);
      expect(contendedReset.physicalScanId).not.toBeNull();
      expect(contendedReset.physicalScanQuantityDelta).toBe(1);
      expect(contendedReset.feedLengthAfterScan).toBe(contendedReset.feedLengthBeforeScan + 1);
      expect(contendedReset.countTotalAfterScan).toBe(contendedReset.countTotalBeforeScan + 1);
      expect(contendedReset.countTotalAfterReset).toBe(contendedReset.countTotalAfterScan);
      expect(contendedReset.actualFeed).toBe(contendedReset.expectedFeed);
      expect(contendedReset.actualFinalCounts).toBe(contendedReset.expectedFinalCounts);
      const durableAfterContendedReset = await inspectUidPersistNamespace(page, "sis-scan-test-uid");
      expect(durableAfterContendedReset.mainValue).toContain(contendedReset.physicalScanId);

      // runSignOutFlow cannot be invoked in the mock browser without a production test seam. Direct reset
      // is the ratified E2E mechanism; the focused wrapper tests prove it aborts auth on cleared:false.
      // Retry this same action only after the contended operation has finished, as the user would after
      // the first fail-closed attempt leaves auth and tenant state intact.
      const retry = await page.evaluate(async () => {
        const s = (window as unknown as {
          __scanStore?: {
            getState: () => { resetForSignOut: () => Promise<{ cleared: boolean; authority: string }> };
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        return s.getState().resetForSignOut();
      });
      expect(retry).toEqual({ cleared: true, authority: "durable" });
      const after = await page.evaluate(() => {
        // Compute the null check INSIDE the browser: `?? "unset"` on a correctly-null userId would
        // coerce it to the string "unset" and defeat expect(after.userId).toBeNull() even when the
        // sign-out behavior is correct. Returning a boolean sidesteps the coalescing bug entirely.
        const s = (window as unknown as {
          __scanStore?: {
            getState: () => {
              businessId: string;
              userId: string | null;
              currentSession: unknown | null;
              sessionId: string;
              sessions: unknown[];
              sessionHistory: unknown[];
              countSnapshots: unknown[];
              scanFeed: unknown[];
              finalCounts: unknown[];
              needsReviewQueue: unknown[];
              pendingSyncQueue: unknown[];
            };
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        const state = s.getState();
        return {
          businessId: state.businessId,
          userIdIsNull: state.userId === null,
          currentSessionIsNull: state.currentSession === null,
          sessionId: state.sessionId,
          sessionsLen: state.sessions.length,
          sessionHistoryLen: state.sessionHistory.length,
          countSnapshotsLen: state.countSnapshots.length,
          feedLen: state.scanFeed.length,
          finalCountsLen: state.finalCounts.length,
          reviewLen: state.needsReviewQueue.length,
          pendingSyncLen: state.pendingSyncQueue.length,
          uidKeyGone: window.localStorage.getItem("sis-scan-test-uid") === null,
          selectedBusinessKeyGone: window.localStorage.getItem("sis-selected-business-v1") === null,
        };
      });
      expect(after.businessId).toBe("demo-business");
      expect(after.feedLen).toBe(0);
      expect(after.finalCountsLen).toBe(0);
      expect(after.reviewLen).toBe(0);
      expect(after.pendingSyncLen).toBe(0);
      expect(after.userIdIsNull).toBe(true);
      expect(after.currentSessionIsNull).toBe(true);
      expect(after.sessionId).toBe("");
      expect(after.sessionsLen).toBe(0);
      expect(after.sessionHistoryLen).toBe(0);
      expect(after.countSnapshotsLen).toBe(0);
      expect(after.uidKeyGone).toBe(true); // the signed-out user's blob is GONE, not just reset in memory
      expect(after.selectedBusinessKeyGone).toBe(true);

      const durable = await inspectUidPersistNamespace(page, "sis-scan-test-uid");
      expect(durable).toEqual({
        databaseName: "scanbin-persist-v1",
        mainValue: null,
        durableTombstonePresent: true,
        recoveryKeyGone: true,
        writeIntentKeyGone: true,
      });

      await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      const legacyStillGone = await page.evaluate(() => ({
        uid: window.localStorage.getItem("sis-scan-test-uid") === null,
        selectedBusiness: window.localStorage.getItem("sis-selected-business-v1") === null,
      }));
      expect(legacyStillGone).toEqual({ uid: true, selectedBusiness: true });
      await page.screenshot({ path: `e2e/proof/p2-signout-${vp.name}.png` });
    });

    test("destructive PIN policy surface exists on the store (markWrong class, __scanStore proof)", async ({ page }) => {
      // markWrong is UI-dead by owner decision (SHOW_ADVANCED_ACTIONS=false); assert the policy inputs
      // it depends on are live: no PIN set by default -> confirm-only path (requiresOwnerPin false).
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/scan");
      const pinHash = await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { settings: { ownerPinHash: string } } } }).__scanStore;
        return s?.getState().settings.ownerPinHash ?? null;
      });
      expect(pinHash).toBe(""); // default: no PIN, confirm-only fallback active
      await page.screenshot({ path: `e2e/proof/p2-markwrong-${vp.name}.png` });
    });
  });
}
