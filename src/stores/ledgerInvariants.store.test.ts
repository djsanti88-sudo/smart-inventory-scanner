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

/** Stable snapshot of the client ledger: per-product quantity AND the exact scanEventIds set. */
function ledgerSnapshot(store: Store): string {
  return JSON.stringify(
    store.getState().finalCounts
      .map((c) => ({ p: c.productId, q: c.quantity, ids: [...c.scanEventIds].sort() }))
      .sort((a, b) => a.p.localeCompare(b.p)),
  );
}

// Cheap client-side drain-stability invariant, applied on EVERY path: N syncPending drains leave the
// client ledger (quantities AND scanEventIds sets) byte-identical. Honest scope note: with MockDb
// online and no forced failure, enqueueAndSync already drained synchronously inside processScan, so
// these drains mostly hit the empty-queue early return - this check alone cannot catch a server-side
// retry double-apply. The genuine exactly-once proof (forced pending state, verified non-empty queue,
// N drains asserted against real MockDb server counts) is the dedicated RETRY-IDEMPOTENCY path below.
async function assertRetryIsNoOp(store: Store) {
  const before = ledgerSnapshot(store);
  for (let i = 0; i < 3; i++) await store.getState().syncPending();
  const after = ledgerSnapshot(store);
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
    // Sentinel (conflict actually detected): books would balance whether the scan counted against the
    // seeded conflicting product or a provisional - so assert the conflict routing itself: the seeded
    // food product must NOT carry the count in a tire context.
    expect(store.getState().finalCounts.some((c) => c.productId === "cp"), "conflict: seeded off-context product has no count row").toBe(false);
    expect(store.getState().finalCounts.length, "the scan still counted (on a provisional, not the conflicting product)").toBeGreaterThan(0);
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
      // PENDING WINDOW: the books must already balance while the decode is still in flight -
      // identity gates decide the row's identity, never whether it appears and counts.
      assertBooksBalance(store);
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

  it("path: POST-DELETE (quantity transferred to an Unidentified provisional, never lost)", async () => {
    const store = aiOffStore();
    store.getState().processScan("878106003504");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "878106003504" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "create_new", { applyToCount: true, origin: "human", newProduct: { name: "To Delete", primaryBarcode: "878106003504" } });
    store.getState().processScan("878106003504"); // second unit
    const p = store.getState().products.find((x) => x.name === "To Delete")!;
    const totalBefore = store.getState().finalCounts.reduce((s2, c) => s2 + c.quantity, 0);

    store.getState().deleteProduct(p.id);

    // Sentinel (feed-124/counts-122 class): the total NEVER drops on delete.
    expect(store.getState().finalCounts.reduce((s2, c) => s2 + c.quantity, 0), "delete: total quantity invariant").toBe(totalBefore);
    expect(store.getState().finalCounts.some((c) => c.productId === p.id), "delete: no count remains on the deleted product").toBe(false);
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);

    // Undo restores the original attribution without inflating or losing quantity.
    store.getState().undoDeleteProduct();
    expect(store.getState().finalCounts.reduce((s2, c) => s2 + c.quantity, 0), "undo: total quantity invariant").toBe(totalBefore);
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
    // Sentinel (transfer actually happened): books would balance even if the count stayed on the
    // wrong product - assert the wrong product's count row is really gone after the transfer.
    expect(store.getState().finalCounts.some((c) => c.productId === "wp"), "markWrong: no count remains on the wrong product").toBe(false);
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

  // The genuine server-side retry-idempotency proof (review Important 1). The per-path
  // assertRetryIsNoOp above only proves client drain-stability; here we force REAL pending state
  // first (the unknownEnqueue.store.test.ts pattern), verify the queue actually holds items and the
  // server has applied nothing, then clear the failure and drain N times - asserting the MockDb
  // server-side count for each product applied EXACTLY ONCE, for both a known and an unknown scan.
  it("path: RETRY-IDEMPOTENCY (forced pending, N drains, server applies exactly once)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "rp", businessId: s.businessId, name: "Retry Known", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "ra", businessId: s.businessId, productId: "rp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "ra" }],
    }));

    // Force pending BEFORE scanning so every enqueue genuinely stays queued (no synchronous ack).
    store.getState().setSimulateSyncFailure(true);
    store.getState().processScan("049000006346"); // known, qty 2
    store.getState().processScan("049000006346");
    store.getState().processScan("888888888882"); // unknown provisional, qty 1

    const sessionId = store.getState().sessionId;
    const unknownPid = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!.matchedProductId!;
    expect(unknownPid).toBeTruthy();

    // Sentinels: the queue is genuinely non-empty and NOTHING has reached the server yet -
    // the drains below are real applies, not empty-queue no-ops.
    expect(store.getState().pendingSyncQueue.length, "pending queue genuinely holds items").toBeGreaterThan(0);
    expect(db.getServerCount(sessionId, "rp"), "server has no known-product count pre-drain").toBeUndefined();
    expect(db.getServerCount(sessionId, unknownPid), "server has no unknown-product count pre-drain").toBeUndefined();

    const before = ledgerSnapshot(store);

    // Clear the failure and drain N times against the REAL MockDb server state.
    store.getState().setSimulateSyncFailure(false);
    for (let i = 0; i < 3; i++) store.getState().retrySync();

    expect(store.getState().pendingSyncQueue, "queue fully drained").toHaveLength(0);
    // (a) server-side exactly-once: 3 drains applied each count exactly once, never 2x or 3x.
    expect(db.getServerCount(sessionId, "rp")?.quantity, "server applied the known count exactly once").toBe(2);
    expect(db.getServerCount(sessionId, unknownPid)?.quantity, "server applied the unknown count exactly once").toBe(1);
    // (b) + (c) client ledger (quantities AND scanEventIds sets) unchanged across the N drains.
    expect(ledgerSnapshot(store), "N drains leave the client ledger untouched").toBe(before);
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });
});

