// Pure aggregation logic for the History page: given a session's counts rows, compute the two
// numbers the history table shows (units scanned, distinct products counted). No React, no
// next/*, no store access - keeps this trivially unit testable and reusable from both the mock
// and cloud read paths (both ultimately produce InventoryCount-shaped rows keyed by productId).

/** Minimal shape this module needs from an InventoryCount / ServerCount row. */
export interface SessionCountRow {
  productId: string;
  quantity: number;
}

export interface SessionAggregate {
  /** Total units scanned in the session (sum of quantities; a duplicate scan increments this, not distinctProducts). */
  units: number;
  /** Number of distinct products counted in the session. */
  distinctProducts: number;
}

/**
 * Aggregate one session's count rows into {units, distinctProducts}. A row's quantity already
 * reflects how many times its product was scanned (the ledger increments quantity in place rather
 * than creating duplicate rows), so distinctProducts is simply the row count and units is the sum
 * of quantities.
 */
export function aggregateSessionCounts(rows: SessionCountRow[]): SessionAggregate {
  const byProduct = new Map<string, number>();
  for (const row of rows) {
    byProduct.set(row.productId, (byProduct.get(row.productId) ?? 0) + row.quantity);
  }
  let units = 0;
  for (const qty of byProduct.values()) units += qty;
  return { units, distinctProducts: byProduct.size };
}

/** Minimal shape this module needs from a SessionHistoryEntry's archived scan rows
 *  (services/sessions/sessionHistory.ts) - the auto-saved trace of a past session. */
export interface HistoryScanRow {
  code: string;
  productName: string;
  quantityDelta: number;
}

/**
 * Aggregate an archived session's scan rows into the same {units, distinctProducts} shape the
 * History table shows. Archived rows carry no productId, so distinctness keys on the resolved
 * product name, falling back to the scanned code for unidentified rows ("Unidentified item") so two
 * different unknown codes still count as two distinct items rather than collapsing into one.
 */
export function aggregateHistoryRows(rows: HistoryScanRow[]): SessionAggregate {
  const distinct = new Set<string>();
  let units = 0;
  for (const row of rows) {
    distinct.add(row.productName === "Unidentified item" ? `code:${row.code}` : `name:${row.productName}`);
    units += row.quantityDelta;
  }
  return { units, distinctProducts: distinct.size };
}
