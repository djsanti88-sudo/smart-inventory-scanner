import type { Alias, Product } from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";
import { detectCodeType, codeTypeToAliasType } from "@/services/codeTypeDetector";
import { parse as parseCsvSync } from "csv-parse/sync";
import { gradeBarcode } from "@/services/upc/barcodeTrust";
import { isGtinShaped } from "@/services/upc/gtin";

// Deterministic CSV import (MVP). Pure functions (no React, no next/*). Treats ALL CSV content as
// UNTRUSTED data (semantic firewall): it is parsed as data, never interpreted as instructions.
// Generic + multi-trade: products + approved aliases from UPC/GTIN/EAN/SKU/vendor codes. It validates
// duplicate codes (skipped) and conflicting codes (a code that already maps to a different product is
// NOT applied). The store writes the resulting products/aliases through the existing durable queue
// (SAVE_PRODUCT + RESOLVE_ALIAS). ImportJob tracking is intentionally DEFERRED (documented).

/** RFC4180-ish parser: handles quoted fields, embedded commas/newlines, and "" escaped quotes. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      // swallow; the following \n (if any) ends the record, otherwise a lone \r ends it
      if (s[i + 1] !== "\n") endRecord();
    } else {
      field += ch;
    }
  }
  // flush the trailing field/record if the file did not end with a newline
  if (field.length > 0 || record.length > 0) endRecord();

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r];
    if (cells.length === 1 && cells[0].trim() === "") continue; // skip blank lines
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] ?? "").trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

/** First non-empty value among a set of accepted header aliases. */
function pick(row: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    if (row[k]) return row[k];
  }
  return "";
}

export interface ImportConflict {
  code: string;
  reason: string;
}

export interface ProductImportPlan {
  products: Product[];
  aliases: Alias[];
  duplicates: string[]; // codes skipped (repeated within the import for the same product)
  conflicts: ImportConflict[]; // codes NOT applied (already map to a different product)
  rowsParsed: number;
}

export interface BuildImportParams {
  rows: Record<string, string>[];
  existingProducts: Product[];
  existingAliases: Alias[];
  businessId: string;
  idFactory: () => string;
  now: () => string;
}

/**
 * Build products + approved aliases from parsed CSV rows. Pure + deterministic. Conflicting codes
 * (a code already mapped to a DIFFERENT product, whether pre-existing or earlier in this import) are
 * reported and NOT applied; a product with no usable (new) alias is not created.
 */
