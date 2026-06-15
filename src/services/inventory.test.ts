import { describe, it, expect } from "vitest";
import {
  applyScanEventOnce,
  createInventoryCount,
  incrementInventoryCount,
} from "@/services/inventory";
import { buildIdempotencyKey } from "@/services/idempotency";
import type { InventoryCount, ScanEvent } from "@/types";

function makeEvent(id: string, productId: string, cleanCode: string): ScanEvent {
  return {
    id,
    businessId: "biz",
    sessionId: "sess",
    rawCode: cleanCode,
    cleanCode,
    normalizedCandidates: [cleanCode],
    matchedProductId: productId,
    matchType: "exact_alias",
    status: "known",
    resolverStatus: "known",
    codeType: "alpha_sku",
    reason: "",
    quantityDelta: 1,
    quantityAfterScan: 0,
    createdAt: "2026-06-12T10:00:00.000Z",
    source: "scan",
    notes: "",
    syncStatus: "pending",
    syncError: null,
    idempotencyKey: buildIdempotencyKey("biz", "sess", id, "INCREMENT_COUNT"),
  };
}

const baseCount = (): InventoryCount =>
  createInventoryCount({
    id: "count-1",
    businessId: "biz",
    sessionId: "sess",
    productId: "prod-nokian",
    createdAt: "2026-06-12T09:00:00.000Z",
  });

describe("applyScanEventOnce", () => {
  it("increments quantity and records the scan event id", () => {
    const { count, applied } = applyScanEventOnce(baseCount(), makeEvent("e1", "prod-nokian", "T432119"));
    expect(applied).toBe(true);
    expect(count.quantity).toBe(1);
    expect(count.scanEventIds).toContain("e1");
    expect(count.aliasesSeen).toContain("T432119");
  });

  it("never double counts the same scan event id", () => {
    const e = makeEvent("e1", "prod-nokian", "T432119");
    const first = applyScanEventOnce(baseCount(), e);
    const second = applyScanEventOnce(first.count, e);
    expect(second.applied).toBe(false);
    expect(second.count.quantity).toBe(1);
  });
});

describe("incrementInventoryCount", () => {
  it("counts duplicate scans of different codes toward the same product", () => {
    let counts: InventoryCount[] = [];
    let n = 0;
    const makeId = () => `c-${++n}`;
    const r1 = incrementInventoryCount(counts, makeEvent("e1", "prod-nokian", "6419440485331"), makeId);
    const r2 = incrementInventoryCount(r1.counts, makeEvent("e2", "prod-nokian", "T432119"), makeId);
    const r3 = incrementInventoryCount(r2.counts, makeEvent("e3", "prod-nokian", "T432119%RU1%"), makeId);
    counts = r3.counts;
    expect(counts).toHaveLength(1);
    expect(counts[0].quantity).toBe(3);
    expect(counts[0].aliasesSeen).toEqual(["6419440485331", "T432119", "T432119%RU1%"]);
  });

  it("is safe to replay the same event (idempotent)", () => {
    let n = 0;
    const makeId = () => `c-${++n}`;
    const e = makeEvent("e1", "prod-nokian", "T432119");
    const r1 = incrementInventoryCount([], e, makeId);
    const r2 = incrementInventoryCount(r1.counts, e, makeId);
    expect(r2.applied).toBe(false);
    expect(r2.counts[0].quantity).toBe(1);
  });

  it("keeps separate products in separate counts", () => {
    let n = 0;
    const makeId = () => `c-${++n}`;
    const r1 = incrementInventoryCount([], makeEvent("e1", "prod-nokian", "T432119"), makeId);
    const r2 = incrementInventoryCount(r1.counts, makeEvent("e2", "prod-falken", "28816861"), makeId);
    expect(r2.counts).toHaveLength(2);
  });
});
