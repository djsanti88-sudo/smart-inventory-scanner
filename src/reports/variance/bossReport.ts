// Pure aggregation for the Boss Report. This module takes already-loaded store data and produces a
// display-ready shape shared by the logged-in report page and future server-side report consumers.
import { computeMoatStats, type MoatStats } from "@/inventory/moatStats";
import {
  computeVariance,
  type CountSnapshot,
  type VarianceRow,
} from "@/reports/variance/varianceReport";
import type { InventoryCount, Product, ScanEvent } from "@/types";

export interface BossReportInput {
  products: Product[];
  finalCounts: InventoryCount[];
  scanFeed: ScanEvent[];
  sessionName: string;
  countedBy: string;
  countedAt: string;
  previousSnapshot?: CountSnapshot;
  currentSnapshotForVariance?: CountSnapshot;
  /** F2 fix (Phase 3 review): refreshFromCloud intentionally does an ADDITIVE cross-session merge
   *  into the store's finalCounts (a tested cross-device sync path - see refreshFromCloud.store.test.ts).
   *  Without this scope, a public Boss Report snapshot minted after a Refresh would leak other
   *  sessions' totals. When provided, only finalCounts for this session are aggregated; omitted (or
   *  a falsy value) preserves the prior unscoped behavior for callers that don't yet track a session
   *  (e.g. the /api/share fallback report, which always has empty finalCounts anyway). */
  currentSessionId?: string;
}

export interface BossReportData {
  totalItems: number;
  moat: MoatStats;
  byBrand: Array<{ brand: string; qty: number }>;
  byCategory: Array<{ category: string; qty: number }>;
  totalValue: number | null;
  hasAnyCostData: boolean;
  topVariances: VarianceRow[];
  sessionName: string;
  countedBy: string;
  countedAt: string;
}

export function buildBossReport(input: BossReportInput): BossReportData {
  const byId = new Map(input.products.map((product) => [product.id, product]));
  let totalItems = 0;
  const brandQty = new Map<string, number>();
  const categoryQty = new Map<string, number>();

  const scopedCounts = input.currentSessionId
    ? input.finalCounts.filter((count) => count.sessionId === input.currentSessionId)
    : input.finalCounts;

  for (const count of scopedCounts) {
    const product = byId.get(count.productId);
    totalItems += count.quantity;

    const brand = product?.brand || "Unknown";
    const category = product?.category || "Uncategorized";
    brandQty.set(brand, (brandQty.get(brand) ?? 0) + count.quantity);
    categoryQty.set(category, (categoryQty.get(category) ?? 0) + count.quantity);
  }

  const topVariances =
    input.previousSnapshot && input.currentSnapshotForVariance
      ? computeVariance(input.previousSnapshot, input.currentSnapshotForVariance)
          .filter((row) => row.delta !== 0)
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          .slice(0, 10)
      : [];

  return {
    totalItems,
    moat: computeMoatStats(input.scanFeed),
    byBrand: [...brandQty.entries()].map(([brand, qty]) => ({ brand, qty })),
    byCategory: [...categoryQty.entries()].map(([category, qty]) => ({ category, qty })),
    totalValue: null,
    hasAnyCostData: false,
    topVariances,
    sessionName: input.sessionName,
    countedBy: input.countedBy,
    countedAt: input.countedAt,
  };
}
