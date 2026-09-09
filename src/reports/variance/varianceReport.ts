// Variance / shrinkage report: pure comparison of two count snapshots. No React / next imports
// (services must stay pure and testable outside the UI, per project conventions).

import { buildCsv } from "@/reports/export/csvExport";

export interface CountSnapshot {
  id: string;
  label: string;
  takenAt: string;
  lines: Array<{ productId: string; name: string; qty: number }>;
}

export interface VarianceRow {
  productId: string;
  name: string;
  prevQty: number;
  currQty: number;
  delta: number;
}

/**
 * Compare two count snapshots and return one row per product that appears in EITHER snapshot.
 *
 * Decisions (documented per task brief):
 * - Zero-delta (unchanged) rows are INCLUDED, not filtered. A shrinkage report's purpose is a full
 *   reconciliation: an owner needs to see "counted, no change" as a positive confirmation, not just
 *   the products that moved. Callers that only want changes can filter `delta !== 0` themselves.
 * - A product present in only one snapshot appears with the other side's qty as 0 (added: prevQty 0,
 *   removed: currQty 0), so delta reflects the full gain/loss.
 * - Duplicate productId WITHIN a single snapshot's `lines` is rejected: throws a clear Error rather
 *   than silently filtering, because a duplicate means the snapshot itself was built incorrectly
 *   (snapshotCount builds one line per finalCounts row, which is already unique by productId) and
 *   silently picking one would hide that bug and could misreport variance.
 * - Sort: by Math.abs(delta) descending (biggest swings first). Ties break by `name` ascending
 *   (stable, human-readable ordering for equal-magnitude deltas).
 */
export function computeVariance(a: CountSnapshot, b: CountSnapshot): VarianceRow[] {
  assertNoDuplicateProductIds(a);
  assertNoDuplicateProductIds(b);

  const prevById = new Map(a.lines.map((l) => [l.productId, l]));
  const currById = new Map(b.lines.map((l) => [l.productId, l]));
  const allProductIds = new Set([...prevById.keys(), ...currById.keys()]);

  const rows: VarianceRow[] = [];
  for (const productId of allProductIds) {
    const prev = prevById.get(productId);
    const curr = currById.get(productId);
    const prevQty = prev?.qty ?? 0;
    const currQty = curr?.qty ?? 0;
    const name = curr?.name ?? prev?.name ?? "";
    rows.push({ productId, name, prevQty, currQty, delta: currQty - prevQty });
  }

  return rows.sort((x, y) => {
    const byMagnitude = Math.abs(y.delta) - Math.abs(x.delta);
    if (byMagnitude !== 0) return byMagnitude;
    return x.name.localeCompare(y.name);
  });
}

/** CSV export for a variance report. Product-facing columns only (name + quantities) - no barcode,
 *  cleanCode, matchType, or provider fields, matching the customer-data-firewall convention already
 *  used by the other CSV exports (csvExport.ts). Reuses the same buildCsv() helper so escaping/BOM/
 *  CSV-injection guarding stays identical to every other export in the app. */
export function exportVarianceCsv(rows: VarianceRow[]): string {
  const headers = ["product_name", "previous_quantity", "current_quantity", "delta"];
  const csvRows = rows.map((r) => [r.name, r.prevQty, r.currQty, r.delta]);
  return buildCsv(headers, csvRows);
}

function assertNoDuplicateProductIds(snapshot: CountSnapshot): void {
  const seen = new Set<string>();
  for (const line of snapshot.lines) {
    if (seen.has(line.productId)) {
      throw new Error(
        `computeVariance: duplicate productId "${line.productId}" in snapshot "${snapshot.label}" (${snapshot.id}). Each snapshot's lines must be unique by productId.`,
      );
    }
    seen.add(line.productId);
  }
}
