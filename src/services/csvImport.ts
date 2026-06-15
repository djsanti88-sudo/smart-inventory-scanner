import type { Alias, Product } from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";
import { detectCodeType, codeTypeToAliasType } from "@/services/codeTypeDetector";

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

    // Candidate scannable codes for this row (dedup raw, preserve order).
    const rawCodes = [primarySku, primaryBarcode, gtin, upc, ean, ...vendorCodes].filter(Boolean);
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
      primaryBarcode,
      gtin,
      upc,
      ean,
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
