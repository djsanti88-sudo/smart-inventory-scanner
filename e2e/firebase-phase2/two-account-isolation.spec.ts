import { test, expect, type Page } from "@playwright/test";
import {
  adminDb,
  TWO_ACCOUNT_A,
  TWO_ACCOUNT_B,
  type AccountTenantFixture,
} from "./admin";

const SELECTED_BUSINESS_KEY = "sis-selected-business-v1";
const LEGACY_PERSIST_KEY = "sis-scan-v1";
const PERSIST_DB_NAME = "sis-persist";
const PERSIST_STORE_NAME = "kv";

type PersistSummary = {
  businessId: string;
  userId: string | null;
  productNames: string[];
  productBusinessIds: string[];
  scanBusinessIds: string[];
  scanCodes: string[];
  countBusinessIds: string[];
  countProductIds: string[];
  reviewBusinessIds: string[];
  reviewCodes: string[];
};

type PersistSnapshot = {
  inspectedKeys: string[];
  localStorage: Record<string, string | null>;
  indexedDB: Record<string, string | null>;
  parsed: Record<string, Partial<Record<"localStorage" | "indexedDB", PersistSummary | null>>>;
};

const persistKeyForUid = (uid: string) => `sis-scan-${uid}`;
const persistStampKey = (key: string) => `${key}::stamp`;

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

async function readPersistSnapshot(page: Page): Promise<PersistSnapshot> {
  const keys = [
    persistKeyForUid(TWO_ACCOUNT_A.uid),
    persistStampKey(persistKeyForUid(TWO_ACCOUNT_A.uid)),
    persistKeyForUid(TWO_ACCOUNT_B.uid),
    persistStampKey(persistKeyForUid(TWO_ACCOUNT_B.uid)),
    LEGACY_PERSIST_KEY,
    persistStampKey(LEGACY_PERSIST_KEY),
  ];

  return page.evaluate(
    async ({ keys, dbName, storeName }) => {
      type Summary = {
        businessId: string;
        userId: string | null;
        productNames: string[];
        productBusinessIds: string[];
        scanBusinessIds: string[];
        scanCodes: string[];
        countBusinessIds: string[];
        countProductIds: string[];
        reviewBusinessIds: string[];
        reviewCodes: string[];
      };
      type Snapshot = {
        inspectedKeys: string[];
        localStorage: Record<string, string | null>;
        indexedDB: Record<string, string | null>;
        parsed: Record<string, Partial<Record<"localStorage" | "indexedDB", Summary | null>>>;
      };

      const decodeRaw = (stored: string | null): string | null => {
        if (stored === null) return null;
        if (!stored.startsWith("sisv1:")) return stored;
        const rest = stored.slice("sisv1:".length);
        const separator = rest.indexOf(":");
        if (separator === -1) return stored;
        return rest.slice(separator + 1);
      };

      const asArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
      const summarize = (stored: string | null): Summary | null => {
        const raw = decodeRaw(stored);
        if (raw === null) return null;
        try {
          const parsed = JSON.parse(raw) as {
            state?: {
              businessId?: string;
              userId?: string | null;
              products?: Array<{ businessId?: string; name?: string }>;
              scanFeed?: Array<{ businessId?: string; cleanCode?: string }>;
              finalCounts?: Array<{ businessId?: string; productId?: string }>;
              needsReviewQueue?: Array<{ businessId?: string; cleanCode?: string }>;
            };
          };
          const state = parsed.state ?? {};
          return {
            businessId: state.businessId ?? "",
            userId: state.userId ?? null,
            productNames: asArray(state.products).map((p) => p.name ?? ""),
            productBusinessIds: asArray(state.products).map((p) => p.businessId ?? ""),
            scanBusinessIds: asArray(state.scanFeed).map((e) => e.businessId ?? ""),
            scanCodes: asArray(state.scanFeed).map((e) => e.cleanCode ?? ""),
            countBusinessIds: asArray(state.finalCounts).map((c) => c.businessId ?? ""),
            countProductIds: asArray(state.finalCounts).map((c) => c.productId ?? ""),
            reviewBusinessIds: asArray(state.needsReviewQueue).map((r) => r.businessId ?? ""),
            reviewCodes: asArray(state.needsReviewQueue).map((r) => r.cleanCode ?? ""),
          };
        } catch {
          return null;
        }
      };

      const localStorageValues: Record<string, string | null> = {};
      for (const key of keys) localStorageValues[key] = window.localStorage.getItem(key);

      const indexedDbValues: Record<string, string | null> = Object.fromEntries(keys.map((key) => [key, null]));
      if ("indexedDB" in window) {
        const hasKnownDb = await (async () => {
          if (typeof indexedDB.databases !== "function") return true;
          try {
            const databases = await indexedDB.databases();
            return databases.some((db) => db.name === dbName);
          } catch {
            return true;
          }
        })();

        if (hasKnownDb) {
          await new Promise<void>((resolve) => {
            const open = indexedDB.open(dbName);
            open.onerror = () => resolve();
            open.onupgradeneeded = () => {
              open.transaction?.abort();
              resolve();
            };
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains(storeName)) {
                db.close();
                resolve();
                return;
              }
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              for (const key of keys) {
                const request = store.get(key);
                request.onsuccess = () => {
                  indexedDbValues[key] = typeof request.result === "string" ? request.result : null;
                };
              }
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                resolve();
              };
            };
          });
        }
      }

      const parsed: Snapshot["parsed"] = {};
      for (const key of keys) {
        parsed[key] = {
          localStorage: summarize(localStorageValues[key]),
          indexedDB: summarize(indexedDbValues[key]),
        };
      }

      return {
        inspectedKeys: keys,
        localStorage: localStorageValues,
        indexedDB: indexedDbValues,
        parsed,
      };
    },
    { keys, dbName: PERSIST_DB_NAME, storeName: PERSIST_STORE_NAME },
  );
}

