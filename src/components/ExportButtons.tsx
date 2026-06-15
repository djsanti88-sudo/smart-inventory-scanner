"use client";

import { useRef, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useAccessLevel } from "@/services/security/useAccessLevel";
import {
  exportAliases,
  exportFinalCounts,
  exportFinalCountsCustomer,
  exportPendingQueue,
  exportProducts,
  exportQuantityAdjustments,
  exportQuantityAdjustmentsCustomer,
  exportRawScanLog,
  exportUnknowns,
  exportUnknownsCustomer,
} from "@/services/csvExport";

function download(filename: string, csv: string) {
  if (typeof document === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSV export + import. Works entirely from local session state, so it still works while sync is pending.
// Exports are audited (auditCsvExport); imports go through the durable queue + audit (importProductsCsv).
export function ExportButtons() {
  const s = useScanStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState("");

  // platformOwner (Santiago) gets full internal exports; every customer role gets sanitized,
  // product-facing exports only (no barcode/gtin/upc/ean/aliases/raw codes). Server/serializer-enforced
  // truth lives in the export builders; this gate also hides code-only export buttons from customers.
  const level = useAccessLevel();
  const isPlatform = level === "platform";

  const platformButtons: Array<{ label: string; testid: string; rows: number; run: () => void }> = [
    { label: "Final counts CSV", testid: "export-final-counts", rows: s.finalCounts.length, run: () => download("final-counts.csv", exportFinalCounts(s.finalCounts, s.products, s.sessionId)) },
    { label: "Quantity adjustments CSV", testid: "export-qty-adjustments", rows: s.finalCounts.length, run: () => download("quantity-adjustments.csv", exportQuantityAdjustments(s.finalCounts, s.products, s.sessionId)) },
    { label: "Raw scan log", testid: "export-raw-log", rows: s.scanFeed.length, run: () => download("raw-scan-log.csv", exportRawScanLog(s.scanFeed)) },
    { label: "Unknowns", testid: "export-unknowns", rows: s.needsReviewQueue.length, run: () => download("unknown-codes.csv", exportUnknowns(s.needsReviewQueue)) },
    { label: "Products", testid: "export-products", rows: s.products.length, run: () => download("products.csv", exportProducts(s.products)) },
    { label: "Aliases", testid: "export-aliases", rows: s.aliases.length, run: () => download("aliases.csv", exportAliases(s.aliases)) },
    { label: "Pending queue", testid: "export-pending", rows: s.pendingSyncQueue.length, run: () => download("pending-sync.csv", exportPendingQueue(s.pendingSyncQueue)) },
  ];
  const customerButtons: Array<{ label: string; testid: string; rows: number; run: () => void }> = [
    { label: "Final counts CSV", testid: "export-final-counts", rows: s.finalCounts.length, run: () => download("final-counts.csv", exportFinalCountsCustomer(s.finalCounts, s.products, s.sessionId)) },
    { label: "Quantity adjustments CSV", testid: "export-qty-adjustments", rows: s.finalCounts.length, run: () => download("quantity-adjustments.csv", exportQuantityAdjustmentsCustomer(s.finalCounts, s.products, s.sessionId)) },
    { label: "Unknowns", testid: "export-unknowns", rows: s.needsReviewQueue.length, run: () => download("unknown-codes.csv", exportUnknownsCustomer(s.needsReviewQueue)) },
  ];
  const buttons = isPlatform ? platformButtons : customerButtons;

  async function handleImport(file: File) {
    const text = await file.text();
    const r = s.importProductsCsv(text);
    const conflictNote = r.conflicts.length ? `, ${r.conflicts.length} conflict(s) skipped` : "";
    const dupNote = r.duplicates ? `, ${r.duplicates} duplicate(s)` : "";
    setImportMsg(`Imported ${r.productsCreated} product(s), ${r.aliasesCreated} alias(es) from ${r.rowsParsed} row(s)${dupNote}${conflictNote}.`);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-700">Export:</span>
        {buttons.map((b) => (
          <button
            key={b.testid}
            type="button"
            onClick={() => { b.run(); s.auditCsvExport(b.testid, b.rows); }}
            data-testid={b.testid}
            className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-700">Import:</span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          data-testid="import-products"
          className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Products CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="import-products-input"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = ""; // allow re-importing the same file
          }}
        />
        {importMsg && <span className="text-xs text-zinc-600" data-testid="import-result">{importMsg}</span>}
      </div>
    </div>
  );
}
