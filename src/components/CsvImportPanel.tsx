"use client";

import { useRef, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import type { Product, Alias } from "@/types";
import {
  parseCsvImport,
  applyCsvImport,
  type ImportRow,
  type ImportError,
  type ImportSummary,
  type ImportTarget,
} from "@/services/csvImport";

// Task 3.6: CSV import onboarding panel. A shop owner selects their own file, sees a PREVIEW (first
// 20 rows + any bad-row errors), and only applies it after an explicit confirm click - it never
// imports automatically on file selection. Product neutral: works for tires, parts, supplements,
// tools, retail, or any physical inventory.
//
// Reads/writes the store's products + aliases directly via useScanStore.getState()/.setState() so no
// changes are needed to the store file itself. A human uploaded this list, so aliases created here are
// approved immediately and tagged source: "csv_import" (see services/csvImport.ts for the trust rule).

const PREVIEW_LIMIT = 20;

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the ImportTarget against the live scanStore state (read via getState, write via setState). */
function buildStoreImportTarget(): ImportTarget {
  return {
    findProductByAlias: (cleanCode) => {
      const { aliases, products } = useScanStore.getState();
      const alias = aliases.find((a) => a.approved && a.cleanCode === cleanCode);
      if (!alias) return null;
      return products.find((p) => p.id === alias.productId) ?? null;
    },
    findProductBySku: (sku) => {
      const { products } = useScanStore.getState();
      return products.find((p) => p.primarySku === sku) ?? null;
    },
    incrementQuantity: (productId) => {
      // Quantity in this onboarding import means "how many units this row represents in the
      // catalog", tracked here as a bump to the product's own count fields is out of scope for the
      // Product entity (counts live on InventoryCount, session-scoped). For a catalog-only import we
      // record the merge by touching updatedAt/updatedBy so the row is visibly refreshed.
      useScanStore.setState((s) => ({
        products: s.products.map((p) =>
          p.id === productId ? { ...p, updatedAt: new Date().toISOString(), updatedBy: "csv_import" } : p,
        ),
      }));
    },
    createProduct: (row: ImportRow, importId: string) => {
      const state = useScanStore.getState();
      const nowIso = new Date().toISOString();
      const product: Product = {
        // importId is embedded (not just a random suffix) so hasImportRun can detect a verbatim
        // re-import of the same file content and make applyCsvImport a true no-op the second time.
        id: `${nextId("prod-csvimport")}--${importId}`,
        businessId: state.businessId,
        name: row.name,
        brand: "",
        category: "",
        specsShort: "",
        specsFull: "",
        primarySku: row.sku ?? "",
        primaryBarcode: row.barcode ?? "",
        gtin: "",
        upc: "",
        ean: "",
        vendorCodes: [],
        aliases: row.barcode ? [row.barcode] : [],
        imageUrl: "",
        productUrl: "",
        location: "",
        notes: "",
        status: "active",
        source: "manual",
        confidence: 1,
        verified: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: "csv_import",
        updatedBy: "csv_import",
      };
      useScanStore.setState((s) => ({ products: [...s.products, product] }));
      return product;
    },
    addAlias: (productId, cleanCode, importId) => {
      const state = useScanStore.getState();
      const nowIso = new Date().toISOString();
      const alias: Alias = {
        id: nextId("alias-csvimport"),
        businessId: state.businessId,
        productId,
        rawCodeExample: cleanCode,
        cleanCode,
        normalizedCode: cleanCode,
        aliasType: "barcode",
        source: "csv_import",
        confidence: 1,
        approved: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: "csv_import",
        lastSeenAt: nowIso,
        syncStatus: "pending",
        // Idempotency key follows the store's existing `scope::action::key` pattern, with the
        // per-import-run id as its own segment so hasImportRun can match it EXACTLY (never a
        // substring), consistent with the idempotency-key format used elsewhere in the codebase.
        idempotencyKey: `${state.businessId}::csv_import::${importId}::${cleanCode}`,
      };
      useScanStore.setState((s) => ({ aliases: [...s.aliases, alias] }));
    },
    hasImportRun: (importId) => {
      const { aliases, products } = useScanStore.getState();
      const productSuffix = `--${importId}`;
      const aliasInfix = `::${importId}::`;
      return (
        products.some((p) => p.id.endsWith(productSuffix)) ||
        aliases.some((a) => a.idempotencyKey.includes(aliasInfix))
      );
    },
  };
}

export function CsvImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [fileName, setFileName] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [parseErrorMsg, setParseErrorMsg] = useState("");

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setSummary(null);
    setParseErrorMsg("");
    try {
      const text = await file.text();
      const { rows: parsedRows, errors: parsedErrors } = parseCsvImport(text);
      setRows(parsedRows);
      setErrors(parsedErrors);
      setFileName(file.name);
    } catch (err) {
      setRows([]);
      setErrors([]);
      setParseErrorMsg(`Could not read this file. ${err instanceof Error ? err.message : ""}`.trim());
    }
  }

  function handleConfirm() {
    const target = buildStoreImportTarget();
    const result = applyCsvImport(rows, target);
    setSummary(result);
  }

  const previewRows = rows.slice(0, PREVIEW_LIMIT);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4" data-testid="csv-import-panel">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Import products from a spreadsheet</h2>
        <p className="text-sm text-zinc-600">
          Select a CSV file with your product list. You will see a preview before anything is added.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-800 hover:bg-zinc-50"
        >
          Choose CSV file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="csv-import-file-input"
          className="hidden"
          onChange={(e) => void handleFileChange(e)}
        />
        {fileName && <span className="text-sm text-zinc-600">{fileName}</span>}
      </div>

      {parseErrorMsg && (
        <p className="text-sm text-red-600" data-testid="csv-import-parse-error">
          {parseErrorMsg}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-auto" data-testid="csv-import-preview">
          <p className="mb-1 text-sm font-semibold text-zinc-700">
            Preview ({Math.min(rows.length, PREVIEW_LIMIT)} of {rows.length} rows shown)
          </p>
          <table className="w-full border-collapse text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-zinc-700">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Barcode</th>
                <th className="px-3 py-2">Qty</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r, i) => (
                <tr key={i} data-testid={`csv-import-preview-row-${i}`} className="border-t border-zinc-100">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 font-mono">{r.sku ?? "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.barcode ?? "-"}</td>
                  <td className="px-3 py-2">{r.qty ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {errors.length > 0 && (
        <div data-testid="csv-import-errors" className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="mb-1 text-sm font-semibold text-amber-800">
            {errors.length} row{errors.length === 1 ? "" : "s"} could not be read
          </p>
          <ul className="flex flex-col gap-0.5 text-sm text-amber-800">
            {errors.map((e, i) => (
              <li key={i} data-testid={`csv-import-error-${i}`}>
                Line {e.line}: {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && !summary && (
        <button
          type="button"
          data-testid="csv-import-confirm"
          onClick={handleConfirm}
          className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-blue-600 bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700"
        >
          Import {rows.length} product{rows.length === 1 ? "" : "s"}
        </button>
      )}

      {summary && (
        <div data-testid="csv-import-summary" className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Import complete. {summary.created} product{summary.created === 1 ? "" : "s"} created,{" "}
          {summary.merged} merged into existing products, {summary.aliasesAdded} barcode
          {summary.aliasesAdded === 1 ? "" : "s"} added, {summary.skipped} row{summary.skipped === 1 ? "" : "s"} skipped.
        </div>
      )}
    </div>
  );
}
