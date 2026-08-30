// Reconcile module (Phase 2, AM-R3): shared types for the Shop-Ware reconcile adapter, matcher,
// report, and UI (Tasks 4-7). Pure types only - no React / next/* imports (services stay pure).

/** One aggregated, expected-inventory row derived from an external shop-management export. */
export interface ExpectedInventoryRow {
  /** Stable per aggregated part (primary part number). */
  externalId: string;
  /** Primary + alias part numbers, raw as parsed. */
  partNumbers: string[];
  brand?: string;
  model?: string;
  sizeText?: string;
  specs?: string;
  barcode?: string;
  name?: string;
  category?: string;
  /** PHYSICAL ON-HAND quantity, summed across locations (AM-R3). */
  qty: number;
  /** Sanitized surviving columns only. NEVER includes price/cost fields. */
  raw: Record<string, string>;
}

export interface AdapterResult {
  rows: ExpectedInventoryRow[];
  /** UOM present and not "each" (AM-R3) - held out of `rows` for manual review. */
  uomReview: ExpectedInventoryRow[];
  unparseable: Array<{ line: number; reason: string }>;
  /** e.g. 'Quantities assumed unit "each" (no UOM column).' */
  assumptions: string[];
}
