import { describe, it, expect } from "vitest";
import { computeDollarVariance } from "@/reconcile/variance/dollarVariance";
import type { ReconcileReport } from "@/reconcile/variance/reconcileReport";

// Reconcile M3 (dollar variance, H1): opt-in, LOCAL-ONLY headline "$X variance across N SKUs".
// PURE over an already-built ReconcileReport + a unit-cost map that never left the browser.

function emptyTotals(): ReconcileReport["totals"] {
  return {
    variance: 0, agreement: 0, expected_not_counted: 0, ambiguous: 0,
    unmatched: 0, non_tire: 0, uom_review: 0, unparseable: 0,
  };
}

describe("computeDollarVariance", () => {
  it("computes the dollar total and SKU count from a known fixture", () => {
    const report: ReconcileReport = {
      lines: [
        { bucket: "variance", partNumbers: ["A-1"], expectedQty: 6, countedQty: 4, delta: -2, reason: "" },
        { bucket: "variance", partNumbers: ["B-2"], expectedQty: 1, countedQty: 3, delta: 2, reason: "" },
        { bucket: "agreement", partNumbers: ["C-3"], expectedQty: 5, countedQty: 5, delta: 0, reason: "" },
      ],
      totals: emptyTotals(),
      assumptions: [],
    };
    const unitCosts = { "A-1": 10, "B-2": 25.5, "C-3": 999 };
    // |-2| * 10 + |2| * 25.5 = 20 + 51 = 71
    expect(computeDollarVariance(report, unitCosts)).toEqual({ totalDollarVariance: 71, skuCount: 2 });
  });

  it("excludes variance lines with no known unit cost, rather than treating them as $0", () => {
    const report: ReconcileReport = {
      lines: [
        { bucket: "variance", partNumbers: ["A-1"], expectedQty: 6, countedQty: 4, delta: -2, reason: "" },
        { bucket: "variance", partNumbers: ["UNPRICED"], expectedQty: 1, countedQty: 2, delta: 1, reason: "" },
      ],
      totals: emptyTotals(),
      assumptions: [],
    };
    expect(computeDollarVariance(report, { "A-1": 10 })).toEqual({ totalDollarVariance: 20, skuCount: 1 });
  });

  it("ignores non-variance buckets (agreement has zero delta by definition; others have none)", () => {
    const report: ReconcileReport = {
      lines: [
        { bucket: "agreement", partNumbers: ["A-1"], expectedQty: 5, countedQty: 5, delta: 0, reason: "" },
        { bucket: "expected_not_counted", partNumbers: ["B-2"], expectedQty: 3, reason: "" },
        { bucket: "unmatched", partNumbers: ["C-3"], expectedQty: 2, reason: "" },
      ],
      totals: emptyTotals(),
      assumptions: [],
    };
    expect(computeDollarVariance(report, { "A-1": 10, "B-2": 10, "C-3": 10 })).toEqual({ totalDollarVariance: 0, skuCount: 0 });
  });

  it("returns zero for an empty report or empty unit cost map", () => {
    const report: ReconcileReport = { lines: [], totals: emptyTotals(), assumptions: [] };
    expect(computeDollarVariance(report, {})).toEqual({ totalDollarVariance: 0, skuCount: 0 });
  });

  it("rounds to the cent to avoid floating-point noise", () => {
    const report: ReconcileReport = {
      lines: [{ bucket: "variance", partNumbers: ["A-1"], expectedQty: 1, countedQty: 2, delta: 1, reason: "" }],
      totals: emptyTotals(),
      assumptions: [],
    };
    expect(computeDollarVariance(report, { "A-1": 0.1 }).totalDollarVariance).toBe(0.1);
  });
});
