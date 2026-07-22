import { describe, it, expect } from "vitest";
import { computeVariance, type CountSnapshot } from "@/services/reports/varianceReport";

// SDD Task 3.5: pure variance/shrinkage comparison between two count snapshots.
// Zero-delta rows are INCLUDED (documented decision: full reconciliation, not just changes).
// Duplicate productId within one snapshot's lines is REJECTED (throws), documented as a
// snapshot-construction bug rather than something to silently filter.

function snap(id: string, label: string, lines: CountSnapshot["lines"]): CountSnapshot {
  return { id, label, takenAt: "2026-07-12T00:00:00.000Z", lines };
}

describe("computeVariance", () => {
  it("both snapshots empty -> empty array", () => {
    const a = snap("s1", "A", []);
    const b = snap("s2", "B", []);
    expect(computeVariance(a, b)).toEqual([]);
  });

  it("one empty snapshot -> all rows come from the other side", () => {
    const a = snap("s1", "A", []);
    const b = snap("s2", "B", [{ productId: "p1", name: "Widget", qty: 5 }]);
    expect(computeVariance(a, b)).toEqual([
      { productId: "p1", name: "Widget", prevQty: 0, currQty: 5, delta: 5 },
    ]);
  });

  it("added product (only in b) shows prevQty 0", () => {
    const a = snap("s1", "A", [{ productId: "p1", name: "Widget", qty: 3 }]);
    const b = snap("s2", "B", [
      { productId: "p1", name: "Widget", qty: 3 },
      { productId: "p2", name: "Gadget", qty: 2 },
    ]);
    const rows = computeVariance(a, b);
    const added = rows.find((r) => r.productId === "p2");
    expect(added).toEqual({ productId: "p2", name: "Gadget", prevQty: 0, currQty: 2, delta: 2 });
  });

  it("removed product (only in a) shows currQty 0", () => {
    const a = snap("s1", "A", [
      { productId: "p1", name: "Widget", qty: 3 },
      { productId: "p2", name: "Gadget", qty: 4 },
    ]);
    const b = snap("s2", "B", [{ productId: "p1", name: "Widget", qty: 3 }]);
    const rows = computeVariance(a, b);
    const removed = rows.find((r) => r.productId === "p2");
    expect(removed).toEqual({ productId: "p2", name: "Gadget", prevQty: 4, currQty: 0, delta: -4 });
  });

  it("changed qty computes signed delta", () => {
    const a = snap("s1", "A", [{ productId: "p1", name: "Widget", qty: 10 }]);
    const b = snap("s2", "B", [{ productId: "p1", name: "Widget", qty: 7 }]);
    expect(computeVariance(a, b)).toEqual([
      { productId: "p1", name: "Widget", prevQty: 10, currQty: 7, delta: -3 },
    ]);
  });

  it("unchanged qty is INCLUDED with delta 0 (full reconciliation, documented decision)", () => {
    const a = snap("s1", "A", [{ productId: "p1", name: "Widget", qty: 6 }]);
    const b = snap("s2", "B", [{ productId: "p1", name: "Widget", qty: 6 }]);
    expect(computeVariance(a, b)).toEqual([
      { productId: "p1", name: "Widget", prevQty: 6, currQty: 6, delta: 0 },
    ]);
  });

  it("sorts by Math.abs(delta) descending", () => {
    const a = snap("s1", "A", [
      { productId: "p1", name: "Small", qty: 10 },
      { productId: "p2", name: "Big", qty: 10 },
      { productId: "p3", name: "Zero", qty: 5 },
    ]);
    const b = snap("s2", "B", [
      { productId: "p1", name: "Small", qty: 9 }, // delta -1
      { productId: "p2", name: "Big", qty: 20 }, // delta +10
      { productId: "p3", name: "Zero", qty: 5 }, // delta 0
    ]);
    const rows = computeVariance(a, b);
    expect(rows.map((r) => r.productId)).toEqual(["p2", "p1", "p3"]);
  });

  it("stable tie-break by name ascending when |delta| is equal", () => {
    const a = snap("s1", "A", [
      { productId: "p1", name: "Zebra", qty: 0 },
      { productId: "p2", name: "Apple", qty: 0 },
    ]);
    const b = snap("s2", "B", [
      { productId: "p1", name: "Zebra", qty: 5 }, // delta +5
      { productId: "p2", name: "Apple", qty: 5 }, // delta +5
    ]);
    const rows = computeVariance(a, b);
    expect(rows.map((r) => r.name)).toEqual(["Apple", "Zebra"]);
  });

  it("rejects duplicate productId within a single snapshot's lines (throws)", () => {
    const a = snap("s1", "A", [
      { productId: "p1", name: "Widget", qty: 3 },
      { productId: "p1", name: "Widget dup", qty: 5 },
    ]);
    const b = snap("s2", "B", []);
    expect(() => computeVariance(a, b)).toThrow(/duplicate productId/i);
  });

  it("rejects duplicate productId in the second snapshot too", () => {
    const a = snap("s1", "A", []);
    const b = snap("s2", "B", [
      { productId: "p9", name: "X", qty: 1 },
      { productId: "p9", name: "X dup", qty: 2 },
    ]);
    expect(() => computeVariance(a, b)).toThrow(/duplicate productId/i);
  });
});
