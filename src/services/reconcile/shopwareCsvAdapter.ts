import { parse as parseCsvSync } from "csv-parse/sync";
import type { AdapterResult, ExpectedInventoryRow } from "@/services/reconcile/types";
import { sanitizeCell } from "@/services/csvImport";

// Shop-Ware CSV adapter (Task 4, AM-R3). Pure, deterministic; NEVER throws on bad input. Uploaded
// CSV content is UNTRUSTED data (semantic firewall): every cell is parsed as plain text, never
// obeyed as an instruction - a cell reading "ignore previous instructions" just lands in a field.
//
// Column mapping is isolated in ONE exported const so the real Shop-Ware export (once seen) plugs
// in as a header-alias tweak here, without touching parsing/aggregation logic below.
export const SHOPWARE_COLUMN_MAP = {
  partNumber: [
    "part_number",
    "part number",
    "part_no",
    "sku",
    "part_#",
    "part #",
    "pn",
    "p/sn",
    "item_no.",
    "item no.",
    "item_no",
    "item no",
    "mfg_part_number",
    "mfg part number",
    "us_number",
    "us number",
    "stock_number",
    "stock number",
  ],
  aliasPartNumbers: ["alias_part_numbers", "alias part numbers", "alt_part_numbers"],
  brand: ["brand", "make"],
  model: ["model"],
  size: ["size", "tire_size"],
  specs: ["specs", "description"],
  qtyOnHand: ["qty_on_hand", "quantity_on_hand", "qty on hand", "on_hand", "qoh"],
  qtyAvailable: ["qty_available", "quantity_available", "qty available", "available"],
  location: ["location", "bin"],
  unit: ["unit", "uom"],
  // Price/cost columns are recognized ONLY so they can be excluded from `raw` - never surfaced.
  priceCostColumns: ["cost", "retail", "price", "unit_cost", "list_price", "msrp"],
} as const;

/** Normalize a header/candidate string the SAME way real headers are normalized (line ~80 below):
 *  lowercase + collapse whitespace runs to a single underscore. Applying this to candidates too
 *  keeps the map human-readable ("part number") while guaranteeing it can never desync from the
 *  header transform again. */
function normalizeHeaderLike(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "_");
}

/** First present header key among a set of accepted synonyms (case-insensitive, already lowercased). */
function findHeaderKey(headers: string[], candidates: readonly string[]): string | undefined {
  const set = new Set(headers);
  for (const candidate of candidates) {
    const normalized = normalizeHeaderLike(candidate);
    if (set.has(normalized)) return normalized;
  }
  return undefined;
}

