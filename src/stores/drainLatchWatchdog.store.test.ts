import { describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { Alias, InventoryCount, InventorySession, PendingSyncItem, Product } from "@/types";

class HangingTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  private remainingHangs = 2;

  apply(item: PendingSyncItem): Promise<SyncResult> {
    if (this.remainingHangs > 0) {
      this.remainingHangs -= 1;
      return new Promise(() => {});
    }
    this.applied.push(item);
    return Promise.resolve({ ok: true, alreadyApplied: false });
  }

  setFailure() {}
  reset() {}
}

class LateSettlingTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  private firstResolve: (result: SyncResult) => void = () => {};
  private applyCount = 0;
  readonly firstApply = new Promise<SyncResult>((resolve) => {
    this.firstResolve = resolve;
  });

  apply(item: PendingSyncItem): Promise<SyncResult> {
    this.applyCount += 1;
    if (this.applyCount === 1) {
      return this.firstApply;
    }
    if (this.applyCount === 2) return new Promise(() => {});
    this.applied.push(item);
    return Promise.resolve({ ok: true, alreadyApplied: false });
  }

  settleFirstApply() {
    this.firstResolve({ ok: true, alreadyApplied: false });
  }

  setFailure() {}
  reset() {}
}

const CODE = "111222333444";
const product = {
  id: "p-drain", businessId: "biz-drain", name: "Drain Widget", brand: "", category: "", specsShort: "", specsFull: "",
  primarySku: "", primaryBarcode: CODE, gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [CODE], imageUrl: "",
  productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
  createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
} as Product;
const alias = {
  id: "a-drain", businessId: "biz-drain", productId: "p-drain", rawCodeExample: CODE, cleanCode: CODE,
  normalizedCode: CODE, aliasType: "barcode", source: "manual", confidence: 1, approved: true, createdAt: "t",
  updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
} as Alias;
const loader = async () => ({ products: [product], aliases: [alias], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

describe("cloud drain watchdog (regression)", () => {
  it("resets a stale drain latch so queued work behind one hung apply drains", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = new HangingTarget();
      const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
      store.getState().setBusinessContext("biz-drain", "user-drain");
      await vi.runAllTimersAsync();

      store.getState().processScan(CODE); // first cloud apply never settles
      await Promise.resolve();
      store.getState().processScan(CODE); // queues work behind the wedged drain

      await vi.advanceTimersByTimeAsync(75_001);
      store.getState().retrySync(); // a real retry/reconnect trigger must self-heal the stale latch
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      expect(target.applied).toHaveLength(5);
      expect(store.getState().pendingSyncQueue).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("abandons a watchdog-superseded drain after its own apply timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = new LateSettlingTarget();
      const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
      store.getState().setBusinessContext("biz-drain", "user-drain");
      await vi.runAllTimersAsync();

      store.setState({ online: false });
      store.getState().processScan(CODE);
      store.getState().processScan(CODE);
      store.setState({ online: true });
      store.getState().retrySync(); // first batch begins; its first apply settles too late
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(75_001);
      store.getState().retrySync(); // watchdog starts a replacement drain
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const replacementApplyCount = target.applied.length;
      expect(store.getState().pendingSyncQueue).toHaveLength(0);
      let staleDrainStateWrites = 0;
      const unsubscribe = store.subscribe(() => {
        staleDrainStateWrites += 1;
      });

      await vi.advanceTimersByTimeAsync(60_001); // exercise the abandoned drain's per-item timeout
      target.settleFirstApply(); // its late physical completion must not restart its snapshot
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      unsubscribe();

      expect(target.applied).toHaveLength(replacementApplyCount);
      expect(staleDrainStateWrites).toBe(0);
      expect(store.getState().pendingSyncQueue).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