export function buildProductImport(params: BuildImportParams): ProductImportPlan {
  const { rows, existingProducts, existingAliases, businessId, idFactory, now } = params;

  // code -> productId from already-approved aliases (the source of truth for "belongs to product X").
  const existingCodeOwner = new Map<string, string>();
  for (const a of existingAliases) {
    if (a.approved && a.cleanCode) existingCodeOwner.set(a.cleanCode, a.productId);
  }
  const existingNames = new Set(existingProducts.map((p) => p.name.trim().toLowerCase()).filter(Boolean));

  const products: Product[] = [];
  const aliases: Alias[] = [];
  const duplicates: string[] = [];
  const conflicts: ImportConflict[] = [];
  const seenInFile = new Map<string, string>(); // cleanCode -> productId assigned in THIS import

  for (const row of rows) {
    const name = pick(row, ["name", "product_name"]);
    const brand = pick(row, ["brand"]);
    const category = pick(row, ["category"]);
    const specsShort = pick(row, ["specs", "specs_short"]);
    const primarySku = pick(row, ["sku", "primary_sku"]);
    const primaryBarcode = pick(row, ["barcode", "primary_barcode"]);
    const gtin = pick(row, ["gtin"]);
    const upc = pick(row, ["upc"]);
    const ean = pick(row, ["ean"]);
    const location = pick(row, ["location"]);
    const vendorRaw = pick(row, ["vendor_codes", "vendor", "vendor_code"]);
    const vendorCodes = vendorRaw ? vendorRaw.split(/[|;]/).map((v) => v.trim()).filter(Boolean) : [];

    // TRUST GATE (spec v3 AM-4.1): gtin/upc/ean columns must be valid GTINs; primary_barcode is
    // rejected only when GTIN-shaped-with-bad-check-digit or a placeholder (a physical label may
    // legitimately be a non-GTIN vendor code). Rejected values never become aliases OR product
    // identity fields. sku/vendor codes are not barcodes and are never graded.
    const rejectedCodes = new Set<string>();
    const gateStrict = (value: string, field: string): string => {
      if (!value) return value;
      const grade = gradeBarcode({ barcode: value, partNumber: primarySku });
      if (grade.verdict === "rejected") {
        conflicts.push({ code: value, reason: `barcode rejected: ${grade.reason} (${field})` });
        rejectedCodes.add(value);
        return "";
      }
      return value;
    };
    const gatePhysicalLabel = (value: string): string => {
      if (!value || !isGtinShaped(value)) {
        // non-GTIN label: only the placeholder blocklist applies
        const grade = value ? gradeBarcode({ barcode: value }) : null;
        if (grade?.placeholder) {
          conflicts.push({ code: value, reason: `barcode rejected: ${grade.reason} (barcode)` });
          rejectedCodes.add(value);
          return "";
        }
        return value;
      }
      return gateStrict(value, "barcode");
    };
    const gatedGtin = gateStrict(gtin, "gtin");
    const gatedUpc = gateStrict(upc, "upc");
    const gatedEan = gateStrict(ean, "ean");
    const gatedPrimaryBarcode = gatePhysicalLabel(primaryBarcode);

    // Candidate scannable codes for this row (dedup raw, preserve order).
    const rawCodes = [primarySku, gatedPrimaryBarcode, gatedGtin, gatedUpc, gatedEan, ...vendorCodes]
      .filter(Boolean)
      .filter((c) => !rejectedCodes.has(c));
    if (rawCodes.length === 0) {
      conflicts.push({ code: name || "(row)", reason: "no scannable code (sku/barcode/gtin/upc/ean/vendor) in row" });
      continue;
    }

    const productId = `prod-import-${idFactory()}`;
    const rowAliases: Alias[] = [];
    const rowCleanCodes: string[] = [];

    for (const raw of rawCodes) {
      const cleanCode = cleanScanCode(raw).cleanCode;
      if (!cleanCode) continue;

      const ownerInFile = seenInFile.get(cleanCode);
      if (ownerInFile) {
        if (ownerInFile === productId) duplicates.push(cleanCode); // same row repeated this code
        else conflicts.push({ code: cleanCode, reason: "code appears for more than one product in the file" });
        continue;
      }
      const existingOwner = existingCodeOwner.get(cleanCode);
      if (existingOwner) {
        conflicts.push({ code: cleanCode, reason: `code already maps to product ${existingOwner}` });
        continue;
      }

      const codeType = detectCodeType(cleanCode);
      rowAliases.push({
        id: `alias-import-${idFactory()}`,
        businessId,
        productId,
        rawCodeExample: raw,
        cleanCode,
        normalizedCode: cleanScanCode(raw).normalizedCandidates.slice(-1)[0] ?? cleanCode,
        aliasType: codeTypeToAliasType(codeType),
        source: "manual",
        confidence: 1,
        approved: true, // a human-uploaded mapping is trusted -> resolves deterministically
        createdAt: now(),
        updatedAt: now(),
        createdBy: "csv_import",
        lastSeenAt: now(),
        syncStatus: "pending",
        idempotencyKey: `${businessId}::import::${cleanCode}`,
      });
      rowCleanCodes.push(cleanCode);
      seenInFile.set(cleanCode, productId);
    }

    if (rowAliases.length === 0) continue; // every code conflicted -> no product created

    const product: Product = {
      id: productId,
      businessId,
      name: name || rowCleanCodes[0],
      brand,
      category,
      specsShort,
      specsFull: "",
      primarySku,
      primaryBarcode: gatedPrimaryBarcode,
      gtin: gatedGtin,
      upc: gatedUpc,
      ean: gatedEan,
      vendorCodes,
      aliases: rowCleanCodes,
      imageUrl: "",
      productUrl: "",
      location,
      notes: existingNames.has((name || "").trim().toLowerCase()) ? "imported (name matches an existing product)" : "",
      status: "active",
      source: "manual",
      confidence: 1,
      verified: true, // human-provided identity is trusted
      createdAt: now(),
      updatedAt: now(),
      createdBy: "csv_import",
      updatedBy: "csv_import",
    };
    products.push(product);
    aliases.push(...rowAliases);
  }

  return { products, aliases, duplicates, conflicts, rowsParsed: rows.length };
}

// ------------------------------------------------------------------------------------------------
// Task 3.6: onboarding CSV import (preview + explicit confirm).
//
// Separate, deliberately simpler API from buildProductImport above: a shop owner selects their own
// file in the CsvImportPanel onboarding UI, sees a PREVIEW (first 20 rows + any bad-row errors), and
// only applies it after an explicit confirm click - it never imports automatically on file select.
//
// Uses csv-parse (moved from devDependencies to dependencies in package.json since the panel needs
// it at runtime, not just in tests) instead of the hand-rolled RFC4180 parser above.
//
// SEMANTIC FIREWALL: every cell is untrusted data. It is never interpreted as instructions - a cell
// that reads "ignore previous instructions" is just a string that lands in a name/sku field. Every
// field is: (1) stripped of control characters, (2) capped at 500 characters, (3) defused against
// CSV-formula-injection (=, +, -, @ leading characters that a spreadsheet app could execute).
// ------------------------------------------------------------------------------------------------

