import { describe, it, expect } from "vitest";
import type { ScanEvent } from "@/types";
import { replayLedgerCounts } from "@/inventory/replay";

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
});