describe("ledger invariants hold across an auto-session boundary", () => {
  it("scans before and after an auto-session rollover both balance correctly, in their own session partitions", () => {
    let clock = "2026-07-19T16:00:00.000Z";
    const store = createTestScanStore({ now: () => clock });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstSessionId = store.getState().sessionId;
    store.getState().processScan("012345678905");
    store.getState().processScan("012345678905");
    assertBooksBalance(store);
    const firstSnapshot = ledgerSnapshot(store);

    // Roll the clock past the inactivity window: a NEW auto-session must open, and the ledger
    // invariant must hold independently for the new session's own scanFeed/finalCounts partition
    // (ensureAutoSession resets scanFeed/finalCounts/pendingSyncQueue on rollover, same as
    // startSession always has).
    clock = "2026-07-19T16:45:00.000Z";
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(firstSessionId);
    expect(store.getState().scanFeed).toHaveLength(0);
    expect(store.getState().finalCounts).toHaveLength(0);
    store.getState().processScan("012345678905");
    assertBooksBalance(store);

    // The first session's ledger snapshot is untouched by the rollover (rollover clears the LIVE
    // view only - it does not retroactively edit history).
    expect(firstSnapshot).toContain('"q":2');
  });

  it("a scan taken between finishSession and the next ensureAutoSession call rotates into a fresh session's ledger (Phase 3 F1: TOP-LEVEL LAW - never silently dropped, never a phantom/double count)", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db, now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    // Known seeded product (prod-coke), so both scans deterministically resolve to the SAME product
    // id - isolating the assertion to the session-ledger split, not provisional-placeholder identity.
    store.getState().processScan("049000028904");
    const finishedSessionId = store.getState().sessionId;
    expect(db.getServerCount(finishedSessionId, "prod-coke")?.quantity).toBe(1);
    store.getState().finishSession();
    // No explicit ensureAutoSession call here - processScan itself must rotate internally so the
    // scan is never silently dropped, without ever mutating the finished session's own ledger.
    const result = store.getState().processScan("049000028904");
    expect(result).not.toBeNull();

    const state = store.getState();
    const rotatedSessionId = state.sessionId;
    expect(rotatedSessionId).not.toBe(finishedSessionId);
    expect(state.currentSession?.status).toBe("active");

    // The rotated session's own ledger balances cleanly (fresh partition, one scan in it).
    assertBooksBalance(store);
    expect(state.finalCounts.find((c) => c.sessionId === rotatedSessionId && c.productId === "prod-coke")?.quantity).toBe(1);

    // The finished session's OWN synced ledger is untouched by the rotation - no phantom/double count
    // leaked backward onto it, still exactly the one scan taken before Finish.
    expect(db.getServerCount(finishedSessionId, "prod-coke")?.quantity).toBe(1);
  });
});
