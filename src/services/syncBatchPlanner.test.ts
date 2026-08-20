import { describe, expect, it } from "vitest";
import { planSyncBatch } from "@/services/syncBatchPlanner";
import type { PendingSyncItem, SyncOperation } from "@/types";

function item(
  id: string,
  operation: SyncOperation,
  entityId: string,
  syncLane?: PendingSyncItem["syncLane"],
): PendingSyncItem {
  return {
    id,
    businessId: "biz-planner",
    sessionId: "session-planner",
    entityType: operation === "SAVE_PRODUCT" ? "Product" : "ScanEvent",
    entityId,
    operation,
    payload: {},
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    idempotencyKey: `key-${id}`,
    scanEventId: null,
    syncLane,
  };
}

describe("planSyncBatch", () => {
  it("keeps serial then marked writes for one product in the serial lane", () => {
    const plan = planSyncBatch([
      item("serial-first", "SAVE_PRODUCT", "product-a"),
      item("marked-second", "SAVE_PRODUCT", "product-a", "independent_product"),
      item("other", "SAVE_PRODUCT", "product-b", "independent_product"),
    ]);

    expect(plan.independentProductGroups.map((group) => group.map((entry) => entry.id))).toEqual([["other"]]);
    expect(plan.serialItems.map((entry) => entry.id)).toEqual(["serial-first", "marked-second"]);
  });

  it("keeps marked then serial writes for one product in the serial lane", () => {
    const plan = planSyncBatch([
      item("marked-first", "SAVE_PRODUCT", "product-a", "independent_product"),
      item("serial-second", "SAVE_PRODUCT", "product-a"),
      item("scan", "SAVE_SCAN_EVENT", "scan-a"),
    ]);

    expect(plan.independentProductGroups).toEqual([]);
    expect(plan.serialItems.map((entry) => entry.id)).toEqual(["marked-first", "serial-second", "scan"]);
  });

  it("preserves same-product FIFO in concurrent groups and original order in the serial lane", () => {
    const plan = planSyncBatch([
      item("scan-first", "SAVE_SCAN_EVENT", "scan-a"),
      item("a-first", "SAVE_PRODUCT", "product-a", "independent_product"),
      item("b-first", "SAVE_PRODUCT", "product-b", "independent_product"),
      item("a-second", "SAVE_PRODUCT", "product-a", "independent_product"),
      item("scan-second", "SAVE_SCAN_EVENT", "scan-b"),
    ]);

    expect(plan.independentProductGroups.map((group) => group.map((entry) => entry.id))).toEqual([
      ["a-first", "a-second"],
      ["b-first"],
    ]);
    expect(plan.serialItems.map((entry) => entry.id)).toEqual(["scan-first", "scan-second"]);
  });
});
