import { describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { Alias, PendingSyncItem, Product, SyncOperation } from "@/types";

const BIZ = "biz-product-priority";
const USER = "user-product-priority";
const SESSION = "session-product-priority";

type StartedApply = {
  item: PendingSyncItem;
  activeAtStart: number;
  resolve: (result?: SyncResult) => void;
};

class ControlledTarget implements SyncTarget {
  readonly started: StartedApply[] = [];
  readonly finished: PendingSyncItem[] = [];
  maxActive = 0;
  private active = 0;

  apply(item: PendingSyncItem): Promise<SyncResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise((resolve) => {
      this.started.push({
        item,
        activeAtStart: this.active,
        resolve: (result = { ok: true, alreadyApplied: false }) => {
          this.active -= 1;
          this.finished.push(item);
          resolve(result);
        },
      });
    });
  }

  resolveById(id: string, result?: SyncResult) {
    const apply = this.started.find((entry) => entry.item.id === id);
    expect(apply, `${id} has started`).toBeDefined();
    apply!.resolve(result);
  }

  resolveAll(result?: SyncResult) {
    for (const apply of [...this.started]) {
      if (!this.finished.includes(apply.item)) apply.resolve(result);
    }
  }

  setFailure() {}
  reset() {}
}

class AutoResolvingTarget implements SyncTarget {
  readonly started: PendingSyncItem[] = [];
  maxActive = 0;
  private active = 0;

  apply(item: PendingSyncItem): Promise<SyncResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(item);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.active -= 1;
        resolve({ ok: true, alreadyApplied: false });
      }, 0);
    });
  }

  setFailure() {}
  reset() {}
}

class LogicalTimeoutTarget implements SyncTarget {
  readonly started: PendingSyncItem[] = [];
  readonly physicallySettled: PendingSyncItem[] = [];
  private readonly settleById = new Map<string, () => void>();

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    let settle!: () => void;
    const physicalSettlement = new Promise<void>((resolve) => {
      settle = () => {
        this.physicallySettled.push(item);
        resolve();
      };
    });
    this.started.push(item);
    this.settleById.set(item.id, settle);
    return {
      ok: false,
      alreadyApplied: false,
      error: "logical transaction timeout",
      retryable: true,
      physicalSettlement,
    } as SyncResult;
  }

  settle(id: string) {
    const settle = this.settleById.get(id);
    expect(settle, `${id} has physical ownership`).toBeDefined();
    this.settleById.delete(id);
    settle!();
  }

  setFailure() {}
  reset() {}
}

function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const state = store.getState();
  const productId = "known-markwrong-product";
  store.setState((previous) => ({
    products: [
      ...previous.products,
      {
        id: productId,
        businessId: state.businessId,
        name: "Wrong Durable Product",
        brand: "Acme",
        category: "general",
        specsShort: "",
        specsFull: "",
        primarySku: "",
        primaryBarcode: code,
        gtin: "",
        upc: "",
        ean: "",
        vendorCodes: [],
        aliases: [code],
        imageUrl: "",
        productUrl: "",
        location: "",
        notes: "",
        status: "active",
        source: "manual",
        confidence: 1,
        verified: true,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        createdBy: "test",
        updatedBy: "test",
      } as Product,
    ],
    aliases: [
      ...previous.aliases,
      {
        id: "known-markwrong-alias",
        businessId: state.businessId,
        productId,
        rawCodeExample: code,
        cleanCode: code,
        normalizedCode: code,
        aliasType: "barcode",
        source: "manual",
        confidence: 1,
        approved: true,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        createdBy: "test",
        lastSeenAt: "2026-08-20T00:00:00.000Z",
        syncStatus: "synced",
        idempotencyKey: "known-markwrong-alias-key",
      } as Alias,
    ],
  }));
  return productId;
}

