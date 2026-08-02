import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayLedgerCounts } from "@/services/inventory.replay";

const durable = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    database: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); },
      remove: async (key: string) => { values.delete(key); },
      createNamespaceIfAbsent: async (key: string, value: string, occupiedMetadataKeys: string[]) => {
        if (values.has(key) || occupiedMetadataKeys.some((metadataKey) => values.has(metadataKey))) return "exists" as const;
        values.set(key, value);
        return "created" as const;
      },
    },
  };
});

vi.mock("./scanPersistStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scanPersistStorage")>();
  return { ...actual, createNativeIndexedDbDatabase: () => durable.database };
});

import { useScanStore } from "./scanStore";

const initialState = useScanStore.getState();

beforeEach(() => {
  durable.values.clear();
  window.localStorage.clear();
  useScanStore.persist.setOptions({ name: "sis-scan-v1" });
  useScanStore.setState(initialState, true);
});

afterEach(() => {
  useScanStore.persist.setOptions({ name: "sis-scan-v1" });
  useScanStore.setState(initialState, true);
  durable.values.clear();
  window.localStorage.clear();
});

describe("durable adoption through the real persisted scan store", () => {
  it("adopts, rehydrates, and replays physical scans once", async () => {
    await durable.database.set("sis-scan-v1", JSON.stringify({
      state: {
        businessId: "b1",
        userId: "owner-uid",
        scanFeed: [
          { id: "event-1", businessId: "b1", sessionId: "session-1", matchedProductId: "p1", quantityDelta: 1, createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "event-2", businessId: "b1", sessionId: "session-1", matchedProductId: "p1", quantityDelta: 1, createdAt: "2026-01-01T00:01:00.000Z" },
          { id: "event-3", businessId: "b1", sessionId: "session-1", matchedProductId: "p2", quantityDelta: 2, createdAt: "2026-01-01T00:02:00.000Z" },
        ],
      },
      version: 14,
    }));
    const rehydrate = vi.spyOn(useScanStore.persist, "rehydrate");

    await expect(useScanStore.getState().adoptLegacyLocalData("owner-uid")).resolves.toEqual({ status: "adopted" });

    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-owner-uid");
    expect(useScanStore.getState().scanFeed.map((event) => event.id)).toEqual(["event-1", "event-2", "event-3"]);
    expect(replayLedgerCounts(useScanStore.getState().scanFeed, "session-1").map((count) => [count.productId, count.quantity, count.scanEventIds])).toEqual([
      ["p1", 2, ["event-1", "event-2"]],
      ["p2", 2, ["event-3"]],
    ]);
    await expect(useScanStore.getState().adoptLegacyLocalData("owner-uid")).resolves.toEqual({ status: "absent" });
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(useScanStore.getState().scanFeed.map((event) => event.id)).toEqual(["event-1", "event-2", "event-3"]);
    rehydrate.mockRestore();
  });
});
