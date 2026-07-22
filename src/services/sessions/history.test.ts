import { describe, it, expect } from "vitest";
import { aggregateSessionCounts } from "@/services/sessions/history";

describe("aggregateSessionCounts", () => {
  it("returns zeros for an empty session", () => {
    expect(aggregateSessionCounts([])).toEqual({ units: 0, distinctProducts: 0 });
  });

  it("sums quantities across distinct products", () => {
    const rows = [
      { productId: "p1", quantity: 3 },
      { productId: "p2", quantity: 2 },
    ];
    expect(aggregateSessionCounts(rows)).toEqual({ units: 5, distinctProducts: 2 });
  });

  it("a duplicate row for the same product increments units, not distinctProducts", () => {
    // Defensive: the normal ledger never emits two rows for the same productId in one session, but
    // this proves aggregation would still be correct (merge by productId) if it ever did.
    const rows = [
      { productId: "p1", quantity: 2 },
      { productId: "p1", quantity: 1 },
    ];
    expect(aggregateSessionCounts(rows)).toEqual({ units: 3, distinctProducts: 1 });
  });

  it("a single product scanned many times counts as 1 distinct product with units = its quantity", () => {
    const rows = [{ productId: "p1", quantity: 10 }];
    expect(aggregateSessionCounts(rows)).toEqual({ units: 10, distinctProducts: 1 });
  });

  it("ignores zero-quantity rows for the units sum but still counts them as distinct", () => {
    const rows = [
      { productId: "p1", quantity: 0 },
      { productId: "p2", quantity: 4 },
    ];
    expect(aggregateSessionCounts(rows)).toEqual({ units: 4, distinctProducts: 2 });
  });
});
