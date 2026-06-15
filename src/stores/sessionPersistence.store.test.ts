import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";

// Loop 3 proof (store logic, no emulator): the count session is persisted through the durable queue
// (SAVE_SESSION) on start and finish, and setBusinessContext reconstructs the active session +
// finalCounts from persisted Firestore data (survive-refresh). The real Firestore writes/reads are
// proven separately by sessionPersistence.rules.test.ts (emulator).

class FakeAsyncTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };

const emptyLoader = async () => ({ products: [], aliases: [], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

function sess(id: string, status: "active" | "completed", startedAt: string): InventorySession {
  return { id, businessId: "biz-real", name: id, location: "Main", status, startedAt, completedAt: status === "completed" ? "2026-06-15T12:00:00.000Z" : null, createdBy: "user-real", notes: "", syncStatus: "synced" };
}
function count(sessionId: string, productId: string, quantity: number): InventoryCount {
  return { id: `${sessionId}_${productId}`, businessId: "biz-real", sessionId, productId, quantity, lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [] };
}

describe("Loop 3 session/count persistence (store)", () => {
  it("startSession persists a SAVE_SESSION (active) through the durable queue", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    store.getState().startSession("Morning Count", "Bay A");
    await flush();

    const saves = target.applied.filter((i) => i.operation === "SAVE_SESSION");
    expect(saves).toHaveLength(1);
    const s = saves[0].payload as InventorySession;
    expect(s.status).toBe("active");
    expect(s.name).toBe("Morning Count");
    expect(s.createdBy).toBe("user-real"); // real userId, never a fake/default
  });

  it("finishSession persists a completed SAVE_SESSION with a DISTINCT idempotency key", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    store.getState().startSession("Morning Count", "Bay A");
    await flush();

    store.getState().finishSession();
    await flush();

    const saves = target.applied.filter((i) => i.operation === "SAVE_SESSION");
    expect(saves).toHaveLength(2);
    const keys = saves.map((i) => i.idempotencyKey);
    expect(new Set(keys).size).toBe(2); // distinct keys: the completed write is not deduped
    const completed = saves[1].payload as InventorySession;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
    expect(store.getState().currentSession?.status).toBe("completed");
  });

  it("setBusinessContext reconstructs the ACTIVE session + its finalCounts (survive-refresh)", async () => {
    const completedOld = sess("session-old", "completed", "2026-06-14T09:00:00.000Z");
    const activeNew = sess("session-new", "active", "2026-06-15T09:00:00.000Z");
    const counts = [count("session-new", "p1", 3), count("session-new", "p2", 1), count("session-old", "p1", 9)];

    const store = createTestScanStore({
      db: new FakeAsyncTarget(),
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [completedOld, activeNew], counts }),
    });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    expect(store.getState().currentSession?.id).toBe("session-new"); // active preferred
    expect(store.getState().sessionId).toBe("session-new");
    const fc = store.getState().finalCounts;
    expect(fc.map((c) => c.productId).sort()).toEqual(["p1", "p2"]); // only the active session's counts
    expect(fc.find((c) => c.productId === "p1")?.quantity).toBe(3);
  });

  it("with only a completed session persisted, it is restored (finished-then-refresh)", async () => {
    const completed = sess("session-done", "completed", "2026-06-15T09:00:00.000Z");
    const store = createTestScanStore({
      db: new FakeAsyncTarget(),
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [completed], counts: [count("session-done", "p1", 5)] }),
    });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    expect(store.getState().currentSession?.id).toBe("session-done");
    expect(store.getState().currentSession?.status).toBe("completed");
    expect(store.getState().finalCounts.find((c) => c.productId === "p1")?.quantity).toBe(5);
  });

  it("the mock/local path still starts a session synchronously (no regression)", () => {
    const store = createTestScanStore(); // mock, cloudBackend false
    store.getState().startSession("Local", "Main");
    expect(store.getState().currentSession?.name).toBe("Local");
    expect(store.getState().pendingSyncQueue).toHaveLength(0); // SAVE_SESSION drained synchronously
  });
});
