// src/reconcile/variance/dollarVariance.ts
//
// Optional, opt-in dollar variance headline (Task 7 extension, M3/H1): "$X variance across N SKUs"
// - the sales number. PURE function over an already-built ReconcileReport and a LOCAL-ONLY
// unit-cost map (never sent to /api/reconcile/match or any AI/network path - see
// shopwareCsvAdapter.parseShopwareUnitCosts, universalAdapter.extractUniversalUnitCosts, and
// reconcileStore's separate `unitCosts` field, which never touches session.adapter).
//
// Only "variance" bucket lines count (agreement lines have delta 0 by definition; every other
// bucket has no counted-vs-expected comparison to price). A line contributes only when at least one
// of its part numbers has a known unit cost; unpriced variance lines are silently excluded from the
// dollar total (not treated as $0) so the headline never understates by averaging in unknown costs.

import type { ReconcileReport } from "@/reconcile/variance/reconcileReport";

export interface DollarVarianceSummary {
  totalDollarVariance: number;
  skuCount: number;
}

function unitCostForLine(partNumbers: string[], unitCosts: Record<string, number>): number | undefined {
  for (const pn of partNumbers) {
    if (Object.prototype.hasOwnProperty.call(unitCosts, pn)) return unitCosts[pn];
  }
  return undefined;
}

export function computeDollarVariance(report: ReconcileReport, unitCosts: Record<string, number>): DollarVarianceSummary {
  let totalDollarVariance = 0;
  let skuCount = 0;
  for (const line of report.lines) {
    if (line.bucket !== "variance" || line.delta === undefined) continue;
    const unitCost = unitCostForLine(line.partNumbers, unitCosts);
    if (unitCost === undefined) continue;
    totalDollarVariance += Math.abs(line.delta) * unitCost;
    skuCount += 1;
  }
  // Round to the cent to avoid floating-point noise (e.g. 0.1 + 0.2) in the headline.
  return { totalDollarVariance: Math.round(totalDollarVariance * 100) / 100, skuCount };
}