const flush = async (ticks = 20) => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const waitForStarts = async (target: ControlledTarget, count: number) => {
  for (let i = 0; i < 20 && target.started.length < count; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(target.started.map((entry) => entry.item.entityId)).toHaveLength(count);
};

function item(operation: SyncOperation, entityId: string, extra?: Partial<PendingSyncItem>): PendingSyncItem {
  const entityType: PendingSyncItem["entityType"] =
    operation === "SAVE_PRODUCT" ? "Product" :
    operation === "SAVE_SCAN_EVENT" ? "ScanEvent" :
    operation === "INCREMENT_COUNT" ? "InventoryCount" :
    operation === "SAVE_UNKNOWN_SCAN" ? "UnknownCodeReview" :
    operation === "RESOLVE_ALIAS" ? "Alias" :
    "CountSession";
  return {
    id: `q-${entityId}-${operation}`,
    businessId: BIZ,
    sessionId: SESSION,
    entityType,
    entityId,
    operation,
    payload: { id: entityId, businessId: BIZ, sessionId: SESSION },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    idempotencyKey: `${BIZ}:${SESSION}:${entityId}:${operation}`,
    scanEventId: operation === "SAVE_SCAN_EVENT" || operation === "INCREMENT_COUNT" ? entityId : null,
    syncLane: operation === "SAVE_PRODUCT" ? "independent_product" : undefined,
    ...extra,
  };
}

function startStore(target: SyncTarget, queue: PendingSyncItem[]) {
  const store = createTestScanStore({ db: target, cloudBackend: true });
  store.getState().setBusinessContext(BIZ, USER);
  store.setState({ pendingSyncQueue: queue, sessionId: SESSION });
  store.getState().retrySync();
  return store;
}

describe("product-priority cloud drain", () => {
  it("starts independent SAVE_PRODUCT writes ahead of queued non-product work with at most four active applies", async () => {
    const target = new ControlledTarget();
    const queue = [
      item("SAVE_SCAN_EVENT", "scan-before-products"),
      item("SAVE_PRODUCT", "product-1"),
      item("SAVE_PRODUCT", "product-2"),
      item("SAVE_PRODUCT", "product-3"),
      item("SAVE_PRODUCT", "product-4"),
      item("SAVE_PRODUCT", "product-5"),
    ];
    startStore(target, queue);

    await waitForStarts(target, 4);

    expect(target.started.map((entry) => entry.item.entityId)).toEqual([
      "product-1",
      "product-2",
      "product-3",
      "product-4",
    ]);
    expect(target.maxActive).toBe(4);

    target.resolveById("q-product-1-SAVE_PRODUCT");
    await waitForStarts(target, 5);
    expect(target.started[4].item.entityId).toBe("product-5");
    expect(target.maxActive).toBe(4);

    target.resolveAll();
    await waitForStarts(target, 6);
    expect(target.started[5].item.entityId).toBe("scan-before-products");
    target.resolveAll();
    await flush();
  });

  it("keeps writes for the same product FIFO while other products drain concurrently", async () => {
    const target = new ControlledTarget();
    startStore(target, [
      item("SAVE_PRODUCT", "same-product", { id: "q-same-product-first", idempotencyKey: "same-product:first" }),
      item("SAVE_PRODUCT", "same-product", { id: "q-same-product-second", idempotencyKey: "same-product:second" }),
      item("SAVE_PRODUCT", "other-product"),
    ]);

    await waitForStarts(target, 2);
    expect(target.started.map((entry) => entry.item.id)).toEqual(["q-same-product-first", "q-other-product-SAVE_PRODUCT"]);

    target.resolveById("q-same-product-first");
    await waitForStarts(target, 3);
    expect(target.started[2].item.id).toBe("q-same-product-second");

    target.resolveAll();
    await flush();
  });

  it("keeps a serial SAVE_PRODUCT and a later marked write for the same product in original FIFO order", async () => {
    const target = new ControlledTarget();
    startStore(target, [
      item("SAVE_PRODUCT", "mixed-product", {
        id: "q-mixed-serial-first",
        idempotencyKey: "mixed:serial-first",
        syncLane: undefined,
      }),
      item("SAVE_PRODUCT", "mixed-product", {
        id: "q-mixed-marked-second",
        idempotencyKey: "mixed:marked-second",
      }),
      item("SAVE_PRODUCT", "independent-neighbor"),
    ]);

    await waitForStarts(target, 1);
    expect(target.started.map((entry) => entry.item.id)).toEqual([
      "q-independent-neighbor-SAVE_PRODUCT",
    ]);

    target.resolveById("q-independent-neighbor-SAVE_PRODUCT");
    await waitForStarts(target, 2);
    expect(target.started[1].item.id).toBe("q-mixed-serial-first");

    target.resolveById("q-mixed-serial-first");
    await waitForStarts(target, 3);
    expect(target.started[2].item.id).toBe("q-mixed-marked-second");

    target.resolveAll();
    await flush();
  });

  it("keeps a marked SAVE_PRODUCT and a later serial write for the same product in original FIFO order", async () => {
    const target = new ControlledTarget();
    startStore(target, [
      item("SAVE_PRODUCT", "mixed-product", {
        id: "q-mixed-marked-first",
        idempotencyKey: "mixed:marked-first",
      }),
      item("SAVE_PRODUCT", "mixed-product", {
        id: "q-mixed-serial-second",
        idempotencyKey: "mixed:serial-second",
        syncLane: undefined,
      }),
      item("SAVE_PRODUCT", "independent-neighbor"),
    ]);

    await waitForStarts(target, 1);
    expect(target.started.map((entry) => entry.item.id)).toEqual([
      "q-independent-neighbor-SAVE_PRODUCT",
    ]);

    target.resolveById("q-independent-neighbor-SAVE_PRODUCT");
    await waitForStarts(target, 2);
    expect(target.started[1].item.id).toBe("q-mixed-marked-first");

    target.resolveById("q-mixed-marked-first");
    await waitForStarts(target, 3);
    expect(target.started[2].item.id).toBe("q-mixed-serial-second");

    target.resolveAll();
    await flush();
  });

  it("does not start a later mixed-lane write for the same product after the earlier serial write fails", async () => {
    const target = new ControlledTarget();
    const store = startStore(target, [
      item("SAVE_PRODUCT", "mixed-fragile", {
        id: "q-mixed-fragile-first",
        idempotencyKey: "mixed-fragile:first",
        syncLane: undefined,
      }),
      item("SAVE_PRODUCT", "mixed-fragile", {
        id: "q-mixed-fragile-second",
        idempotencyKey: "mixed-fragile:second",
      }),
    ]);

    await waitForStarts(target, 1);
    expect(target.started[0].item.id).toBe("q-mixed-fragile-first");
    target.started[0].resolve({
      ok: false,
      alreadyApplied: false,
      error: "mixed first write failed",
      retryable: true,
    });
    await flush();

    expect(target.started.map((entry) => entry.item.id)).not.toContain("q-mixed-fragile-second");
    expect(store.getState().pendingSyncQueue.map((entry) => entry.id)).toEqual([
      "q-mixed-fragile-first",
      "q-mixed-fragile-second",
    ]);
    expect(store.getState().pendingSyncQueue[0]).toMatchObject({
      status: "error",
      retryCount: 1,
      lastError: "mixed first write failed",
    });
  });

  it("blocks later writes for the same product for the current pass after the first write fails", async () => {
    const target = new ControlledTarget();
    const store = startStore(target, [
      item("SAVE_PRODUCT", "fragile-product", { id: "q-fragile-first", idempotencyKey: "fragile:first" }),
      item("SAVE_PRODUCT", "fragile-product", { id: "q-fragile-second", idempotencyKey: "fragile:second" }),
      item("SAVE_PRODUCT", "healthy-product"),
    ]);

    await waitForStarts(target, 2);
    target.started.find((entry) => entry.item.id === "q-fragile-first")!.resolve({
      ok: false,
      alreadyApplied: false,
      error: "first product write failed",
      retryable: true,
    });
    target.resolveById("q-healthy-product-SAVE_PRODUCT");
    await flush();

    expect(target.started.map((entry) => entry.item.id)).not.toContain("q-fragile-second");
    expect(store.getState().pendingSyncQueue.map((entry) => entry.id)).toEqual(["q-fragile-first", "q-fragile-second"]);
    expect(store.getState().pendingSyncQueue[0]).toMatchObject({
      id: "q-fragile-first",
      status: "error",
      retryCount: 1,
      lastError: "first product write failed",
    });
  });

  it("keeps all non-product operations serial and in original order", async () => {
    const target = new AutoResolvingTarget();
    const operations: Array<[SyncOperation, string]> = [
      ["SAVE_SCAN_EVENT", "scan-1"],
      ["INCREMENT_COUNT", "count-1"],
      ["SAVE_SESSION", "session-1"],
      ["SAVE_UNKNOWN_SCAN", "review-1"],
      ["RESOLVE_ALIAS", "alias-1"],
    ];
    startStore(target, operations.map(([operation, entityId]) => item(operation, entityId)));

    for (let i = 0; i < 20 && target.started.length < operations.length; i += 1) await flush(1);

    expect(target.started.map((entry) => entry.entityId)).toEqual(operations.map(([, entityId]) => entityId));
    expect(target.maxActive).toBe(1);
  });

  it("stops new starts after a context change while reconciling successes that already committed", async () => {
    const target = new ControlledTarget();
    const store = startStore(target, [
      item("SAVE_PRODUCT", "context-product-1"),
      item("SAVE_PRODUCT", "context-product-2"),
      item("SAVE_PRODUCT", "context-product-3"),
      item("SAVE_PRODUCT", "context-product-4"),
      item("SAVE_PRODUCT", "context-product-5"),
    ]);

    await waitForStarts(target, 4);
    target.resolveById("q-context-product-1-SAVE_PRODUCT");
    store.getState().setBusinessContext("biz-other", "user-other");
    target.resolveById("q-context-product-2-SAVE_PRODUCT");
    target.resolveById("q-context-product-3-SAVE_PRODUCT");
    target.resolveById("q-context-product-4-SAVE_PRODUCT");
    await flush();

    expect(target.started.map((entry) => entry.item.entityId)).not.toContain("context-product-5");
    expect(store.getState().pendingSyncQueue.filter((entry) => entry.businessId === BIZ).map((entry) => entry.entityId))
      .toEqual(["context-product-5"]);
  });

  it("drains a product-only queue in bounded groups without exceeding four active applies", async () => {
    const target = new ControlledTarget();
    const store = startStore(
      target,
      Array.from({ length: 9 }, (_, i) => item("SAVE_PRODUCT", `bulk-product-${i + 1}`)),
    );

    for (let expectedStarts = 4; expectedStarts <= 9; expectedStarts += 1) {
      await waitForStarts(target, expectedStarts);
      target.started[expectedStarts - 4].resolve();
      await flush();
    }
    target.resolveAll();
    await flush();

    expect(target.maxActive).toBe(4);
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
  });

  it("holds physical product slots across logical timeouts and replacement drain passes", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = new ControlledTarget();
      const store = startStore(target, [
        item("SAVE_PRODUCT", "same-product", { id: "q-same-first", idempotencyKey: "same:first" }),
        item("SAVE_PRODUCT", "same-product", { id: "q-same-second", idempotencyKey: "same:second" }),
        item("SAVE_PRODUCT", "product-2"),
        item("SAVE_PRODUCT", "product-3"),
        item("SAVE_PRODUCT", "product-4"),
      ]);

      for (let i = 0; i < 20 && target.started.length < 4; i += 1) await Promise.resolve();
      expect(target.started.map((entry) => entry.item.id)).toEqual([
        "q-same-first",
        "q-product-2-SAVE_PRODUCT",
        "q-product-3-SAVE_PRODUCT",
        "q-product-4-SAVE_PRODUCT",
      ]);

      await vi.advanceTimersByTimeAsync(60_001);
      for (let i = 0; i < 40; i += 1) await Promise.resolve();
      store.getState().retrySync();
      for (let i = 0; i < 40; i += 1) await Promise.resolve();

      expect(target.started).toHaveLength(4);
      expect(target.maxActive).toBe(4);
      expect(target.started.map((entry) => entry.item.id)).not.toContain("q-same-second");

      target.resolveById("q-same-first");
      for (let i = 0; i < 40 && target.started.length < 5; i += 1) await Promise.resolve();

      expect(target.started[4].item.id).toBe("q-same-second");
      expect(target.maxActive).toBe(4);

      target.resolveAll();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps slots and same-product FIFO owned until a logically timed-out transaction physically settles", async () => {
    const target = new LogicalTimeoutTarget();
    const store = startStore(target, [
      item("SAVE_PRODUCT", "same-product", { id: "q-physical-same-first", idempotencyKey: "physical:same:first" }),
      item("SAVE_PRODUCT", "product-2", { id: "q-physical-2" }),
      item("SAVE_PRODUCT", "product-3", { id: "q-physical-3" }),
      item("SAVE_PRODUCT", "product-4", { id: "q-physical-4" }),
    ]);

    await flush();
    expect(target.started.map((entry) => entry.id)).toEqual([
      "q-physical-same-first",
      "q-physical-2",
      "q-physical-3",
      "q-physical-4",
    ]);

    store.setState({
      pendingSyncQueue: [
        item("SAVE_PRODUCT", "same-product", { id: "q-physical-same-second", idempotencyKey: "physical:same:second" }),
        item("SAVE_PRODUCT", "product-5", { id: "q-physical-5" }),
      ],
    });
    store.getState().retrySync();
    await flush();

    expect(target.started).toHaveLength(4);

    target.settle("q-physical-2");
    await flush();
    expect(target.started.map((entry) => entry.id)).toContain("q-physical-5");
    expect(target.started.map((entry) => entry.id)).not.toContain("q-physical-same-second");

    target.settle("q-physical-same-first");
    await flush();
    expect(target.started.map((entry) => entry.id)).toContain("q-physical-same-second");
  });

  it("scopes same-product physical ownership by business while preserving the global four-slot cap", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = new ControlledTarget();
      const store = startStore(target, [
        item("SAVE_PRODUCT", "shared-product", { id: "q-a-shared", idempotencyKey: "a:shared" }),
        item("SAVE_PRODUCT", "a-product-2", { id: "q-a-2" }),
        item("SAVE_PRODUCT", "a-product-3", { id: "q-a-3" }),
        item("SAVE_PRODUCT", "a-product-4", { id: "q-a-4" }),
      ]);
      for (let i = 0; i < 40 && target.started.length < 4; i += 1) await Promise.resolve();
      expect(target.started).toHaveLength(4);

      const businessB = "biz-product-priority-b";
      const sessionB = "session-product-priority-b";
      const businessBItem = item("SAVE_PRODUCT", "shared-product", {
        id: "q-b-shared",
        businessId: businessB,
        sessionId: sessionB,
        payload: { id: "shared-product", businessId: businessB, sessionId: sessionB },
        idempotencyKey: "b:shared",
      });
      store.getState().setBusinessContext(businessB, "user-product-priority-b");
      store.setState((state) => ({
        pendingSyncQueue: [...state.pendingSyncQueue, businessBItem],
        sessionId: sessionB,
        online: true,
      }));
      store.getState().retrySync();

      // Let A's logical waits time out so the B drain pass can observe the still-owned physical slots.
      await vi.advanceTimersByTimeAsync(60_001);
      for (let i = 0; i < 80; i += 1) await Promise.resolve();
      expect(target.started).toHaveLength(4);

      target.resolveById("q-a-2");
      for (let i = 0; i < 80 && target.started.length < 5; i += 1) await Promise.resolve();

      expect(target.started.map((entry) => entry.item.id)).toContain("q-b-shared");
      expect(target.maxActive).toBe(4);
      expect(target.finished.map((entry) => entry.id)).not.toContain("q-a-shared");

      target.resolveAll();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a real markWrong correction bundle serial so product writes stay adjacent to transfer ops", async () => {
    const target = new AutoResolvingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext(BIZ, USER);
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.setState({ online: false, sessionId: SESSION });
    const productId = seedKnown(store, "049000006399");

    const event = store.getState().processScan("049000006399");
    expect(event, "known scan creates a counted feed event").toBeTruthy();
    await store.getState().markWrong(productId, { reason: "scheduler regression" });

    const queuedBeforeDrain = store.getState().pendingSyncQueue;
    expect(queuedBeforeDrain.some((entry) => entry.operation === "SAVE_PRODUCT")).toBe(true);
    expect(queuedBeforeDrain.some((entry) => entry.operation === "INCREMENT_COUNT")).toBe(true);

    store.getState().setOnline(true);
    for (let i = 0; i < 40 && target.started.length < queuedBeforeDrain.length; i += 1) await flush(1);

    expect(target.started.map((entry) => entry.id)).toEqual(queuedBeforeDrain.map((entry) => entry.id));
    expect(target.maxActive).toBe(1);
  });

  it("starts real scan-created provisional products concurrently while scan and count writes remain serial afterward", async () => {
    const target = new ControlledTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext(BIZ, USER);
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.setState({ online: false, sessionId: SESSION });

    for (let i = 0; i < 6; i += 1) {
      const event = store.getState().processScan(`UNKNOWN-SCAN-BACKLOG-${i}`);
      expect(event, `unknown scan ${i} still creates a counted feed row`).toBeTruthy();
    }

    const queuedBeforeDrain = store.getState().pendingSyncQueue;
    const productItems = queuedBeforeDrain.filter((entry) => entry.operation === "SAVE_PRODUCT");
    const serialItems = queuedBeforeDrain.filter((entry) => entry.operation !== "SAVE_PRODUCT");
    expect(productItems).toHaveLength(6);
    expect(productItems.every((entry) => entry.syncLane === "independent_product")).toBe(true);
    expect(serialItems.some((entry) => entry.operation === "SAVE_SCAN_EVENT")).toBe(true);
    expect(serialItems.some((entry) => entry.operation === "INCREMENT_COUNT")).toBe(true);

    store.getState().setOnline(true);

    await waitForStarts(target, 4);
    expect(target.started.map((entry) => entry.item.operation)).toEqual([
      "SAVE_PRODUCT",
      "SAVE_PRODUCT",
      "SAVE_PRODUCT",
      "SAVE_PRODUCT",
    ]);
    expect(target.maxActive).toBe(4);

    for (let productIndex = 0; productIndex < productItems.length; productIndex += 1) {
      target.started[productIndex].resolve();
      if (productIndex + 4 < productItems.length) await waitForStarts(target, productIndex + 5);
      await flush();
    }

    for (let i = 0; i < serialItems.length; i += 1) {
      await waitForStarts(target, productItems.length + i + 1);
      const started = target.started.at(-1)!;
      expect(started.item.id).toBe(serialItems[i].id);
      expect(started.activeAtStart).toBe(1);
      started.resolve();
      await flush();
    }

    expect(store.getState().pendingSyncQueue).toHaveLength(0);
  });
});
