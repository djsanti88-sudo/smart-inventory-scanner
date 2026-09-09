import { describe, expect, it } from "vitest";
import { buildBossReport } from "@/reports/variance/bossReport";
import type { InventoryCount, Product, ScanEvent } from "@/types";

function product(id: string, name: string, brand: string, category: string): Product {
  return {
    id,
    businessId: "b1",
    name,
    brand,
    category,
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: "",
    status: "active",
    source: "manual",
    confidence: 1,
    verified: true,
    createdAt: "t",
    updatedAt: "t",
    createdBy: "u",
    updatedBy: "u",
  };
}

function count(productId: string, quantity: number, sessionId = "s1"): InventoryCount {
  return {
    id: `c-${productId}-${sessionId}`,
    businessId: "b1",
    sessionId,
    productId,
    quantity,
    lastScannedAt: "t",
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: "t",
    updatedAt: "t",
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: [],
  };
}

function scan(resolverStatus: ScanEvent["resolverStatus"]): ScanEvent {
  return {
    id: `e-${Math.random()}`,
    businessId: "b1",
    sessionId: "s1",
    rawCode: "1",
    cleanCode: "1",
    normalizedCandidates: [],
    matchedProductId: null,
    matchType: "unknown",
    status: "unknown",
    resolverStatus,
    codeType: "numeric_sku",
    reason: "",
    quantityDelta: 1,
    quantityAfterScan: 1,
    createdAt: "t",
    source: "scan",
    notes: "",
    syncStatus: "synced",
    syncError: null,
    idempotencyKey: "k",
  };
}

describe("buildBossReport", () => {
  it("totals items, groups by brand and category, and computes moat stats", () => {
    const products = [
      product("p1", "Widget A", "Acme", "Tools"),
      product("p2", "Widget B", "Acme", "Tools"),
      product("p3", "Gadget", "Zeta", "Electronics"),
    ];
    const counts = [count("p1", 3), count("p2", 2), count("p3", 5)];

    const report = buildBossReport({
      products,
      finalCounts: counts,
      scanFeed: [scan("known"), scan("needs_review")],
      sessionName: "Jul 19",
      countedBy: "Owner",
      countedAt: "2026-07-19T16:00:00.000Z",
    });

    expect(report.totalItems).toBe(10);
    expect(report.byBrand).toEqual(
      expect.arrayContaining([
        { brand: "Acme", qty: 5 },
        { brand: "Zeta", qty: 5 },
      ]),
    );
    expect(report.byCategory).toEqual(
      expect.arrayContaining([
        { category: "Tools", qty: 5 },
        { category: "Electronics", qty: 5 },
      ]),
    );
    expect(report.moat).toEqual({ total: 2, identified: 1 });
  });

  it("reports inventory value as unavailable because the system has no cost field", () => {
    const report = buildBossReport({
      products: [product("p1", "Widget A", "Acme", "Tools")],
      finalCounts: [count("p1", 2)],
      scanFeed: [],
      sessionName: "s",
      countedBy: "u",
      countedAt: "t",
    });

    expect(report.hasAnyCostData).toBe(false);
    expect(report.totalValue).toBeNull();
  });

  it("returns an empty topVariances array without both snapshots", () => {
    const report = buildBossReport({
      products: [],
      finalCounts: [],
      scanFeed: [],
      sessionName: "s",
      countedBy: "u",
      countedAt: "t",
      previousSnapshot: {
        id: "previous",
        label: "Previous",
        takenAt: "2026-07-18T16:00:00.000Z",
        lines: [],
      },
    });

    expect(report.topVariances).toEqual([]);
  });

  it("uses computeVariance and returns the ten largest nonzero changes", () => {
    const previousLines = Array.from({ length: 12 }, (_, index) => ({
      productId: `p${index}`,
      name: `Product ${index}`,
      qty: 0,
    }));
    const currentLines = previousLines.map((line, index) => ({
      ...line,
      qty: index,
    }));

    const report = buildBossReport({
      products: [],
      finalCounts: [],
      scanFeed: [],
      sessionName: "s",
      countedBy: "u",
      countedAt: "t",
      previousSnapshot: {
        id: "previous",
        label: "Previous",
        takenAt: "2026-07-18T16:00:00.000Z",
        lines: previousLines,
      },
      currentSnapshotForVariance: {
        id: "current",
        label: "Current",
        takenAt: "2026-07-19T16:00:00.000Z",
        lines: currentLines,
      },
    });

    expect(report.topVariances).toHaveLength(10);
    expect(report.topVariances.map((row) => row.delta)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  // F2 regression (Phase 3 review): refreshFromCloud intentionally does an ADDITIVE cross-session
  // merge into finalCounts (a tested cross-device sync path). Without scoping, a public Boss Report
  // minted after a Refresh leaks other sessions' totals into totalItems/byBrand/byCategory. The
  // report must be scoped to the CURRENT session only.
  it("scopes totals to currentSessionId only, excluding other sessions' counts merged in by a cross-device refresh", () => {
    const products = [
      product("p1", "Widget A", "Acme", "Tools"),
      product("p2", "Widget B", "Acme", "Tools"),
      product("p3", "Gadget", "Zeta", "Electronics"),
    ];
    // p1/p2 belong to the current session (s1); p3 was merged in from another device's session (s2).
    const counts = [count("p1", 3, "s1"), count("p2", 2, "s1"), count("p3", 5, "s2")];

    const report = buildBossReport({
      products,
      finalCounts: counts,
      scanFeed: [],
      sessionName: "Jul 19",
      countedBy: "Owner",
      countedAt: "2026-07-19T16:00:00.000Z",
      currentSessionId: "s1",
    });

    expect(report.totalItems).toBe(5); // 3 + 2, NOT +5 from the other session
    expect(report.byBrand).toEqual([{ brand: "Acme", qty: 5 }]);
    expect(report.byCategory).toEqual([{ category: "Tools", qty: 5 }]);
  });
});
