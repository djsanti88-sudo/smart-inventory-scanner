import { test, expect, type Page } from "./fixtures";

const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  openaiConfigured: false,
  mode: "off",
  dailyLimit: 200,
  missingKeys: ["OPENAI_API_KEY"],
  e2e: true,
};

const SAMPLE_POSITIONS = [1, 210, 211, 500, 1000] as const;
const SESSION_ID = "session-e2e-1000-navigation";

type StoreHandle = {
  getState: () => Record<string, unknown>;
  setState: (partial: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) => void;
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
  await page.waitForFunction(() => Boolean((window as unknown as { __scanStore?: StoreHandle }).__scanStore));
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

function cleanCodeFor(position: number) {
  return `910000${String(position).padStart(6, "0")}`;
}

function productNameFor(position: number) {
  return `Stable Local Product ${position}`;
}

async function forceHideFlush(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function writeFullPersistSnapshot(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const state = (window as unknown as { __scanStore: StoreHandle }).__scanStore.getState();
        const blob = JSON.stringify({ state, version: 14 });
        const stamp = String(Date.now() + 60_000);
        const userId = typeof state.userId === "string" && state.userId ? state.userId : null;
        const keys = ["sis-scan-v1", ...(userId ? [`sis-scan-${userId}`] : [])];
        for (const key of keys) {
          try {
            window.localStorage.setItem(key, blob);
            window.localStorage.setItem(`${key}::stamp`, stamp);
          } catch {
            // IndexedDB remains the primary path; ignore localStorage fallback failures.
          }
        }
        const req = indexedDB.open("sis-persist", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        req.onsuccess = () => {
          const tx = req.result.transaction("kv", "readwrite");
          const store = tx.objectStore("kv");
          for (const key of keys) {
            store.put(blob, key);
            store.put(stamp, `${key}::stamp`);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
        req.onerror = () => resolve();
      }),
  );
}

async function expectPersistedSnapshot(page: Page, label: string) {
  const readPersisted = async () => page.evaluate(
    () =>
      new Promise<{ source: "indexedDB" | "localStorage"; key: string; feed: number; products: number; currentSession: string | null }[]>((resolve) => {
        const keys = ["sis-scan-v1", "sis-scan-e2e-user"];
        const out: { source: "indexedDB" | "localStorage"; key: string; feed: number; products: number; currentSession: string | null }[] = [];
        const parse = (source: "indexedDB" | "localStorage", key: string, raw: unknown) => {
          if (raw == null) return;
          try {
            const parsed = JSON.parse(String(raw));
            out.push({
              source,
              key,
              feed: Array.isArray(parsed.state?.scanFeed) ? parsed.state.scanFeed.length : -1,
              products: Array.isArray(parsed.state?.products) ? parsed.state.products.length : -1,
              currentSession: parsed.state?.currentSession?.id ?? null,
            });
          } catch {
            out.push({ source, key, feed: -1, products: -1, currentSession: null });
          }
        };
        for (const key of keys) {
          parse("localStorage", key, window.localStorage.getItem(key));
        }
        const req = indexedDB.open("sis-persist", 1);
        req.onsuccess = () => {
          const tx = req.result.transaction("kv", "readonly");
          const store = tx.objectStore("kv");
          let remaining = keys.length;
          for (const key of keys) {
            const get = store.get(key);
            get.onsuccess = () => {
              parse("indexedDB", key, get.result);
              remaining -= 1;
              if (remaining === 0) resolve(out);
            };
            get.onerror = () => {
              remaining -= 1;
              if (remaining === 0) resolve(out);
            };
          }
        };
        req.onerror = () => resolve([]);
      }),
  );
  await expect
    .poll(async () => {
      const persisted = await readPersisted();
      return persisted.some((entry) => entry.source === "indexedDB" && entry.feed === 1000 && entry.products === 1000 && entry.currentSession === SESSION_ID);
    }, { message: `${label}: persisted full 1000-row IndexedDB snapshot`, timeout: 5_000 })
    .toBe(true);

  const persisted = await readPersisted();
  for (const entry of persisted) {
    expect(entry.feed, `${label}: persisted ${entry.source}/${entry.key} feed`).toBe(1000);
    expect(entry.products, `${label}: persisted ${entry.source}/${entry.key} products`).toBe(1000);
    expect(entry.currentSession, `${label}: persisted ${entry.source}/${entry.key} session`).toBe(SESSION_ID);
  }
}

async function seedThousandScanState(page: Page) {
  await page.evaluate(
    ({ sessionId }) => {
      const w = window as unknown as { __scanStore: StoreHandle };
      const current = w.__scanStore.getState();
      const now = new Date().toISOString();
      const businessId = String(current.businessId ?? "demo-business");
      const userId = String(current.userId ?? "e2e-user");
      const products = Array.from({ length: 1000 }, (_, index) => {
        const position = index + 1;
        const code = `910000${String(position).padStart(6, "0")}`;
        return {
          id: `prod-${position}`,
          businessId,
          name: `Stable Local Product ${position}`,
          brand: "Stable",
          category: "General",
          specsShort: "",
          specsFull: "",
          primarySku: `SKU-${position}`,
          primaryBarcode: code,
          gtin: "",
          upc: code,
          ean: "",
          vendorCodes: [],
          aliases: [code],
          imageUrl: "",
          productUrl: "",
          location: "Main",
          notes: "",
          status: "active",
          source: "human_review",
          confidence: 1,
          verified: true,
          provisional: false,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId,
          syncStatus: position <= 210 ? "synced" : "pending",
          idempotencyKey: `${businessId}:${sessionId}:prod-${position}:SAVE_PRODUCT`,
        };
      });
      const aliases = products.map((product, index) => {
        const position = index + 1;
        const code = `910000${String(position).padStart(6, "0")}`;
        return {
          id: `alias-${position}`,
          businessId,
          productId: product.id,
          rawCodeExample: code,
          cleanCode: code,
          normalizedCode: code,
          aliasType: "upc",
          source: "human_review",
          confidence: 1,
          approved: true,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          lastSeenAt: now,
          syncStatus: position <= 210 ? "synced" : "pending",
          idempotencyKey: `${businessId}:${sessionId}:alias-${position}:RESOLVE_ALIAS`,
        };
      });
      const scanFeed = products
        .map((product, index) => {
          const position = index + 1;
          const code = `910000${String(position).padStart(6, "0")}`;
          return {
            id: `event-${position}`,
            businessId,
            sessionId,
            rawCode: code,
            cleanCode: code,
            normalizedCandidates: [code],
            codeType: "upc",
            matchedProductId: product.id,
            matchType: "exact",
            status: "known",
            resolverStatus: "known",
            quantityAfterScan: 1,
            reason: "Seeded local pending navigation regression row.",
            createdAt: new Date(Date.parse(now) + position * 1000).toISOString(),
            syncStatus: position <= 210 ? "synced" : "pending",
            idempotencyKey: `${businessId}:${sessionId}:event-${position}:SAVE_SCAN_EVENT`,
            scanContext: "any",
          };
        })
        .reverse();
      const finalCounts = products.map((product, index) => {
        const position = index + 1;
        return {
          id: `count-${position}`,
          businessId,
          sessionId,
          productId: product.id,
          quantity: 1,
          lastScannedAt: now,
          aliasesSeen: [product.primaryBarcode],
          scanEventIds: [`event-${position}`],
          createdAt: now,
          updatedAt: now,
          syncStatus: position <= 210 ? "synced" : "pending",
          syncError: null,
          appliedIdempotencyKeys: [`${businessId}:${sessionId}:event-${position}:INCREMENT_COUNT`],
        };
      });
      const pendingSyncQueue = products.slice(210).flatMap((product, index) => {
        const position = index + 211;
        const code = `910000${String(position).padStart(6, "0")}`;
        return [
          {
            id: `pending-product-${position}`,
            businessId,
            sessionId,
            entityType: "Product",
            entityId: product.id,
            operation: "SAVE_PRODUCT",
            payload: product,
            status: "pending",
            retryCount: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            idempotencyKey: `${businessId}:${sessionId}:prod-${position}:SAVE_PRODUCT`,
            scanEventId: null,
          },
          {
            id: `pending-alias-${position}`,
            businessId,
            sessionId,
            entityType: "Alias",
            entityId: `alias-${position}`,
            operation: "RESOLVE_ALIAS",
            payload: aliases[position - 1],
            status: "pending",
            retryCount: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            idempotencyKey: `${businessId}:${sessionId}:alias-${position}:RESOLVE_ALIAS`,
            scanEventId: null,
          },
          {
            id: `pending-count-${position}`,
            businessId,
            sessionId,
            entityType: "InventoryCount",
            entityId: `${sessionId}_${product.id}`,
            operation: "INCREMENT_COUNT",
            payload: {
              sessionId,
              productId: product.id,
              delta: 1,
              alias: code,
              scanEventId: `event-${position}`,
              idempotencyKey: `${businessId}:${sessionId}:event-${position}:INCREMENT_COUNT`,
            },
            status: "pending",
            retryCount: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            idempotencyKey: `${businessId}:${sessionId}:event-${position}:INCREMENT_COUNT`,
            scanEventId: `event-${position}`,
          },
        ];
      });

      w.__scanStore.setState({
        businessId,
        userId,
        businessContextReady: true,
        businessDataLoaded: true,
        online: false,
        simulateSyncFailure: false,
        sessionId,
        currentSession: {
          id: sessionId,
          businessId,
          name: "1,000 Navigation Pending Regression",
          location: "Main",
          status: "active",
          startedAt: now,
          completedAt: null,
          createdBy: userId,
          notes: "",
          syncStatus: "pending",
          locked: false,
          lockedAt: null,
        },
        sessions: [{
          id: sessionId,
          businessId,
          name: "1,000 Navigation Pending Regression",
          location: "Main",
          status: "active",
          startedAt: now,
          completedAt: null,
          createdBy: userId,
          notes: "",
          syncStatus: "pending",
          locked: false,
          lockedAt: null,
        }],
        products,
        aliases,
        scanFeed,
        finalCounts,
        needsReviewQueue: [],
        pendingSyncQueue,
        syncedScanEventIds: scanFeed.filter((event) => event.syncStatus === "synced").map((event) => event.id),
        lastSyncError: "E2E controlled pending backlog",
        settings: {
          ...(current.settings as Record<string, unknown>),
          aiLookupEnabled: false,
          scanContext: "any",
          enablePendingSyncQueue: true,
          enableIdempotentSync: true,
        },
      });
    },
    { sessionId: SESSION_ID },
  );
  await page.waitForTimeout(400);
  await forceHideFlush(page);
  await writeFullPersistSnapshot(page);
  await expectPersistedSnapshot(page, "seed");
}

async function storeSummary(page: Page) {
  return page.evaluate(({ samples }) => {
    const state = (window as unknown as { __scanStore: StoreHandle }).__scanStore.getState();
    const products = state.products as Array<{ id: string; name?: string; primaryBarcode?: string }>;
    const feed = state.scanFeed as Array<{ id: string; cleanCode: string; matchedProductId?: string; quantityAfterScan?: number }>;
    const counts = state.finalCounts as Array<{ productId: string; quantity: number }>;
    const pending = state.pendingSyncQueue as Array<{ businessId?: string }>;
    const productById = new Map(products.map((product) => [product.id, product]));
    return {
      feedEvents: feed.length,
      summedQuantity: counts.reduce((sum, count) => sum + count.quantity, 0),
      productTotal: products.filter((product) => product.id.startsWith("prod-")).length,
      pendingCount: pending.filter((item) => item.businessId === state.businessId).length,
      blankJoinedRows: feed.filter((event) => !event.matchedProductId || !productById.get(event.matchedProductId)?.name).length,
      samples: samples.map((position) => {
        const code = `910000${String(position).padStart(6, "0")}`;
        const event = feed.find((row) => row.cleanCode === code);
        return {
          position,
          eventId: event?.id ?? null,
          productName: event?.matchedProductId ? productById.get(event.matchedProductId)?.name ?? null : null,
          quantityAfterScan: event?.quantityAfterScan ?? null,
        };
      }),
    };
  }, { samples: SAMPLE_POSITIONS });
}

async function expectVisibleWindowSamples(page: Page, label: string) {
  const feedBody = page.getByTestId("scan-feed-body");
  const countBody = page.getByTestId("final-count-body");
  await expect(feedBody, `${label}: visible newest feed code`).toContainText(cleanCodeFor(1000));
  await expect(feedBody, `${label}: visible newest feed identity`).toContainText(productNameFor(1000));
  await expect(countBody, `${label}: visible first count identity`).toContainText(productNameFor(1));
}

async function expectThousandState(
  page: Page,
  label: string,
  expectedPending: "nonzero" | "zero" = "nonzero",
  expandDomSamples = false,
) {
  await expect(page.getByTestId("business-loading"), `${label}: business-loading flash must not render`).toHaveCount(0);
  await expect(page.getByTestId("scanner-input"), `${label}: scanner focus`).toBeFocused();
  await expect(page.locator("text=/1000 scans/"), `${label}: visible feed total`).toBeVisible();
  await expect(page.locator("text=/1000 of 1000 products/"), `${label}: visible product total`).toBeVisible();
  await expectVisibleWindowSamples(page, label);
  if (expandDomSamples) {
    while (await page.getByTestId("feed-show-more").isVisible().catch(() => false)) {
      await page.getByTestId("feed-show-more").click({ timeout: 10_000 });
    }
    while (await page.getByTestId("counts-show-more").isVisible().catch(() => false)) {
      await page.getByTestId("counts-show-more").click({ timeout: 10_000 });
    }
    await page.getByTestId("scanner-input").focus();
    await expect(page.getByTestId("scanner-input"), `${label}: scanner focus after sample expansion`).toBeFocused();
    for (const position of SAMPLE_POSITIONS) {
      await expect(page.getByTestId("scan-feed-body"), `${label}: feed sample ${position}`).toContainText(cleanCodeFor(position));
      await expect(page.getByTestId("final-count-body"), `${label}: count sample ${position}`).toContainText(productNameFor(position));
    }
  }
  const summary = await storeSummary(page);
  expect(summary.feedEvents, `${label}: store feed events`).toBe(1000);
  expect(summary.summedQuantity, `${label}: summed quantity`).toBe(1000);
  expect(summary.productTotal, `${label}: product total`).toBe(1000);
  expect(summary.blankJoinedRows, `${label}: blank product join`).toBe(0);
  if (expectedPending === "nonzero") expect(summary.pendingCount, `${label}: pending count`).toBeGreaterThan(0);
  else expect(summary.pendingCount, `${label}: pending drained`).toBe(0);
  for (const sample of summary.samples) {
    expect(sample.productName, `${label}: sample ${sample.position} identity`).toBe(productNameFor(sample.position));
    expect(sample.quantityAfterScan, `${label}: sample ${sample.position} row quantity`).toBe(1);
  }
  await expectPersistedSnapshot(page, label);
}

async function navigateBackToScan(page: Page, label: string) {
  const targetHref = `/${label.toLowerCase()}`;
  const targetLink = page.locator(`header nav a[href="${targetHref}"]`);
  await expect(targetLink).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await targetLink.click();
  await expect(page).toHaveURL(new RegExp(`${targetHref}$`));
  await expect(page.getByTestId("business-loading")).toHaveCount(0);
  const scanLink = page.locator('header nav a[href="/scan"]');
  await expect(scanLink).toBeVisible();
  await scanLink.click();
  await expect(page).toHaveURL(/\/scan$/);
  await expectThousandState(page, `after ${label}`);
}

test("1,000 pending local scans survive navigation and reload without persistence self-heal", async ({ page }) => {
  test.setTimeout(120_000);
  await stubAiLookup(page);
  await login(page);
  await seedThousandScanState(page);
  await expectThousandState(page, "seeded baseline");

  for (let loop = 1; loop <= 3; loop += 1) {
    await navigateBackToScan(page, `History`);
    await navigateBackToScan(page, `Reconcile`);
    await navigateBackToScan(page, `Settings`);
    await expectThousandState(page, `navigation loop ${loop}`);
  }

  await page.waitForTimeout(400);
  await forceHideFlush(page);
  await page.reload();
  if (!page.url().includes("/scan")) {
    await login(page);
  } else {
    await page.waitForFunction(() => Boolean((window as unknown as { __scanStore?: StoreHandle }).__scanStore));
    await expect(page.getByTestId("scanner-input")).toBeFocused();
  }
  await expectThousandState(page, "after hard reload", "nonzero", true);
});