export interface ImportRow {
  name: string;
  sku?: string;
  barcode?: string;
  qty?: number;
}

export interface ImportError {
  line: number; // 1-based, counts the header as line 1 (so data row N is reported as line N+1)
  reason: string;
}

export interface ImportSummary {
  created: number;
  merged: number;
  aliasesAdded: number;
  skipped: number;
}

const MAX_FIELD_LENGTH = 500;

/** Strip control characters (\x00-\x1F except \t, and \x7F) that have no place in product data. */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Defuse CSV/spreadsheet formula injection: a cell starting with =, +, -, or @ can execute as a
 * formula when the export is later opened in Excel/Sheets. Prefix with a single quote (the standard
 * "force text" defusal) rather than deleting the content, so the original value stays legible.
 */
function defuseFormulaInjection(value: string): string {
  if (/^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

/** Full untrusted-cell sanitizer: control-char strip -> length cap -> formula defusal. */
function sanitizeCell(raw: string): string {
  const stripped = stripControlChars(raw).trim();
  const capped = stripped.length > MAX_FIELD_LENGTH ? stripped.slice(0, MAX_FIELD_LENGTH) : stripped;
  return defuseFormulaInjection(capped);
}

/** First non-empty header key among case-insensitive synonyms. */
function pickHeader(row: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Parse raw CSV text (untrusted) into ImportRow[] + ImportError[]. NEVER throws on bad data - a
 * malformed file, a missing name, or an unparseable qty are all collected as errors with 1-based
 * line numbers instead of aborting the whole import.
 */
export function parseCsvImport(text: string): { rows: ImportRow[]; errors: ImportError[] } {
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];

  if (!text || !text.trim()) return { rows, errors };

  let records: Record<string, string>[];
  try {
    records = parseCsvSync(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (e) {
    // A truly unparseable file (e.g. an unterminated quote in strict mode) is reported as a single
    // error rather than thrown. relax_quotes above already recovers from most real-world messiness.
    errors.push({ line: 1, reason: `Could not parse this file as CSV: ${e instanceof Error ? e.message : "unknown error"}` });
    return { rows, errors };
  }

  records.forEach((record, idx) => {
    const line = idx + 2; // header is line 1; first data record is line 2

    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) {
      sanitized[k] = sanitizeCell(typeof v === "string" ? v : String(v ?? ""));
    }

    const name = pickHeader(sanitized, ["name", "product"]);
    const sku = pickHeader(sanitized, ["sku"]);
    const barcode = pickHeader(sanitized, ["barcode", "upc", "ean"]);
    const qtyRaw = pickHeader(sanitized, ["qty", "quantity", "count"]);

    if (!name) {
      errors.push({ line, reason: "Missing required field: name" });
      return;
    }

    let qty: number | undefined;
    if (qtyRaw !== undefined) {
      const n = Number(qtyRaw);
      if (!Number.isFinite(n) || Number.isNaN(n)) {
        errors.push({ line, reason: `Unparseable quantity: "${qtyRaw}"` });
        return;
      }
      qty = n;
    }

    const row: ImportRow = { name };
    if (sku) row.sku = sku;
    if (barcode) row.barcode = barcode;
    if (qty !== undefined) row.qty = qty;
    rows.push(row);
  });

  return { rows, errors };
}

/**
 * Minimal read/write surface applyCsvImport needs against the real product/alias store data.
 * Mirrors the shapes already used by scanStore (Product/Alias from @/types) so a caller can wire
 * this directly to Zustand state without inventing a parallel/incompatible model.
 */
export interface ImportTarget {
  /** The product currently owning this code via an APPROVED alias, or null if the code is unknown. */
  findProductByAlias: (cleanCode: string) => Product | null;
  /** The product currently using this exact SKU as its primarySku, or null. Used for conflict detection
   *  when a row's barcode is already claimed but the row's sku points at a DIFFERENT product. */
  findProductBySku: (sku: string) => Product | null;
  /** Increment an existing product's quantity by delta (default 1 when the row omits qty). */
  incrementQuantity: (productId: string, delta: number) => void;
  /** Create a new product from the row. importId is a stable per-import-run id for idempotency. */
  createProduct: (row: ImportRow, importId: string) => Product;
  /** Add an approved, source: csv_import alias for productId -> cleanCode. */
  addAlias: (productId: string, cleanCode: string, importId: string) => void;
  /** True if this exact import run (by content hash) has already been applied - makes re-import a no-op. */
  hasImportRun: (importId: string) => boolean;
}

/** Deterministic content hash (djb2-ish) used as the idempotent import id. Same rows -> same id. */
function hashImportContent(rows: ImportRow[]): string {
  const content = rows
    .map((r) => [r.name, r.sku ?? "", r.barcode ?? "", r.qty ?? ""].join("|"))
    .join("\n");
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return `csvimport-${(hash >>> 0).toString(36)}-${content.length}`;
}

/**
 * Apply parsed rows against the real product/alias data (via ImportTarget). Idempotent: importing
 * the exact same rows twice is a no-op the second time (net-zero new products/aliases), implemented
 * via a content-hash import id following the store's existing idempotency-key pattern (see
 * services/idempotency.ts - a key built once and reused, never regenerated per retry).
 *
 * Per row:
 *  - barcode matches an EXISTING approved alias -> merge: increment that product's quantity, do NOT
 *    touch/duplicate the alias.
 *  - barcode present but unknown -> create a new product + an approved csv_import alias for it.
 *  - barcode already belongs to a product, but the row's sku points at a DIFFERENT existing product
 *    (a genuine re-pointing attempt) -> skipped, never silently repointed.
 *  - no barcode and no sku (nothing to key on) -> always create a new product. There is nothing to
 *    merge against or conflict with, and refusing to import a row with only a name would silently
 *    drop legitimate rows (e.g. non-barcoded shop goods) from the owner's own file.
 *
 * ASSUMPTION (documented, not yet owner-approved): this loop is NOT transactional. If target.* throws
 * partway through (e.g. a store write fails on row 50 of 200), rows before the failure are already
 * applied and rows after it are not - there is no rollback. hasImportRun's per-row idempotency (via
 * importId embedded in each product id / alias idempotencyKey) means a retry of the SAME file will
 * skip the already-applied rows and only (re)apply the remainder, so a retry is safe, but a partial
 * failure is not atomic within a single run. Acceptable for the current single-shop MVP scope; revisit
 * if/when imports need all-or-nothing semantics.
 */
export function applyCsvImport(rows: ImportRow[], target: ImportTarget): ImportSummary {
  const importId = hashImportContent(rows);
  const summary: ImportSummary = { created: 0, merged: 0, aliasesAdded: 0, skipped: 0 };

  if (target.hasImportRun(importId)) {
    summary.skipped = rows.length;
    return summary;
  }

  for (const row of rows) {
    // Real scans always resolve through cleanScanCode (see resolver.ts / buildProductImport above) -
    // a CSV barcode printed with dashes/spaces ("012-345-678905") must match the SAME clean code an
    // approved alias already stores, or it silently mints a duplicate product. row.barcode itself
    // stays untouched (raw, for display); only the matching/alias-creation key is normalized here,
    // using the most-normalized candidate (separators stripped) so a dashed/spaced CSV value matches
    // a plain scanned code, same as the sibling buildProductImport path's normalizedCode field.
    const cleaned = row.barcode?.trim() ? cleanScanCode(row.barcode) : undefined;
    const barcode = cleaned ? cleaned.normalizedCandidates.slice(-1)[0] ?? cleaned.cleanCode : undefined;

    if (barcode) {
      const existingByBarcode = target.findProductByAlias(barcode);
      if (existingByBarcode) {
        // Genuine conflict: the row's sku names a DIFFERENT identity than the product that already
        // owns this barcode - either it matches a different existing product outright, or it simply
        // disagrees with the barcode-owner's own sku. Never repoint the alias - skip and let the
        // owner reconcile by hand.
        if (row.sku) {
          const productBySku = target.findProductBySku(row.sku);
          const pointsAtDifferentProduct = productBySku && productBySku.id !== existingByBarcode.id;
          const skuDisagreesWithOwner =
            !productBySku && existingByBarcode.primarySku && existingByBarcode.primarySku !== row.sku;
          if (pointsAtDifferentProduct || skuDisagreesWithOwner) {
            summary.skipped += 1;
            continue;
          }
        }
        target.incrementQuantity(existingByBarcode.id, row.qty ?? 1);
        summary.merged += 1;
        continue;
      }

      // Unknown barcode -> new product + approved alias.
      const product = target.createProduct(row, importId);
      target.addAlias(product.id, barcode, importId);
      summary.created += 1;
      summary.aliasesAdded += 1;
      continue;
    }

    // No barcode. If the sku matches an existing product, treat it as a merge (increment quantity)
    // rather than minting a duplicate product for the same known item.
    if (row.sku) {
      const existingBySku = target.findProductBySku(row.sku);
      if (existingBySku) {
        target.incrementQuantity(existingBySku.id, row.qty ?? 1);
        summary.merged += 1;
        continue;
      }
    }

    // Nothing to key on (no barcode, no matching sku) -> always create a new product.
    target.createProduct(row, importId);
    summary.created += 1;
  }

  return summary;
}
