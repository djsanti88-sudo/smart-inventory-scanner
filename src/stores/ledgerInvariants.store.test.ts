import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";
import type { ScanEvent } from "@/types";

type Store = ReturnType<typeof createTestScanStore>;

// ---- Shared invariant assertions -----------------------------------------------------------------
function sumFeedDeltasByProduct(feed: ScanEvent[], sessionId: string): Map<string, number> {
  const seen = new Set<string>();
  const m = new Map<string, number>();
  for (const e of feed) {
    if (e.sessionId !== sessionId || !e.matchedProductId) continue;
    if (seen.has(e.id)) continue; // dedupe replayed ids exactly like the ledger
    seen.add(e.id);
    m.set(e.matchedProductId, (m.get(e.matchedProductId) ?? 0) + (e.quantityDelta ?? 0));
  }
  return m;
}

function assertBooksBalance(store: Store) {
  const { finalCounts, scanFeed, sessionId } = store.getState();
  // (1) per product: sum(feed deltas) === finalCounts.quantity
  const deltas = sumFeedDeltasByProduct(scanFeed, sessionId);
  for (const c of finalCounts) {
    expect(deltas.get(c.productId) ?? 0, `sum(feed deltas) === quantity for ${c.productId}`).toBe(c.quantity);
  }
  // (2) replay reproduces quantity AND exact scanEventIds set
  const replay = replayLedgerCounts(scanFeed, sessionId);
  for (const live of finalCounts) {
    const r = replay.find((x) => x.productId === live.productId);
    expect(r, `replay has a count for ${live.productId}`).toBeDefined();
    expect(r!.quantity, `replay quantity for ${live.productId}`).toBe(live.quantity);
    expect(new Set(live.scanEventIds), `replay scanEventIds for ${live.productId}`).toEqual(new Set(r!.scanEventIds));
  }
}

async function assertRetryIsNoOp(store: Store) {
  const before = JSON.stringify(store.getState().finalCounts.map((c) => ({ p: c.productId, q: c.quantity })).sort((a, b) => a.p.localeCompare(b.p)));
  for (let i = 0; i < 3; i++) await store.getState().syncPending();
  const after = JSON.stringify(store.getState().finalCounts.map((c) => ({ p: c.productId, q: c.quantity })).sort((a, b) => a.p.localeCompare(b.p)));
  expect(after, "N sync retries change nothing").toBe(before);
}

function aiOffStore(): Store {
  const s = createTestScanStore({ db: new MockDb() });
  s.getState().updateSettings({ aiLookupEnabled: false });
  return s;
}

// ---- The paths -----------------------------------------------------------------------------------
describe("Ledger invariant suite (books balance on every path)", () => {
  it("path: KNOWN (verified seed) scan", async () => {
    const store = aiOffStore();
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "kp", businessId: s.businessId, name: "Known", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "ka", businessId: s.businessId, productId: "kp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "ka" }],
    }));
    store.getState().processScan("049000006346");
    store.getState().processScan("049000006346");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: UNKNOWN-first (AI off)", async () => {
    const store = aiOffStore();
    store.getState().processScan("888888888882");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: UNKNOWN-repeat (same code twice, one product)", async () => {
    const store = aiOffStore();
    store.getState().processScan("888888888882");
    store.getState().processScan("888888888882");
    expect(store.getState().finalCounts.length).toBe(1);
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: MISREAD (bad GS1 check digit)", async () => {
    const store = aiOffStore();
    store.getState().processScan("036000291453"); // valid length, bad check digit
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: EXAMPLE / test barcode", async () => {
    const store = aiOffStore();
    store.getState().processScan("4006381333931"); // textbook GS1 example
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: CONFLICT (context-conflict known match still counts provisionally)", async () => {
    // Seed a verified product whose domain conflicts with the tire scan context.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "cp", businessId: s.businessId, name: "Hot Sauce", brand: "", category: "food", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "ca", businessId: s.businessId, productId: "cp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "ca" }],
    }));
    store.getState().processScan("049000006346");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: CAP-BLOCKED (daily cap genuinely reached today, AI on)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    // createTestScanStore pins now() to 2026-06-12 (scanStore.ts:5160). processScan resets dailyCount
    // to 0 unless lastResetDate === today's date on THAT clock - so this is the genuine cap-hit-after-
    // usage branch, not the silently-reset default (lastResetDate "1970-01-01" would count as 0 used).
    store.getState().updateSettings({ aiLookupEnabled: true, dailyLookupLimit: 1, dailyLookupCount: 1, lastResetDate: "2026-06-12" });
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: OFFLINE", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setOnline(false);
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: BREAKER-OPEN (emergency stop)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, emergencyStop: true });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: DECODE-IN-FLIGHT then failed (network throws)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"));
    } finally {
      globalThis.fetch = original;
    }
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-RESOLUTION (resolveUnknown create_new)", async () => {
    const store = aiOffStore();
    store.getState().processScan("878106003504");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "878106003504" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "create_new", { applyToCount: true, origin: "human", newProduct: { name: "Resolved" } });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-MARKWRONG (quantity transferred)", async () => {
    const store = aiOffStore();
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "wp", businessId: s.businessId, name: "Wrong", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "wa", businessId: s.businessId, productId: "wp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "wa" }],
    }));
    store.getState().processScan("049000006346");
    store.getState().processScan("049000006346");
    await store.getState().markWrong("wp", { reason: "test" });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-MERGE (two provisionals merged via resolveUnknown)", async () => {
    const store = aiOffStore();
    store.getState().processScan("111111111116");
    store.getState().processScan("222222222229");
    const target = store.getState().products.find((p) => p.primaryBarcode === "111111111116")!;
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "222222222229" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "link_existing", { applyToCount: true, origin: "human", productId: target.id });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });
});
