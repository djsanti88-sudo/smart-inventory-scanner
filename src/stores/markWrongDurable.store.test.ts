import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/inventory/replay";
import { buildIdempotencyKey as buildIdempotencyKeyForTest } from "@/inventory/idempotency";

// F-03 (audit remediation 2026-07-29): markWrong repoints local state (D2's total-quantity-invariant
// behavior, proven by markWrongTransfer.store.test.ts) but historically REUSED the original scan
// event's idempotency keys when repointing it onto the fresh "Unidentified item" provisional.
// FirebaseSyncTarget's applied-key dedupe stores the ORIGINAL marker (targetId = old productId); a
// replay with the SAME key but a DIFFERENT productId payload fails `markerMatches` and is rejected as
// idempotency_conflict (retryable:false) - the corrected cloud write never lands, so a reload / second
// device restores the WRONG cloud count. This test proves the durable ledger side (the pendingSyncQueue
// contract): the transfer must be a BALANCED pair using FRESH keys, never the original counting key.

function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const s = store.getState();
  const productId = "seed-wrong-durable-1";
  store.setState((prev) => ({
    products: [
      ...prev.products,
      {
        id: productId, businessId: s.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
        vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
        source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
      },
    ],
    aliases: [
      ...prev.aliases,
      {
        id: "alias-wrong-durable-1", businessId: s.businessId, productId, rawCodeExample: code, cleanCode: code,
        normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
        createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", lastSeenAt: s.sessionId,
        syncStatus: "synced", idempotencyKey: "seed-alias-wrong-durable-1",
      },
    ],
  }));
  return productId;
}

