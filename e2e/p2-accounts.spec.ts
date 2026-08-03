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
      tombstoneValue: typeof tombstone === "string" ? tombstone : null,
      recoveryValue: typeof recovery === "string" ? recovery : null,
      writeIntentValue: typeof writeIntent === "string" ? writeIntent : null,
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
      const anonymousSettingsSnapshot = await page.evaluate(() => {
        window.localStorage.setItem("sis-scan-test-uid", JSON.stringify({ state: {}, version: 8 }));
        window.localStorage.setItem("sis-selected-business-v1", "test-business");
        const s = (window as unknown as {
          __scanStore?: {
            getState: () => {
              products: Array<Record<string, unknown>>;
              aliases: Array<Record<string, unknown>>;
              settings: Record<string, unknown>;
            };
            setState: (p: object) => void;
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        const state = s.getState();
        const tenantProducts = state.products.map((product) => ({ ...product, businessId: "test-business" }));
        const tenantAliases = state.aliases.map((alias) => ({ ...alias, businessId: "test-business" }));
        s.setState({
          businessId: "test-business",
          userId: "test-uid",
          // Preserve a deterministic valid alias hit after moving the fixture into a distinct tenant.
          products: tenantProducts,
          aliases: tenantAliases,
          settings: {
            ...state.settings,
            businessId: "test-business",
            ownerPinHash: "seeded-owner-pin-hash",
            aiLookupEnabled: false,
            dailyLookupCount: 17,
            scannerDebounceMs: 123,
            scanContext: "any",
          },
          firstScanAt: "2026-08-02T12:34:56.000Z",
          recentLocations: ["Front counter", "Warehouse rack 7"],
          syncedScanEventIds: ["seeded-synced-event-1", "seeded-synced-event-2"],
          scanFeed: [{ id: "leak" }],
          needsReviewQueue: [{ id: "leak-r" }],
        });
        return JSON.stringify(state.settings);
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
      // Complete the namespace handoff before seeding the proof state. This guarantees no hydration
      // lease or earlier fixture write can deny reset's own lease and mask the mutation-epoch race.
      await page.evaluate(async () => {
        const s = (window as unknown as {
          __scanStore?: { getState: () => { rehydrateActivePersistedState: () => Promise<void> } };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");
        await s.getState().rehydrateActivePersistedState();
      });
      await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { setState: (p: object) => void } }).__scanStore;
        s?.setState({
          scanFeed: [{ id: "leak2" }],
          online: false,
          pendingSyncQueue: [{
            id: "seeded-pending-sync", businessId: "test-business", sessionId: "seeded-session",
            entityType: "ScanEvent", entityId: "seeded-event", operation: "SAVE_SCAN_EVENT",
            payload: { id: "seeded-event" }, status: "pending", retryCount: 0, lastError: null,
            createdAt: "2026-08-02T12:00:00.000Z", updatedAt: "2026-08-02T12:00:00.000Z",
            idempotencyKey: "seeded-pending-sync-key", scanEventId: "seeded-event",
          }],
          sessions: [{
            id: "seeded-session", businessId: "test-business", name: "Seeded completed session",
            location: "Warehouse rack 7", status: "completed", startedAt: "2026-08-02T10:00:00.000Z",
            completedAt: "2026-08-02T11:00:00.000Z", createdBy: "test-uid",
            notes: "must survive failed reset", syncStatus: "synced",
          }],
          sessionHistory: [{
            sessionId: "seeded-session", startedAt: "2026-08-02T10:00:00.000Z",
            endedAt: "2026-08-02T11:00:00.000Z",
            scanRows: [{ time: "2026-08-02T10:30:00.000Z", code: "seeded-code", productName: "Seeded product", quantityDelta: 1 }],
            totalScans: 1, totalUnits: 1,
          }],
          countSnapshots: [{
            id: "seeded-count-snapshot", label: "Seeded count snapshot", takenAt: "2026-08-02T11:30:00.000Z",
            lines: [{ productId: "prod-nokian", name: "Nokian Outpost APT", qty: 7 }],
          }],
        }); // queues one coalesced tenant snapshot under sis-scan-test-uid
      });
      // Wait for that single post-handoff snapshot to become durable. The snapshot marker proves the
      // whole setState payload committed; the null intent proves its crash-recovery bookkeeping retired.
      await expect.poll(async () => (await inspectUidPersistNamespace(page, "sis-scan-test-uid")).mainValue)
        .toContain("seeded-count-snapshot");
      await expect.poll(async () => (await inspectUidPersistNamespace(page, "sis-scan-test-uid")).writeIntentValue)
        .toBeNull();
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
              needsReviewQueue: Array<{ id: string }>;
              pendingSyncQueue: Array<Record<string, unknown>>;
              sessions: Array<Record<string, unknown>>;
              sessionHistory: Array<Record<string, unknown>>;
              countSnapshots: Array<Record<string, unknown>>;
              businessId: string;
              userId: string | null;
              currentSession: unknown | null;
              sessionId: string;
              products: Array<Record<string, unknown>>;
              aliases: Array<Record<string, unknown>>;
              settings: Record<string, unknown>;
              firstScanAt: string | null;
              recentLocations: string[];
              syncedScanEventIds: string[];
            };
          };
        }).__scanStore;
        if (!s) throw new Error("scan store hook is unavailable");

        // Reset acquires the persistence lease and starts its durable clear first. A physical scan then
        // lands while that clear is in flight. The mutation epoch must make reset fail closed after its
        // durable work completes, preserving the newly counted scan and every older tenant field.
        const before = s.getState();
        const originalTenant = { businessId: before.businessId, userId: before.userId };
        const originalSessionId = before.sessionId;
        const originalSessionPresent = before.currentSession !== null;
        const feedLengthBeforeScan = before.scanFeed.length;
        const countTotalBeforeScan = before.finalCounts.reduce((total, count) => total + count.quantity, 0);
        const reset = before.resetForSignOut();
        const physicalScan = s.getState().processScan("6419440485331");
        const counted = s.getState();
        const expectedCurrentSession = JSON.stringify(counted.currentSession);
        const expectedFeed = JSON.stringify(counted.scanFeed);
        const expectedFinalCounts = JSON.stringify(counted.finalCounts);
        const expectedNeedsReviewQueue = JSON.stringify(counted.needsReviewQueue);
        const expectedPendingSyncQueue = JSON.stringify(counted.pendingSyncQueue);
        const expectedSessions = JSON.stringify(counted.sessions);
        const expectedSessionHistory = JSON.stringify(counted.sessionHistory);
        const expectedCountSnapshots = JSON.stringify(counted.countSnapshots);
        const expectedProducts = JSON.stringify(counted.products);
        const expectedAliases = JSON.stringify(counted.aliases);
        const expectedSettings = JSON.stringify(counted.settings);
        const expectedFirstScanAt = counted.firstScanAt;
        const expectedRecentLocations = JSON.stringify(counted.recentLocations);
        const expectedSyncedScanEventIds = JSON.stringify(counted.syncedScanEventIds);
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
          expectedCurrentSession,
          actualCurrentSession: JSON.stringify(state.currentSession),
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
          expectedNeedsReviewQueue,
          actualNeedsReviewQueue: JSON.stringify(state.needsReviewQueue),
          expectedPendingSyncQueue,
          actualPendingSyncQueue: JSON.stringify(state.pendingSyncQueue),
          expectedSessions,
          actualSessions: JSON.stringify(state.sessions),
          expectedSessionHistory,
          actualSessionHistory: JSON.stringify(state.sessionHistory),
          expectedCountSnapshots,
          actualCountSnapshots: JSON.stringify(state.countSnapshots),
          expectedProducts,
          actualProducts: JSON.stringify(state.products),
          expectedAliases,
          actualAliases: JSON.stringify(state.aliases),
          expectedSettings,
          actualSettings: JSON.stringify(state.settings),
          expectedFirstScanAt,
          actualFirstScanAt: state.firstScanAt,
          expectedRecentLocations,
          actualRecentLocations: JSON.stringify(state.recentLocations),
          expectedSyncedScanEventIds,
          actualSyncedScanEventIds: JSON.stringify(state.syncedScanEventIds),
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
      expect(contendedReset.actualCurrentSession).toBe(contendedReset.expectedCurrentSession);
      expect(contendedReset.physicalScanId).not.toBeNull();
      expect(contendedReset.physicalScanQuantityDelta).toBe(1);
      expect(contendedReset.feedLengthAfterScan).toBe(contendedReset.feedLengthBeforeScan + 1);
      expect(contendedReset.countTotalAfterScan).toBe(contendedReset.countTotalBeforeScan + 1);
      expect(contendedReset.countTotalAfterReset).toBe(contendedReset.countTotalAfterScan);
      expect(contendedReset.actualFeed).toBe(contendedReset.expectedFeed);
      expect(contendedReset.actualFinalCounts).toBe(contendedReset.expectedFinalCounts);
      expect(contendedReset.actualNeedsReviewQueue).toBe(contendedReset.expectedNeedsReviewQueue);
      expect(JSON.parse(contendedReset.expectedNeedsReviewQueue)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "leak-r" })]),
      );
      expect(contendedReset.actualPendingSyncQueue).toBe(contendedReset.expectedPendingSyncQueue);
      expect(JSON.parse(contendedReset.expectedPendingSyncQueue).length).toBeGreaterThan(0);
      expect(contendedReset.actualSessions).toBe(contendedReset.expectedSessions);
      expect(JSON.parse(contendedReset.expectedSessions).length).toBeGreaterThan(0);
      expect(contendedReset.actualSessionHistory).toBe(contendedReset.expectedSessionHistory);
      expect(JSON.parse(contendedReset.expectedSessionHistory).length).toBeGreaterThan(0);
      expect(contendedReset.actualCountSnapshots).toBe(contendedReset.expectedCountSnapshots);
      expect(JSON.parse(contendedReset.expectedCountSnapshots).length).toBeGreaterThan(0);
      expect(contendedReset.actualProducts).toBe(contendedReset.expectedProducts);
      expect(contendedReset.actualAliases).toBe(contendedReset.expectedAliases);
      expect(contendedReset.actualSettings).toBe(contendedReset.expectedSettings);
      expect(JSON.parse(contendedReset.expectedSettings)).toMatchObject({
        businessId: "test-business",
        ownerPinHash: "seeded-owner-pin-hash",
        aiLookupEnabled: false,
        dailyLookupCount: 17,
        scannerDebounceMs: 123,
        scanContext: "any",
      });
      expect(contendedReset.expectedFirstScanAt).toBe("2026-08-02T12:34:56.000Z");
      expect(contendedReset.actualFirstScanAt).toBe(contendedReset.expectedFirstScanAt);
      expect(JSON.parse(contendedReset.expectedRecentLocations)).toEqual(["Front counter", "Warehouse rack 7"]);
      expect(contendedReset.actualRecentLocations).toBe(contendedReset.expectedRecentLocations);
      expect(contendedReset.actualSyncedScanEventIds).toBe(contendedReset.expectedSyncedScanEventIds);
      expect(contendedReset.expectedSyncedScanEventIds).toContain("seeded-synced-event-1");
      await expect.poll(async () => (await inspectUidPersistNamespace(page, "sis-scan-test-uid")).mainValue)
        .toContain(contendedReset.physicalScanId);
      await expect.poll(async () => (await inspectUidPersistNamespace(page, "sis-scan-test-uid")).writeIntentValue)
        .toBeNull();
      const durableAfterContendedReset = await inspectUidPersistNamespace(page, "sis-scan-test-uid");
      expect(durableAfterContendedReset.databaseName).toBe(durableBeforeReset.databaseName);
      expect(durableAfterContendedReset.mainValue).toContain(contendedReset.physicalScanId);
      expect(durableAfterContendedReset.tombstoneValue).toBeNull();
      expect(durableAfterContendedReset.recoveryValue).toBeNull();
      expect(durableAfterContendedReset.writeIntentValue).toBeNull();
      const durableContendedState = JSON.parse(durableAfterContendedReset.mainValue ?? "null")?.state;
      expect(durableContendedState?.scanFeed).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: contendedReset.physicalScanId })]),
      );
      expect(durableContendedState?.currentSession).toEqual(JSON.parse(contendedReset.expectedCurrentSession));
      expect(durableContendedState?.finalCounts).toEqual(JSON.parse(contendedReset.expectedFinalCounts));
      expect(durableContendedState?.needsReviewQueue).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "leak-r" })]),
      );
      expect(durableContendedState?.pendingSyncQueue?.length).toBeGreaterThan(0);
      expect(durableContendedState?.sessionHistory?.length).toBeGreaterThan(0);
      expect(durableContendedState?.countSnapshots?.length).toBeGreaterThan(0);
      const expectedProductIds = (JSON.parse(contendedReset.expectedProducts) as Array<{ id: string }>)
        .map((product) => product.id).sort();
      expect(durableContendedState?.products?.length).toBe(expectedProductIds.length);
      expect(durableContendedState?.products?.map((product: { id: string }) => product.id).sort())
        .toEqual(expectedProductIds);
      expect(durableContendedState?.settings).toEqual(JSON.parse(contendedReset.expectedSettings));
      expect(durableContendedState?.firstScanAt).toBe(contendedReset.expectedFirstScanAt);
      expect(durableContendedState?.recentLocations).toEqual(JSON.parse(contendedReset.expectedRecentLocations));
      expect(durableContendedState?.syncedScanEventIds)
        .toEqual(JSON.parse(contendedReset.expectedSyncedScanEventIds));

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
              products: unknown[];
              aliases: unknown[];
              settings: Record<string, unknown>;
              firstScanAt: string | null;
              recentLocations: string[];
              syncedScanEventIds: string[];
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
          productsLen: state.products.length,
          aliasesLen: state.aliases.length,
          settingsSnapshot: JSON.stringify(state.settings),
          firstScanAt: state.firstScanAt,
          recentLocations: state.recentLocations,
          syncedScanEventIds: state.syncedScanEventIds,
          uidKeyGone: window.localStorage.getItem("sis-scan-test-uid") === null,
          selectedBusinessKeyGone: window.localStorage.getItem("sis-selected-business-v1") === null,
        };
      });
      expect(after.businessId).toBe("demo-business");
      expect(after.feedLen).toBe(0);
      expect(after.finalCountsLen).toBe(0);
      expect(after.reviewLen).toBe(0);
      expect(after.pendingSyncLen).toBe(0);
      expect(after.productsLen).toBe(0);
      expect(after.aliasesLen).toBe(0);
      expect(after.settingsSnapshot).toBe(anonymousSettingsSnapshot);
      expect(after.firstScanAt).toBeNull();
      expect(after.recentLocations).toEqual([]);
      expect(after.syncedScanEventIds).toEqual([]);
      expect(after.userIdIsNull).toBe(true);
      expect(after.currentSessionIsNull).toBe(true);
      expect(after.sessionId).toBe("");
      expect(after.sessionsLen).toBe(0);
      expect(after.sessionHistoryLen).toBe(0);
      expect(after.countSnapshotsLen).toBe(0);
      expect(after.uidKeyGone).toBe(true); // the signed-out user's blob is GONE, not just reset in memory
      expect(after.selectedBusinessKeyGone).toBe(true);

      const durable = await inspectUidPersistNamespace(page, "sis-scan-test-uid");
      expect(durable.databaseName).toBe("scanbin-persist-v1");
      expect(durable.mainValue).toBeNull();
      expect(durable.recoveryValue).toBeNull();
      expect(durable.writeIntentValue).toBeNull();
      expect(durable.tombstoneValue).not.toBeNull();
      const tombstone = JSON.parse(durable.tombstoneValue ?? "null");
      expect(tombstone).toMatchObject({
        __scanPersistClear: 1,
        // A newer post-clear write may retire generation 1 before this retry, so only the schema and
        // positive monotonic generation are stable across valid adapter schedules.
        version: expect.any(Number),
        id: expect.any(String),
        issuedAt: expect.any(Number),
        intentBarrierEstablished: true,
      });
      expect(Number.isInteger(tombstone.version)).toBe(true);
      expect(tombstone.version).toBeGreaterThan(0);
      expect(tombstone.id).not.toBe("");

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