/** Parse a numeric cell; returns undefined (not NaN/0) when blank or unparseable. */
function parseQty(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/**
 * Parse a Shop-Ware-style inventory export (untrusted CSV text) into aggregated expected-inventory
 * rows. Never throws: malformed rows are reported in `unparseable` with a 1-based line number and a
 * reason, and good rows still parse. Duplicate part numbers (multi-location rows) are summed into a
 * single row (AM-R10c). A UOM present and not "each" (case-insensitive) routes the row to
 * `uomReview` instead of `rows` (AM-R10d); an absent UOM column adds an assumption string instead of
 * failing rows. Price/cost columns are dropped before anything reaches `raw`.
 */
export function parseShopwareCsv(fileText: string): AdapterResult {
  const rows: ExpectedInventoryRow[] = [];
  const uomReview: ExpectedInventoryRow[] = [];
  const unparseable: Array<{ line: number; reason: string }> = [];
  const assumptions: string[] = [];

  if (!fileText || !fileText.trim()) {
    unparseable.push({ line: 1, reason: "File is empty." });
    return { rows, uomReview, unparseable, assumptions };
  }

  let records: Record<string, string>[];
  let headers: string[] = [];
  try {
    records = parseCsvSync(fileText, {
      columns: (header: string[]) => {
        headers = header.map((h) => sanitizeCell(h).toLowerCase().replace(/\s+/g, "_"));
        return headers;
      },
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (e) {
    unparseable.push({
      line: 1,
      reason: `Could not parse this file as CSV: ${e instanceof Error ? e.message : "unknown error"}`,
    });
    return { rows, uomReview, unparseable, assumptions };
  }

  if (records.length === 0) {
    unparseable.push({ line: 1, reason: "File has a header row but no data rows." });
    return { rows, uomReview, unparseable, assumptions };
  }

  const partNumberKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.partNumber);
  const aliasKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.aliasPartNumbers);
  const brandKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.brand);
  const modelKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.model);
  const sizeKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.size);
  const specsKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.specs);
  const qtyOnHandKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.qtyOnHand);
  const qtyAvailableKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.qtyAvailable);
  const unitKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.unit);
  const priceCostKeys = new Set(headers.filter((h) => SHOPWARE_COLUMN_MAP.priceCostColumns.includes(h as never)));

  if (!partNumberKey) {
    unparseable.push({
      line: 1,
      reason: `Missing required column: part number. Seen: ${headers.join(", ") || "(none)"}.`,
    });
    return { rows, uomReview, unparseable, assumptions };
  }
  if (!unitKey) {
    assumptions.push('Quantities assumed unit "each" (no UOM column).');
  }

  // Aggregate by part number (multi-location rows sum qty into one row), preserving first-seen order.
  const order: string[] = [];
  const aggregated = new Map<
    string,
    { row: ExpectedInventoryRow; nonEachUnit: boolean }
  >();

  records.forEach((record, idx) => {
    const line = idx + 2; // header is line 1; first data record is line 2
    const sanitizedRecord = Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, sanitizeCell(String(value ?? ""))]),
    );

    const partNumber = sanitizedRecord[partNumberKey] ?? "";
    if (!partNumber) {
      unparseable.push({ line, reason: "Missing required field: part number." });
      return;
    }

    const onHand = qtyOnHandKey ? parseQty(sanitizedRecord[qtyOnHandKey]) : undefined;
    const available = qtyAvailableKey ? parseQty(sanitizedRecord[qtyAvailableKey]) : undefined;
    // AM-R3: on-hand (physical) preferred over available when both exist.
    const qty = onHand ?? available;
    if (qty === undefined) {
      unparseable.push({ line, reason: "Missing or unparseable quantity (no on-hand or available value)." });
      return;
    }

    const aliasRaw = aliasKey ? sanitizedRecord[aliasKey] ?? "" : "";
    const aliasPartNumbers = aliasRaw ? aliasRaw.split(/[|;]/).map((v) => v.trim()).filter(Boolean) : [];

    const unitValue = unitKey ? sanitizedRecord[unitKey] ?? "" : "";
    const nonEachUnit = unitValue !== "" && unitValue.toLowerCase() !== "each";

    // raw: every surviving column EXCEPT price/cost columns, never included regardless of mapping.
    const raw: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizedRecord)) {
      if (priceCostKeys.has(key)) continue;
      raw[key] = value;
    }

    const existing = aggregated.get(partNumber);
    if (existing) {
      existing.row.qty += qty;
      for (const alias of aliasPartNumbers) {
        if (!existing.row.partNumbers.includes(alias)) existing.row.partNumbers.push(alias);
      }
      // If either duplicate-location row is flagged non-each, keep it flagged for review.
      existing.nonEachUnit = existing.nonEachUnit || nonEachUnit;
      return;
    }

    const partNumbers = [partNumber, ...aliasPartNumbers.filter((a) => a !== partNumber)];
    const expectedRow: ExpectedInventoryRow = {
      externalId: partNumber,
      partNumbers,
      brand: brandKey ? sanitizedRecord[brandKey] || undefined : undefined,
      model: modelKey ? sanitizedRecord[modelKey] || undefined : undefined,
      sizeText: sizeKey ? sanitizedRecord[sizeKey] || undefined : undefined,
      specs: specsKey ? sanitizedRecord[specsKey] || undefined : undefined,
      qty,
      raw,
    };
    aggregated.set(partNumber, { row: expectedRow, nonEachUnit });
    order.push(partNumber);
  });

  for (const partNumber of order) {
    const entry = aggregated.get(partNumber)!;
    if (entry.nonEachUnit) uomReview.push(entry.row);
    else rows.push(entry.row);
  }

  return { rows, uomReview, unparseable, assumptions };
}