describe("F-03: markWrong is a durable balanced ledger transfer (fresh keys, never reused)", () => {
  it("preserves each fully trimmed code in its own source session without a synthetic extra scan", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const firstCode = "049000006399";
    const secondCode = "012345678905";
    const productId = seedKnown(store, firstCode);
    store.setState((previous) => ({
      aliases: [...previous.aliases, {
        ...previous.aliases.find((alias) => alias.productId === productId)!,
        id: "alias-wrong-durable-trimmed-second",
        rawCodeExample: secondCode,
        cleanCode: secondCode,
        normalizedCode: secondCode,
        idempotencyKey: "seed-alias-wrong-durable-trimmed-second",
      }],
    }));

    const firstEvent = store.getState().processScan(firstCode)!;
    const currentCount = store.getState().finalCounts.find((count) => count.productId === productId)!;
    const priorSessionId = "prior-session-all-trimmed-second-code";
    const priorCount = {
      ...currentCount,
      id: "prior-session-all-trimmed-second-code-count",
      sessionId: priorSessionId,
      quantity: 2,
      scanEventIds: ["trimmed-second-code-a", "trimmed-second-code-b"],
      aliasesSeen: [secondCode],
      appliedIdempotencyKeys: ["trimmed-second-code-key-a", "trimmed-second-code-key-b"],
    };
    store.setState((state) => ({
      scanFeed: state.scanFeed.filter((event) => event.id !== firstEvent.id),
      finalCounts: [...state.finalCounts, priorCount],
    }));
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "all trimmed distinct code/session transfer" });

    const provisionalsByCode = new Map(
      store.getState().products
        .filter((product) => product.provisional && [firstCode, secondCode].includes(product.primaryBarcode))
        .map((product) => [product.primaryBarcode, product.id]),
    );
    expect(provisionalsByCode.size).toBe(2);
    expect(store.getState().finalCounts.find((count) =>
      count.productId === provisionalsByCode.get(firstCode) && count.sessionId === currentCount.sessionId,
    )?.quantity).toBe(1);
    expect(store.getState().finalCounts.find((count) =>
      count.productId === provisionalsByCode.get(secondCode) && count.sessionId === priorSessionId,
    )?.quantity).toBe(2);

    const payloads = store.getState().pendingSyncQueue
      .filter((item) => item.operation === "INCREMENT_COUNT")
      .map((item) => item.payload as { productId: string; sessionId: string; quantityDelta: number });
    for (const sessionId of [currentCount.sessionId, priorSessionId]) {
      const net = payloads
        .filter((payload) =>
          payload.sessionId === sessionId &&
          (payload.productId === productId || [...provisionalsByCode.values()].includes(payload.productId)),
        )
        .reduce((total, payload) => total + payload.quantityDelta, 0);
      expect(net, `fully trimmed ${sessionId} transfer stays balanced`).toBe(0);
    }
    expect(store.getState().scanFeed.filter((event) => event.reason.includes("markWrong residual")))
      .toHaveLength(2);
  });

  it("does not double-count when every backing feed event was trimmed", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006399";
    const productId = seedKnown(store, code);
    const event = store.getState().processScan(code)!;
    const sourceCount = store.getState().finalCounts.find((count) => count.productId === productId)!;

    store.setState((state) => ({
      scanFeed: state.scanFeed.filter((candidate) => candidate.id !== event.id),
    }));
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "all backing feed rows trimmed" });

    const provisional = store.getState().products.find(
      (product) => product.provisional && product.primaryBarcode === code && product.id !== productId,
    )!;
    expect(provisional).toBeDefined();
    expect(
      store.getState().finalCounts.find(
        (count) => count.productId === provisional.id && count.sessionId === sourceCount.sessionId,
      )?.quantity,
    ).toBe(sourceCount.quantity);

    const transferPayloads = store.getState().pendingSyncQueue
      .filter((item) => item.operation === "INCREMENT_COUNT")
      .map((item) => item.payload as { productId: string; sessionId: string; quantityDelta: number })
      .filter(
        (payload) =>
          payload.sessionId === sourceCount.sessionId &&
          (payload.productId === productId || payload.productId === provisional.id),
      );
    expect(transferPayloads.reduce((total, payload) => total + payload.quantityDelta, 0)).toBe(0);
    expect(
      store.getState().scanFeed
        .filter((candidate) => candidate.matchedProductId === provisional.id)
        .reduce((total, candidate) => total + candidate.quantityDelta, 0),
    ).toBe(sourceCount.quantity);
  });

  it("durably repoints every retained code with a fresh event save instead of synthesizing a second-code residual", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const firstCode = "049000006399";
    const secondCode = "012345678905";
    const productId = seedKnown(store, firstCode);
    const state = store.getState();
    store.setState((previous) => ({
      aliases: [...previous.aliases, {
        ...previous.aliases.find((alias) => alias.productId === productId)!,
        id: "alias-wrong-durable-2",
        rawCodeExample: secondCode,
        cleanCode: secondCode,
        normalizedCode: secondCode,
        idempotencyKey: "seed-alias-wrong-durable-2",
      }],
    }));

    const firstEvent = store.getState().processScan(firstCode)!;
    const secondEvent = store.getState().processScan(secondCode)!;
    expect([firstEvent.cleanCode, secondEvent.cleanCode]).toEqual([firstCode, secondCode]);
    expect([firstEvent.matchedProductId, secondEvent.matchedProductId]).toEqual([productId, productId]);
    const originalSaveKeys = new Map([
      [firstEvent.id, buildIdempotencyKeyForTest(state.businessId, state.sessionId, firstEvent.id, "SAVE_SCAN_EVENT")],
      [secondEvent.id, buildIdempotencyKeyForTest(state.businessId, state.sessionId, secondEvent.id, "SAVE_SCAN_EVENT")],
    ]);

    store.getState().setSimulateSyncFailure(true);
    await store.getState().markWrong(productId, { reason: "two actual retained codes" });

    const transferProductsByCode = new Map(
      store.getState().products
        .filter((product) => product.provisional && [firstCode, secondCode].includes(product.primaryBarcode))
        .map((product) => [product.primaryBarcode, product.id]),
    );
    expect(transferProductsByCode.size).toBe(2);
    const saves = store.getState().pendingSyncQueue.filter((item) => item.operation === "SAVE_SCAN_EVENT");
    for (const event of [firstEvent, secondEvent]) {
      const saved = saves.find((item) => item.entityId === event.id);
      expect(saved, `retained ${event.cleanCode} event is durably saved`).toBeDefined();
      expect(saved!.idempotencyKey).not.toBe(originalSaveKeys.get(event.id));
      expect((saved!.payload as { cleanCode: string; matchedProductId: string }).cleanCode).toBe(event.cleanCode);
      expect((saved!.payload as { matchedProductId: string }).matchedProductId).toBe(transferProductsByCode.get(event.cleanCode));
    }
    expect(store.getState().scanFeed.some((event) => event.reason.includes("markWrong residual"))).toBe(false);

    const countPayloads = store.getState().pendingSyncQueue
      .filter((item) => item.operation === "INCREMENT_COUNT")
      .map((item) => item.payload as { productId: string; sessionId: string; quantityDelta: number });
    const transferIds = new Set(transferProductsByCode.values());
    const sessionNet = countPayloads
      .filter((payload) => payload.sessionId === state.sessionId && (payload.productId === productId || transferIds.has(payload.productId)))
      .reduce((total, payload) => total + payload.quantityDelta, 0);
    expect(sessionNet).toBe(0);
  });

  it("keeps a feed-trim residual credit in the source session when another code is retained", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006399";
    const secondCode = "012345678905";
    const productId = seedKnown(store, code);

    const currentEvent = store.getState().processScan(code)!;
    expect(currentEvent, "the active-session scan produced an event").toBeTruthy();
    const currentCount = store.getState().finalCounts.find((c) => c.productId === productId)!;
    const priorSessionId = "prior-session-with-trim";
    const priorCount = {
      ...currentCount,
      id: "prior-session-trimmed-count",
      sessionId: priorSessionId,
      quantity: 2,
      // The retained count represents two physical scans (including another code), but its feed
      // backing rows were persist-trimmed. markWrong must credit this session, not the active one.
      scanEventIds: ["trimmed-prior-event-a", "trimmed-prior-event-b"],
      aliasesSeen: [code, secondCode],
      appliedIdempotencyKeys: ["prior-session-trimmed-key-a", "prior-session-trimmed-key-b"],
    };
    store.setState((state) => ({ finalCounts: [...state.finalCounts, priorCount] }));
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "feed-trim session preservation" });

    const payloads = store.getState().pendingSyncQueue
      .filter((item) => item.operation === "INCREMENT_COUNT")
      .map((item) => item.payload as { productId: string; sessionId: string; quantityDelta: number });
    const unidentified = store.getState().products.find((p) => p.provisional && p.primaryBarcode === code)!;

    expect(unidentified).toBeDefined();
    for (const sessionId of [currentCount.sessionId, priorSessionId]) {
      const transferDelta = payloads
        .filter((payload) =>
          payload.sessionId === sessionId &&
          (payload.productId === productId || payload.productId === unidentified.id),
        )
        .reduce((total, payload) => total + payload.quantityDelta, 0);
      expect(transferDelta, `source session ${sessionId} has zero net transfer delta`).toBe(0);
    }
    expect(
      payloads.some((payload) =>
        payload.productId === unidentified.id &&
        payload.sessionId === priorSessionId &&
        payload.quantityDelta === 2,
      ),
      "the prior-session residual is credited to its source session",
    ).toBe(true);
  });

  it("balances every source session and preserves each repointed event's session", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006399";
    const productId = seedKnown(store, code);

    const currentEvent = store.getState().processScan(code)!;
    const currentCount = store.getState().finalCounts.find((c) => c.productId === productId)!;
    const priorSessionId = "prior-session";
    const priorEvent = {
      ...currentEvent,
      id: "prior-session-wrong-event",
      sessionId: priorSessionId,
      createdAt: "2026-07-28T12:00:00.000Z",
      quantityAfterScan: 1,
    };
    const priorCount = {
      ...currentCount,
      id: "prior-session-wrong-count",
      sessionId: priorSessionId,
      scanEventIds: [priorEvent.id],
      appliedIdempotencyKeys: ["prior-session-original-key"],
      createdAt: priorEvent.createdAt,
      updatedAt: priorEvent.createdAt,
      lastScannedAt: priorEvent.createdAt,
    };
    store.setState((state) => ({
      scanFeed: [priorEvent, ...state.scanFeed],
      finalCounts: [...state.finalCounts, priorCount],
    }));
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "cross-session test" });

    const counts = store.getState().pendingSyncQueue.filter((i) => i.operation === "INCREMENT_COUNT");
    const payloads = counts.map((i) => i.payload as { productId: string; sessionId: string; quantityDelta: number });
    for (const sessionId of [currentCount.sessionId, priorSessionId]) {
      expect(
        payloads.some((p) => p.productId === productId && p.sessionId === sessionId && p.quantityDelta === -1),
        `source session ${sessionId} gets its own durable zero-out`,
      ).toBe(true);
    }

    const unidentified = store.getState().products.find((p) => p.provisional && p.primaryBarcode === code)!;
    expect(unidentified).toBeDefined();
    for (const sessionId of [currentCount.sessionId, priorSessionId]) {
      expect(
        payloads.some((p) => p.productId === unidentified.id && p.sessionId === sessionId && p.quantityDelta === 1),
        `replacement count keeps source session ${sessionId}`,
      ).toBe(true);
    }
    const repointed = store.getState().scanFeed.filter((e) => e.matchedProductId === unidentified.id);
    expect(repointed.map((e) => e.sessionId)).toEqual(expect.arrayContaining([currentCount.sessionId, priorSessionId]));
    expect(store.getState().finalCounts.filter((c) => c.productId === unidentified.id).map((c) => c.sessionId))
      .toEqual(expect.arrayContaining([currentCount.sessionId, priorSessionId]));
    const repointedWrites = store.getState().pendingSyncQueue.filter(
      (i) => i.operation === "SAVE_SCAN_EVENT" && (i.payload as { matchedProductId?: string }).matchedProductId === unidentified.id,
    );
    expect(repointedWrites.map((i) => i.sessionId)).toEqual(expect.arrayContaining([currentCount.sessionId, priorSessionId]));
  });

  it("queues a balanced transfer with FRESH keys - never the original counting key - and replay lands on the corrected identity", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006399";
    const productId = seedKnown(store, code);

    // The scan syncs normally (default MockDb, no simulated failure) so its ORIGINAL keys are already
    // applied to the backend by the time markWrong runs - the exact real-world scenario F-03 fixes.
    const ev = store.getState().processScan(code); // counts against the (wrong) verified product
    expect(ev, "the scan produced an event").toBeTruthy();
    const originalCountingKey = buildIdempotencyKeyForTest(store.getState().businessId, store.getState().sessionId, ev!.id, "INCREMENT_COUNT");
    const originalSaveKey = buildIdempotencyKeyForTest(store.getState().businessId, store.getState().sessionId, ev!.id, "SAVE_SCAN_EVENT");
    expect(store.getState().pendingSyncQueue.length, "the scan's ops already synced (queue drained)").toBe(0);

    // Freeze sync so markWrong's OWN transfer ops are inspectable before MockDb's synchronous
    // auto-drain consumes them (same technique as correctProductSync.store.test.ts / the F-02 test).
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "test" });

    const q = store.getState().pendingSyncQueue;
    const counts = q.filter((i) => i.operation === "INCREMENT_COUNT");
    // Balanced transfer: at least a zero-out on the old identity AND a re-add on the new one.
    expect(counts.length, "balanced old- and new-identity writes queued").toBeGreaterThanOrEqual(2);
    expect(
      counts.every((i) => i.idempotencyKey !== originalCountingKey),
      "fresh transfer keys - never the original counting key",
    ).toBe(true);
    // A re-pointed SAVE_SCAN_EVENT with a FRESH key must also be queued (the event moved to the safe
    // placeholder) - never the original SAVE_SCAN_EVENT key (that one is still stamped against the wrong
    // product's applied-key marker and would be rejected as idempotency_conflict on replay).
    const savedEvents = q.filter((i) => i.operation === "SAVE_SCAN_EVENT");
    expect(
      savedEvents.some((i) => i.idempotencyKey !== originalSaveKey),
      "a fresh-keyed SAVE_SCAN_EVENT repoint is queued",
    ).toBe(true);

    // Old identity nets to zero (a decrement queued for it); new identity nets positive.
    const oldProductOps = counts.filter((i) => (i.payload as { productId?: string }).productId === productId);
    expect(oldProductOps.some((i) => (i.payload as { quantityDelta?: number }).quantityDelta! < 0), "old identity is zeroed out").toBe(true);

    const unidentified = store.getState().products.find((p) => p.provisional === true && p.primaryBarcode === code)!;
    expect(unidentified, "the transfer provisional exists").toBeDefined();
    const newProductOps = counts.filter((i) => (i.payload as { productId?: string }).productId === unidentified.id);
    expect(newProductOps.length, "the new identity receives counting ops").toBeGreaterThan(0);
    expect(newProductOps.every((i) => (i.payload as { quantityDelta?: number }).quantityDelta! > 0)).toBe(true);

    // Replay from feed events alone reconstructs the corrected identity (North-star #2), matching the
    // live store's own quantity - both halves of the ledger agree.
    const replayed = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId);
    const liveNewQty = store.getState().finalCounts.find((c) => c.productId === unidentified.id)?.quantity ?? 0;
    expect(replayed.find((c) => c.productId === unidentified.id)?.quantity ?? 0).toBe(liveNewQty);
    expect(replayed.find((c) => c.productId === productId)?.quantity ?? 0).toBe(0);
    expect(store.getState().finalCounts.find((c) => c.productId === productId)).toBeUndefined();
  });
});
