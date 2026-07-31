import { describe, it, expect } from "vitest";
import type { ScanEvent } from "@/types";
import { createInventoryCount, applyInventoryCountDeltaOnce } from "@/services/inventory";
import { replayInventoryEvents, replayLedgerCounts } from "@/services/inventory.replay";
import { createAggregateImportEvent } from "@/services/identity/importLedger";

function ev(over: Partial<ScanEvent>): ScanEvent {
  return {
    id: "e1", businessId: "b", sessionId: "s", rawCode: "1", cleanCode: "1",
    normalizedCandidates: [], matchedProductId: "p1", matchType: "unknown",
    status: "known", resolverStatus: "known", codeType: "upc_a", reason: "",
    quantityDelta: 1, quantityAfterScan: 0, createdAt: "2026-07-19T00:00:00.000Z",
    source: "scan", notes: "", syncStatus: "pending", syncError: null,
    idempotencyKey: "b:s:e1:INCREMENT_COUNT", ...over,
  };
}

describe("replayLedgerCounts", () => {
  it("sums deltas per product and records exact scanEventIds", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: "p1" }),
      ev({ id: "e2", matchedProductId: "p1" }),
      ev({ id: "e3", matchedProductId: "p2" }),
    ];
    const counts = replayLedgerCounts(events, "s");
    const p1 = counts.find((c) => c.productId === "p1")!;
    const p2 = counts.find((c) => c.productId === "p2")!;
    expect(p1.quantity).toBe(2);
    expect(new Set(p1.scanEventIds)).toEqual(new Set(["e1", "e2"]));
    expect(p2.quantity).toBe(1);
  });

  it("is a no-op on a duplicate event id (replay dedupe = applyScanEventOnce)", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: "p1" }),
      ev({ id: "e1", matchedProductId: "p1" }), // same id replayed
    ];
    const counts = replayLedgerCounts(events, "s");
    expect(counts.find((c) => c.productId === "p1")!.quantity).toBe(1);
  });

  it("ignores events with no matchedProductId and events from other sessions", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: null, status: "needs_review", quantityDelta: 0 }),
      ev({ id: "e2", matchedProductId: "p1", sessionId: "other" }),
      ev({ id: "e3", matchedProductId: "p1", sessionId: "s" }),
    ];
    const counts = replayLedgerCounts(events, "s");
    expect(counts.length).toBe(1);
    expect(counts[0].quantity).toBe(1);
    expect(counts[0].scanEventIds).toEqual(["e3"]);
  });

  it("replays one physical aggregate row as its quantity without scanner aliases", async () => {
    const aggregate = await createAggregateImportEvent({
      businessId: "b",
      importId: "import-1",
      rowId: "row-1",
      sessionId: "s",
      quantity: 7,
      sourceFileOrdinal: 0,
      sheetName: "Inventory",
      sourceRowNumber: 2,
      createdAt: "2026-07-31T00:00:00.000Z",
      mode: "physical_count",
      decision: { kind: "automatic", targetProductId: "p1" },
    });

    const [count] = replayInventoryEvents([aggregate], "s");
    expect(count.quantity).toBe(7);
    expect(count.lastScannedAt).toBeUndefined();
    expect(count.lastImportedAt).toBe("2026-07-31T00:00:00.000Z");
    expect(count.aliasesSeen).toEqual([]);
    expect(count.scanEventIds).toEqual([aggregate.eventId]);
  });

  it("sums mixed scan and aggregate events while deduping the aggregate identity", async () => {
    const aggregate = await createAggregateImportEvent({
      businessId: "b",
      importId: "import-1",
      rowId: "row-1",
      sessionId: "s",
      quantity: 7,
      sourceFileOrdinal: 0,
      sheetName: "Inventory",
      sourceRowNumber: 2,
      createdAt: "2026-07-31T00:00:00.000Z",
      mode: "physical_count",
      decision: { kind: "automatic", targetProductId: "p1" },
    });
    const otherSession = await createAggregateImportEvent({ ...aggregate, rowId: "row-2", sessionId: "other", mode: "physical_count", decision: { kind: "automatic", targetProductId: "p1" } });

    const [count] = replayInventoryEvents([ev({ id: "scan-1" }), aggregate, aggregate, otherSession], "s");
    expect(count.quantity).toBe(8);
    expect(count.aliasesSeen).toEqual(["1"]);
    expect(count.scanEventIds).toEqual(["scan-1", aggregate.eventId]);
  });

  it("keeps same-session aggregate rows tenant-scoped even when their product ids match", async () => {
    const shopA = await createAggregateImportEvent({
      businessId: "shop-a", importId: "import-1", rowId: "row-1", sessionId: "s",
      quantity: 7, sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2, createdAt: "2026-07-31T00:00:00.000Z",
      mode: "physical_count", decision: { kind: "automatic", targetProductId: "shared-product" },
    });
    const shopB = await createAggregateImportEvent({ ...shopA, businessId: "shop-b", mode: "physical_count", decision: { kind: "automatic", targetProductId: "shared-product" } });

    const counts = replayInventoryEvents([shopA, shopB], "s");
    expect(counts).toHaveLength(2);
    expect(counts.map((count) => [count.businessId, count.quantity]).sort()).toEqual([
      ["shop-a", 7],
      ["shop-b", 7],
    ]);
  });

  it("keeps scan chronology intact when an aggregate delta is replayed", async () => {
    const aggregate = await createAggregateImportEvent({
      businessId: "b", importId: "import-2", rowId: "row-1", sessionId: "s", quantity: 0,
      sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2, createdAt: "2026-07-31T03:00:00.000Z",
      mode: "physical_count", decision: { kind: "automatic", targetProductId: "p1" },
    });
    const [count] = replayInventoryEvents([ev({ createdAt: "2026-07-31T01:00:00.000Z" }), aggregate], "s");
    expect(count.lastScannedAt).toBe("2026-07-31T01:00:00.000Z");
    expect(count.lastImportedAt).toBe("2026-07-31T03:00:00.000Z");
    expect(count.quantity).toBe(1);
    expect(count.scanEventIds).toContain(aggregate.eventId);
  });

  it("rejects an aggregate delta whose tenant, session, or product differs from the count", () => {
    const count = createInventoryCount({
      id: "count-1", businessId: "b", sessionId: "s", productId: "p1", createdAt: "2026-07-31T00:00:00.000Z",
    });
    expect(() => applyInventoryCountDeltaOnce(count, {
      eventId: "aggregate-1", idempotencyKey: "aggregate-1", businessId: "other", sessionId: "s", productId: "p1",
      quantityDelta: 1, createdAt: "2026-07-31T01:00:00.000Z",
    })).toThrow("aggregate delta does not match the inventory count scope");
  });

  it("leaves the scan-only compatibility wrapper unchanged", () => {
    const scans = [ev({ id: "e1" }), ev({ id: "e2" })];
    expect(replayLedgerCounts(scans, "s")).toEqual(replayInventoryEvents(scans, "s"));
  });
});