function persistedSummaries(snapshot: PersistSnapshot, key: string): PersistSummary[] {
  return Object.values(snapshot.parsed[key] ?? {}).filter((s): s is PersistSummary => Boolean(s));
}

function allPersistedBusinessIds(summary: PersistSummary): string[] {
  return [
    summary.businessId,
    ...summary.productBusinessIds,
    ...summary.scanBusinessIds,
    ...summary.countBusinessIds,
    ...summary.reviewBusinessIds,
  ].filter(Boolean);
}

function expectSummaryExcludes(summary: PersistSummary, foreign: AccountTenantFixture) {
  expect(allPersistedBusinessIds(summary)).not.toContain(foreign.businessId);
  expect(summary.productNames).not.toContain(foreign.productName);
  expect(summary.scanCodes).not.toContain(foreign.markerBarcode);
  expect(summary.scanCodes).not.toContain(foreign.scanBarcode);
  expect(summary.countProductIds).not.toContain(foreign.productId);
  expect(summary.reviewCodes).not.toContain(`${foreign.label}-review-marker`);
}

function expectPersistedKeyIsNamespaced(
  snapshot: PersistSnapshot,
  owner: AccountTenantFixture,
  foreign: AccountTenantFixture,
) {
  for (const summary of persistedSummaries(snapshot, persistKeyForUid(owner.uid))) {
    expectSummaryExcludes(summary, foreign);
    expect(allPersistedBusinessIds(summary).every((id) => id === owner.businessId)).toBe(true);
  }
}

async function expectPersistenceTenantOnly(
  page: Page,
  active: AccountTenantFixture,
  foreign: AccountTenantFixture,
) {
  const activeKey = persistKeyForUid(active.uid);
  await expect
    .poll(
      async () => {
        const snapshot = await readPersistSnapshot(page);
        return persistedSummaries(snapshot, activeKey).some((summary) => {
          return (
            allPersistedBusinessIds(summary).includes(active.businessId) &&
            summary.productNames.includes(active.productName) &&
            summary.scanCodes.includes(active.markerBarcode)
          );
        });
      },
      { message: `${active.label} per-uid persisted blob should hydrate/write`, timeout: 15_000 },
    )
    .toBe(true);

  const snapshot = await readPersistSnapshot(page);
  expect(snapshot.inspectedKeys).toEqual([
    persistKeyForUid(TWO_ACCOUNT_A.uid),
    persistStampKey(persistKeyForUid(TWO_ACCOUNT_A.uid)),
    persistKeyForUid(TWO_ACCOUNT_B.uid),
    persistStampKey(persistKeyForUid(TWO_ACCOUNT_B.uid)),
    LEGACY_PERSIST_KEY,
    persistStampKey(LEGACY_PERSIST_KEY),
  ]);

  expectPersistedKeyIsNamespaced(snapshot, TWO_ACCOUNT_A, TWO_ACCOUNT_B);
  expectPersistedKeyIsNamespaced(snapshot, TWO_ACCOUNT_B, TWO_ACCOUNT_A);

  for (const summary of persistedSummaries(snapshot, LEGACY_PERSIST_KEY)) {
    expectSummaryExcludes(summary, TWO_ACCOUNT_A);
    expectSummaryExcludes(summary, TWO_ACCOUNT_B);
    expect(allPersistedBusinessIds(summary)).not.toContain(TWO_ACCOUNT_A.businessId);
    expect(allPersistedBusinessIds(summary)).not.toContain(TWO_ACCOUNT_B.businessId);
  }

  const rawActiveBlobs = [snapshot.localStorage[activeKey], snapshot.indexedDB[activeKey]];
  expect(rawActiveBlobs.some((raw) => raw !== null)).toBe(true);
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
  await expectPersistenceTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B);
  await expectEmulatorTenantScoped(TWO_ACCOUNT_A, TWO_ACCOUNT_B, 2);

  await signOutVisibly(page);
  await expect(page.locator("body")).not.toContainText(TWO_ACCOUNT_A.productName);

  await signIn(page, TWO_ACCOUNT_B);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_B, TWO_ACCOUNT_A, "1");
  await scan(page, TWO_ACCOUNT_B.scanBarcode);
  await waitDrained(page);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_B, TWO_ACCOUNT_A, "2");
  await expectPersistenceTenantOnly(page, TWO_ACCOUNT_B, TWO_ACCOUNT_A);
  await expectEmulatorTenantScoped(TWO_ACCOUNT_B, TWO_ACCOUNT_A, 2);

  await signOutVisibly(page);
  await expect(page.locator("body")).not.toContainText(TWO_ACCOUNT_B.productName);

  await signIn(page, TWO_ACCOUNT_A);
  await expectActiveTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B, "2");
  await expectPersistenceTenantOnly(page, TWO_ACCOUNT_A, TWO_ACCOUNT_B);
  await expectEmulatorTenantScoped(TWO_ACCOUNT_A, TWO_ACCOUNT_B, 2);
});
