import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { buildPersistedScanState } from "@/stores/scanPersist";
import { replayLedgerCounts } from "@/services/inventory.replay";
import type { InventoryCount, InventorySession, PendingSyncItem, ScanEvent, UnknownCodeReview } from "@/types";

// Data-loss fix (critical): on a real page REFRESH with the cloud backend, BusinessContextGate
// re-resolves the SAME (businessId, userId) the store already holds and calls setBusinessContext
// again. setBusinessContext must NOT wipe scanFeed/finalCounts/needsReviewQueue/settings/
// firstScanAt/recentLocations when the tenant is unchanged - only an ACTUAL business/user switch
// wipes (isolation law, proven separately by businessSwitchReset.store.test.ts).

function scanEvent(id: string, productId: string, code: string): ScanEvent {
  return {
    id, businessId: "b1", sessionId: "s1", rawCode: code, cleanCode: code, normalizedCandidates: [],
    matchedProductId: productId, matchType: "primary_sku", status: "known", resolverStatus: "resolved",
    codeType: "numeric_sku", reason: "", quantityDelta: 1, quantityAfterScan: 1, createdAt: "t",
    source: "scan", notes: "", syncStatus: "synced", syncError: null, idempotencyKey: `k-${id}`,
  };
}

function count(productId: string, quantity: number, scanEventIds: string[]): InventoryCount {
  return {
    id: `count-${productId}`, businessId: "b1", sessionId: "s1", productId, quantity,
    lastScannedAt: "t", aliasesSeen: [], scanEventIds, createdAt: "t", updatedAt: "t",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

describe("setBusinessContext refresh must not wipe the current tenant's data", () => {
  it("(a) re-entering the SAME (businessId, userId) preserves scanFeed/finalCounts/needsReviewQueue", async () => {
    const laggingLoader = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ products: [], aliases: [], sessions: [], counts: [] }), 20)),
    );
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: laggingLoader });

    const ev1 = scanEvent("ev1", "p1", "111");
    const ev2 = scanEvent("ev2", "p2", "222");
    const review: UnknownCodeReview = {
      id: "rev1", businessId: "b1", rawCode: "333", cleanCode: "333", codeType: "unknown",
      status: "open", decodeStatus: "needs_review", reason: "unresolved", suggestedProductName: "",
      createdAt: "t", scanCount: 1, lastScannedAt: "t",
    } as unknown as UnknownCodeReview;

    // First entry (real sign-in): establishes the tenant.
    store.getState().setBusinessContext("b1", "u1");
    // Seed unsynced scan data as if a real session had already happened on this device.
    store.setState({
      scanFeed: [ev1, ev2],
      finalCounts: [count("p1", 1, ["ev1"]), count("p2", 1, ["ev2"])],
      needsReviewQueue: [review],
    });

    // REFRESH simulation: same uid re-resolves to the same business, setBusinessContext runs again
    // (this is exactly what BusinessContextGate does on every page load).
    store.getState().setBusinessContext("b1", "u1");

    expect(store.getState().scanFeed).toEqual([ev1, ev2]);
    expect(store.getState().finalCounts.map((c) => c.productId).sort()).toEqual(["p1", "p2"]);
    expect(store.getState().needsReviewQueue).toEqual([review]);

    // Let the lagging loader resolve too: it must not retroactively wipe anything either.
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getState().scanFeed).toEqual([ev1, ev2]);
    expect(store.getState().finalCounts.map((c) => c.productId).sort()).toEqual(["p1", "p2"]);
    expect(store.getState().needsReviewQueue).toEqual([review]);
  });

  it("(a3) the loader's session restore must NOT replace UNSYNCED local counts with the stale remote snapshot", async () => {
    // Same-tenant refresh in cloud mode where the remote DOES return the active session: the sync wipe
    // is (correctly) skipped by the guard above, but the async loadBusinessData block used to do
    // `next.finalCounts = data.counts.filter(...)` unconditionally - replacing a local qty-3 row (2
    // unsynced) with the remote's stale qty-1 snapshot while the preserved feed kept showing 3. The
    // restore must apply the refreshFromCloud-style pending-aware merge: unsynced local rows win.
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const staleRemoteCount: InventoryCount = { ...count("p1", 1, ["ev1"]), syncStatus: "synced" };
    const loader = vi.fn()
      .mockResolvedValueOnce({ products: [], aliases: [], sessions: [], counts: [] }) // first sign-in: empty tenant
      .mockResolvedValue({ products: [], aliases: [], sessions: [session], counts: [staleRemoteCount] });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: loader });

    store.getState().setBusinessContext("b1", "u1");
    await new Promise((r) => setTimeout(r, 0)); // let the first (empty) load settle

    // Local truth: qty 3 for p1 in s1, of which 2 increments are still UNSYNCED in the pending queue.
    const pendingIncrement = (id: string): PendingSyncItem => ({
      id: `pend-${id}`, businessId: "b1", sessionId: "s1", entityType: "InventoryCount",
      entityId: "count-p1", operation: "INCREMENT_COUNT",
      payload: { businessId: "b1", sessionId: "s1", productId: "p1", quantityDelta: 1, scanEventId: id, aliasUsed: "111" },
      status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t",
      idempotencyKey: `k-${id}`, scanEventId: id,
    });
    store.setState({
      currentSession: session,
      sessionId: "s1",
      scanFeed: [scanEvent("ev1", "p1", "111"), scanEvent("ev2", "p1", "111"), scanEvent("ev3", "p1", "111")],
      finalCounts: [{ ...count("p1", 3, ["ev1", "ev2", "ev3"]), syncStatus: "pending" }],
      pendingSyncQueue: [pendingIncrement("ev2"), pendingIncrement("ev3")],
    });

    // REFRESH: same tenant, remote now answers with the active session + its STALE qty-1 count row.
    store.getState().setBusinessContext("b1", "u1");
    await new Promise((r) => setTimeout(r, 10)); // let the loader resolve and apply

    const p1 = store.getState().finalCounts.find((c) => c.productId === "p1");
    expect(p1?.quantity, "unsynced local count wins over the stale remote snapshot").toBe(3);
    // Feed and counts must agree (the divergence class this guards against).
    expect(store.getState().scanFeed.length).toBe(3);
  });

  it("(a4) unsynced local counts from a DIFFERENT session than the restored one must not silently vanish (pendingSyncQueue-referenced + unsynced currentSession rows)", async () => {
    // The loader's pending-aware seed only ever looked at rows with sessionId === restored.id, so
    // local finalCounts rows belonging to any OTHER session were dropped outright by the restore
    // (not merged, not preserved - just gone), even when those rows carried unsynced work: either a
    // pendingSyncQueue item still references them, or they belong to the current (unsynced) session
    // which the remote does not yet know about. Widen the seed so unsynced local work never
    // silently vanishes on a business-context refresh.
    const restoredSession: InventorySession = {
      id: "s-restored", businessId: "b1", name: "Restored Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const loader = vi.fn()
      .mockResolvedValueOnce({ products: [], aliases: [], sessions: [], counts: [] }) // first sign-in: empty tenant
      .mockResolvedValue({ products: [], aliases: [], sessions: [restoredSession], counts: [] }); // remote knows nothing about the other session
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: loader });

    store.getState().setBusinessContext("b1", "u1");
    await new Promise((r) => setTimeout(r, 0)); // let the first (empty) load settle

    // Row A: belongs to a DIFFERENT session ("s-other"), still referenced by an unsynced pendingSyncQueue item.
    const otherSessionCount: InventoryCount = { ...count("p-other", 2, ["ev-other"]), sessionId: "s-other", syncStatus: "pending" };
    const pendingForOther: PendingSyncItem = {
      id: "pend-other", businessId: "b1", sessionId: "s-other", entityType: "InventoryCount",
      entityId: "count-p-other", operation: "INCREMENT_COUNT",
      payload: { businessId: "b1", sessionId: "s-other", productId: "p-other", quantityDelta: 2, scanEventId: "ev-other", aliasUsed: "555" },
      status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t",
      idempotencyKey: "k-other", scanEventId: "ev-other",
    };
    // Row B: belongs to cur.currentSession, which is itself unsynced and different from the restored session.
    const unsyncedCurrentSession: InventorySession = {
      id: "s-current", businessId: "b1", name: "Unsynced Session", location: "Bay B", status: "active",
      startedAt: "2026-01-02T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "pending",
    };
    const currentSessionCount: InventoryCount = { ...count("p-current", 1, ["ev-current"]), sessionId: "s-current", syncStatus: "pending" };

    store.setState({
      currentSession: unsyncedCurrentSession,
      sessionId: "s-current",
      finalCounts: [otherSessionCount, currentSessionCount],
      pendingSyncQueue: [pendingForOther],
    });

    // REFRESH: remote answers with a DIFFERENT active session (restoredSession), which is what would
    // normally happen if this device's own unsynced session had not yet reached the backend.
    store.getState().setBusinessContext("b1", "u1");
    await new Promise((r) => setTimeout(r, 10)); // let the loader resolve and apply

    const keys = store.getState().finalCounts.map((c) => `${c.sessionId}|${c.productId}`);
    expect(keys, "pendingSyncQueue-referenced row from another session survives").toContain("s-other|p-other");
    expect(keys, "unsynced currentSession's row survives").toContain("s-current|p-current");
  });

  it("(e) TRUE refresh: a persisted blob rehydrated into a FRESH store must still pass the same-tenant guard (userId round-trips)", () => {
    // The in-lifetime test (a) cannot catch a guard keyed on state the persist layer drops: on a real
    // page load the store starts EMPTY and only holds what rehydrate restores. Simulate the full
    // cycle: persist at customer ("business") level exactly like production -> fresh store ->
    // shallow-merge the blob (what zustand persist does) -> gate calls setBusinessContext.
    const mk = () =>
      createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    const store1 = mk();
    store1.getState().setBusinessContext("b1", "u1");
    store1.setState({
      scanFeed: [scanEvent("ev1", "p1", "111"), scanEvent("ev2", "p2", "222")],
      finalCounts: [count("p1", 1, ["ev1"]), count("p2", 1, ["ev2"])],
    });
    const blob = JSON.parse(JSON.stringify(buildPersistedScanState(store1.getState() as never, "business")));

    const store2 = mk(); // fresh page load: empty store
    store2.setState(blob as never); // zustand persist rehydrate = shallow merge of persisted keys
    store2.getState().setBusinessContext("b1", "u1"); // BusinessContextGate re-resolves the same tenant

    expect(store2.getState().scanFeed.length, "feed survives a true refresh").toBe(2);
    expect(store2.getState().finalCounts.length, "counts survive a true refresh").toBe(2);
  });

  it("(e3) fresh cloud load restores the active session scan feed from persisted scan events", async () => {
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Cloud Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const remoteEvent = scanEvent("ev-cloud", "p1", "086699205636");
    const remoteCount = count("p1", 1, ["ev-cloud"]);
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [session], counts: [remoteCount], scanEvents: [remoteEvent] }),
    });

    store.getState().setBusinessContext("b1", "u1");
    await vi.waitFor(() => expect(store.getState().businessDataLoaded).toBe(true));

    expect(store.getState().sessionId).toBe("s1");
    expect(store.getState().finalCounts.find((c) => c.productId === "p1")?.quantity).toBe(1);
    expect(store.getState().scanFeed.map((e) => e.id)).toEqual(["ev-cloud"]);
  });

  it("(e4) cloud feed restore preserves a same-session unsynced local scan row", async () => {
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Cloud Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const remoteEvent = { ...scanEvent("ev1", "p-remote", "086699205636"), reason: "stale remote" };
    const localEvent = { ...scanEvent("ev1", "p-local", "086699205636"), reason: "local corrected", syncStatus: "pending" as const };
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [session], counts: [count("p-local", 1, ["ev1"])], scanEvents: [remoteEvent] }),
    });

    store.setState({ businessId: "b1", userId: "u1", scanFeed: [localEvent] });
    store.getState().setBusinessContext("b1", "u1");
    await vi.waitFor(() => expect(store.getState().businessDataLoaded).toBe(true));

    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().scanFeed[0]).toMatchObject({ id: "ev1", matchedProductId: "p-local", reason: "local corrected" });
  });

  it("(e5) cloud feed restore replaces stale synced local rows and excludes other-session rows", async () => {
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Cloud Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const remoteEvent = { ...scanEvent("ev1", "p-remote", "086699205636"), reason: "remote canonical" };
    const staleLocal = { ...scanEvent("ev1", "p-local", "086699205636"), reason: "stale local", syncStatus: "synced" as const };
    const otherSessionLocal = {
      ...scanEvent("ev-other", "p-other", "222"),
      sessionId: "s-other",
      reason: "other session local row",
      syncStatus: "synced" as const,
    };
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [session], counts: [count("p-remote", 1, ["ev1"])], scanEvents: [remoteEvent] }),
    });

    store.setState({ businessId: "b1", userId: "u1", scanFeed: [staleLocal, otherSessionLocal] });
    store.getState().setBusinessContext("b1", "u1");
    await vi.waitFor(() => expect(store.getState().businessDataLoaded).toBe(true));

    expect(store.getState().scanFeed).toHaveLength(1);
    expect(store.getState().scanFeed[0]).toMatchObject({ id: "ev1", matchedProductId: "p-remote", reason: "remote canonical" });
  });

  it("(e6) cloud feed restore clears stale synced rows when the restored session has no remote scan events", async () => {
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Cloud Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
    };
    const staleSameSession = { ...scanEvent("ev-stale", "p-stale", "111"), reason: "stale local", syncStatus: "synced" as const };
    const staleOtherSession = {
      ...scanEvent("ev-other", "p-other", "222"),
      sessionId: "s-other",
      reason: "other session local row",
      syncStatus: "synced" as const,
    };
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [session], counts: [], scanEvents: [] }),
    });

    store.setState({ businessId: "b1", userId: "u1", scanFeed: [staleSameSession, staleOtherSession] });
    store.getState().setBusinessContext("b1", "u1");
    await vi.waitFor(() => expect(store.getState().businessDataLoaded).toBe(true));

    expect(store.getState().scanFeed).toEqual([]);
  });

  it("(e7) sync-status recompute tolerates legacy open review rows without idempotencyKey", async () => {
    const session: InventorySession = {
      id: "s1", businessId: "b1", name: "Cloud Session", location: "Main", status: "active",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdBy: "u1", notes: "", syncStatus: "pending",
    };
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    store.setState({
      businessContextReady: true,
      businessDataLoaded: true,
      businessId: "b1",
      userId: "u1",
      currentSession: session,
      sessionId: "s1",
      pendingSyncQueue: [{
        id: "pending-review-event", businessId: "b1", sessionId: "s1", entityType: "ScanEvent", entityId: "legacy-review",
        operation: "SAVE_SCAN_EVENT", payload: {}, status: "pending", retryCount: 0, lastError: null,
        createdAt: "t", updatedAt: "t", idempotencyKey: "pending-review-event", scanEventId: "legacy-review",
      }],
      needsReviewQueue: [{
        id: "legacy-review", businessId: "b1", rawCode: "999", cleanCode: "999", codeType: "unknown",
        status: "open", decodeStatus: "needs_review", reason: "legacy", suggestedProductName: "",
        createdAt: "t", scanCount: 1, lastScannedAt: "t",
      } as unknown as UnknownCodeReview],
    });

    expect(() => store.getState().syncPending()).not.toThrow();
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0].syncStatus).toBe("synced"));
  });

  it("(e2) a deliberate suggest_link HOLD survives a rehydrate cycle (stamp guard input persists)", () => {
    // The post-resolve stamp sites spare rows deliberately held open via suggestedLinkProductId
    // (identity-merge suggest_link path). That guard reads the stamp off the persisted review row,
    // so the hold must round-trip persist -> fresh store -> rehydrate -> setBusinessContext intact.
    const mk = () =>
      createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    const store1 = mk();
    store1.getState().setBusinessContext("b1", "u1");
    const heldReview = {
      id: "rev-hold", businessId: "b1", rawCode: "444", cleanCode: "444", codeType: "unknown",
      status: "open", decodeStatus: "suggested", reason: "possible match", suggestedProductName: "Existing Tire",
      suggestedLinkProductId: "p-existing", createdAt: "t", scanCount: 1, lastScannedAt: "t",
    } as unknown as UnknownCodeReview;
    store1.setState({ needsReviewQueue: [heldReview] });
    const blob = JSON.parse(JSON.stringify(buildPersistedScanState(store1.getState() as never, "business")));

    const store2 = mk(); // fresh page load
    store2.setState(blob as never); // zustand persist rehydrate = shallow merge
    store2.getState().setBusinessContext("b1", "u1");

    const after = store2.getState().needsReviewQueue.find((r) => r.id === "rev-hold");
    expect(after?.status, "held review stays open across a refresh").toBe("open");
    expect(
      (after as unknown as { suggestedLinkProductId?: string })?.suggestedLinkProductId,
      "the suggest_link hold stamp survives the rehydrate cycle",
    ).toBe("p-existing");
  });

  it("(b) an ACTUAL tenant switch still fully wipes (isolation law unchanged)", () => {
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    store.getState().setBusinessContext("b1", "u1");
    store.setState({
      scanFeed: [scanEvent("ev1", "p1", "111")],
      finalCounts: [count("p1", 1, ["ev1"])],
      needsReviewQueue: [{ id: "rev1" } as unknown as UnknownCodeReview],
    });

    store.getState().setBusinessContext("b2", "u2");

    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
    expect(store.getState().needsReviewQueue).toEqual([]);
    expect(store.getState().businessId).toBe("b2");
    expect(store.getState().userId).toBe("u2");
  });

  it("(b2) a same-business but DIFFERENT user still fully wipes", () => {
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    store.getState().setBusinessContext("b1", "u1");
    store.setState({ scanFeed: [scanEvent("ev1", "p1", "111")], finalCounts: [count("p1", 1, ["ev1"])] });

    store.getState().setBusinessContext("b1", "u2");

    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
    expect(store.getState().userId).toBe("u2");
  });

  it("(c) ensureProvisionalCount mints a synthetic backing event when the feed row is GONE, keeping books balanced", () => {
    const store = createTestScanStore();
    // Open review exists but its scanFeed row has been trimmed away (simulating a persist-trimmed feed).
    store.setState({
      scanFeed: [],
      needsReviewQueue: [{
        id: "rev1", businessId: "b1", rawCode: "999", cleanCode: "999", codeType: "unknown",
        status: "open", decodeStatus: "needs_review", reason: "unresolved", suggestedProductName: "",
        createdAt: "t", scanCount: 1, lastScannedAt: "t",
        idempotencyKey: "b1:s1:rev1:SAVE_UNKNOWN_SCAN",
      } as unknown as UnknownCodeReview],
    });

    const productId = store.getState().ensureProvisionalCount("999", "Recovered count (scan record was missing)");

    const finalCount = store.getState().finalCounts.find((c) => c.productId === productId);
    expect(finalCount?.quantity).toBe(1);

    // Books balance: sum of this product's feed quantityDeltas equals its finalCounts quantity.
    const feedRowsForProduct = store.getState().scanFeed.filter((e) => e.matchedProductId === productId);
    const sumDeltas = feedRowsForProduct.reduce((acc, e) => acc + e.quantityDelta, 0);
    expect(sumDeltas).toBe(finalCount?.quantity);

    // replayLedgerCounts (the pure ledger-replay ground truth) reproduces the same quantity from the
    // feed events alone - never a naked quantity bump the replay could not derive.
    const replayed = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId);
    const replayedForProduct = replayed.find((c) => c.productId === productId);
    expect(replayedForProduct?.quantity).toBe(finalCount?.quantity);
  });
});
