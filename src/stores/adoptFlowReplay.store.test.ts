import { describe, it, expect } from "vitest";
import { createLegacyAdoptionOperations } from "./scanPersistNamespace";
import { createAsyncDurableStorage, getPersistedStatePresenceFromDatabase, type AsyncKeyValueDatabase } from "./scanPersistStorage";
import { replayLedgerCounts } from "@/services/inventory.replay";
import { createTestScanStore, scanStoreMigrate } from "./scanStore";

class MemStorage implements AsyncKeyValueDatabase {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async remove(k: string) { this.m.delete(k); }
}

describe("adopt-flow replay: owner data intact after the owner-initiated adopt", () => {
  it("rehydrates the durable adopted snapshot and replays its physical scan IDs exactly once", async () => {
    const s = new MemStorage();
    const legacyFeed = [
      { id: "e1", businessId: "b1", sessionId: "s1", matchedProductId: "p1", quantityDelta: 1, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "e2", businessId: "b1", sessionId: "s1", matchedProductId: "p1", quantityDelta: 1, createdAt: "2026-01-01T00:01:00.000Z" },
      { id: "e3", businessId: "b1", sessionId: "s1", matchedProductId: "p2", quantityDelta: 3, createdAt: "2026-01-01T00:02:00.000Z" },
      { id: "e4", businessId: "b1", sessionId: "s1", matchedProductId: "p2", quantityDelta: 0, createdAt: "2026-01-01T00:03:00.000Z" },
    ];
    await s.set("sis-scan-v1", JSON.stringify({ state: { scanFeed: legacyFeed, businessId: "b1" }, version: 8 }));

    const operations = createLegacyAdoptionOperations({
      database: s,
      createStorage: () => createAsyncDurableStorage({ database: s, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, s),
    });
    await expect(operations.adopt("owner-uid")).resolves.toEqual({ status: "adopted" });
    const adopted = JSON.parse((await s.get("sis-scan-owner-uid"))!);
    const store = createTestScanStore();
    store.setState(scanStoreMigrate(adopted.state, adopted.version) as never);
    const hydratedFeed = store.getState().scanFeed;
    const replayed = replayLedgerCounts(hydratedFeed, "s1");

    expect(hydratedFeed.map((event) => event.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(replayed.map((count) => [count.productId, count.quantity, count.scanEventIds])).toEqual([
      ["p1", 2, ["e1", "e2"]],
      ["p2", 4, ["e3", "e4"]],
    ]);
    expect(await operations.inspect()).toBe("absent"); // adopt CONSUMES the legacy blob (no double-inherit)
    await expect(operations.adopt("owner-uid")).resolves.toEqual({ status: "absent" });
  });
});
