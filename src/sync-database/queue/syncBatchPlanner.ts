import type { PendingSyncItem } from "@/types";

export type SyncBatchPlan = {
  independentProductGroups: PendingSyncItem[][];
  serialItems: PendingSyncItem[];
};

/**
 * Partition one queue snapshot without changing its order.
 *
 * A product is eligible for the concurrent lane only when every SAVE_PRODUCT
 * for that entity in this snapshot explicitly opts in. One serial write makes
 * the entire same-product group serial for the pass.
 */
export function planSyncBatch(batch: readonly PendingSyncItem[]): SyncBatchPlan {
  const productIsIndependent = new Map<string, boolean>();
  for (const item of batch) {
    if (item.operation !== "SAVE_PRODUCT") continue;
    const marked = item.syncLane === "independent_product";
    productIsIndependent.set(item.entityId, (productIsIndependent.get(item.entityId) ?? true) && marked);
  }

  const groups = new Map<string, PendingSyncItem[]>();
  const serialItems: PendingSyncItem[] = [];
  for (const item of batch) {
    if (item.operation === "SAVE_PRODUCT" && productIsIndependent.get(item.entityId) === true) {
      const group = groups.get(item.entityId);
      if (group) group.push(item);
      else groups.set(item.entityId, [item]);
      continue;
    }
    serialItems.push(item);
  }

  return {
    independentProductGroups: [...groups.values()],
    serialItems,
  };
}
