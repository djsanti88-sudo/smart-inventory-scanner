"use client";

import { useEffect, useRef, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { countsForActiveSession } from "@/inventory/sessionCounts";
import { useShallow } from "zustand/react/shallow";
import { useAccessLevel } from "@/users-businesses/roles/useAccessLevel";
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
} from "@/reports/export/csvExport";
import { downloadCsv, downloadHtml, downloadPdf, downloadXlsx, parseCsv, type ExportMeta } from "@/reports/export/exportFormats";

// Unified "Export" menu. ONE dropdown replaces the row of CSV buttons. Datasets are grouped (Inventory /
// Activity / Catalog); each offers CSV / XLSX / PDF / interactive-HTML. CSV is the source of truth and
// already applies the customer/platform sanitization gate + injection guard; the other formats are derived
// from that same CSV (exportFormats.parseCsv), so none can leak a field CSV would not. The CSV chip keeps
// the dataset's LEGACY testid (export-final-counts, ...) so existing e2e/qa:bots keep working; the new
// formats add -xlsx / -pdf / -html suffixes.

type Fmt = "csv" | "xlsx" | "pdf" | "html";
interface Dataset { testid: string; title: string; filenameBase: string; rows: number; csv: () => string }

export function ExportMenu() {
  const s = useScanStore(useShallow((store) => ({
    businessId: store.businessId,
    sessionId: store.sessionId,
    currentSession: store.currentSession,
    pendingSyncQueue: store.pendingSyncQueue,
    finalCounts: store.finalCounts,
    products: store.products,
    scanFeed: store.scanFeed,
    needsReviewQueue: store.needsReviewQueue,
    aliases: store.aliases,
    auditCsvExport: store.auditCsvExport,
    importProductsCsv: store.importProductsCsv,
  })));
  const currentSession = s.currentSession;
  const level = useAccessLevel();
  const isPlatform = level === "platform";
  const activePendingQueue = s.pendingSyncQueue.filter((item) => item.businessId === s.businessId);

  // M2 fix (same leak class as F2/FinalCountTable): refreshFromCloud intentionally does an ADDITIVE
  // cross-session merge into finalCounts (a tested cross-device sync path - see
  // refreshFromCloud.store.test.ts). This menu must export only the CURRENT session's counts, not
  // every session's counts merged into the store.
  const sessionFinalCounts = countsForActiveSession(s.finalCounts, currentSession);

  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const [importMsg, setImportMsg] = useState("");
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "<testid>:<fmt>" while generating
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const closeDisclosure = () => {
      disclosureRef.current?.removeAttribute("open");
      triggerRef.current?.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (disclosureRef.current?.open && rootRef.current && !rootRef.current.contains(e.target as Node)) closeDisclosure();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && disclosureRef.current?.open) closeDisclosure();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, []);

  const groups: { group: string; datasets: Dataset[] }[] = isPlatform
    ? [
        { group: "Inventory", datasets: [
          { testid: "export-final-counts", title: "Final counts", filenameBase: "final-counts", rows: sessionFinalCounts.length, csv: () => exportFinalCounts(sessionFinalCounts, s.products, s.sessionId) },
          { testid: "export-qty-adjustments", title: "Quantity adjustments", filenameBase: "quantity-adjustments", rows: sessionFinalCounts.length, csv: () => exportQuantityAdjustments(sessionFinalCounts, s.products, s.sessionId) },
        ] },
        { group: "Activity", datasets: [
          { testid: "export-raw-log", title: "Raw scan log", filenameBase: "raw-scan-log", rows: s.scanFeed.length, csv: () => exportRawScanLog(s.scanFeed) },
          { testid: "export-unknowns", title: "Unrecognised codes", filenameBase: "unknown-codes", rows: s.needsReviewQueue.length, csv: () => exportUnknowns(s.needsReviewQueue) },
          { testid: "export-pending", title: "Items waiting to sync", filenameBase: "pending-sync", rows: activePendingQueue.length, csv: () => exportPendingQueue(activePendingQueue) },
        ] },
        { group: "Catalog", datasets: [
          { testid: "export-products", title: "Products", filenameBase: "products", rows: s.products.length, csv: () => exportProducts(s.products) },
          { testid: "export-aliases", title: "Barcode mappings", filenameBase: "aliases", rows: s.aliases.length, csv: () => exportAliases(s.aliases) },
        ] },
      ]
    : [
        { group: "Inventory", datasets: [
          { testid: "export-final-counts", title: "Final counts", filenameBase: "final-counts", rows: sessionFinalCounts.length, csv: () => exportFinalCountsCustomer(sessionFinalCounts, s.products, s.sessionId) },
          { testid: "export-qty-adjustments", title: "Quantity adjustments", filenameBase: "quantity-adjustments", rows: sessionFinalCounts.length, csv: () => exportQuantityAdjustmentsCustomer(sessionFinalCounts, s.products, s.sessionId) },
        ] },
        { group: "Activity", datasets: [
          { testid: "export-unknowns", title: "Items to check", filenameBase: "items-to-check", rows: s.needsReviewQueue.length, csv: () => exportUnknownsCustomer(s.needsReviewQueue) },
        ] },
      ];

  const meta = (d: Dataset): ExportMeta => ({
    title: d.title,
    businessName: "Smart Inventory Scanner",
    timestamp: new Date().toLocaleString(),
    filenameBase: d.filenameBase,
  });

  async function run(d: Dataset, fmt: Fmt) {
    const key = `${d.testid}:${fmt}`;
    setBusy(key); setError(null); setDone(null); setStatus(`Creating ${fmt.toUpperCase()} file.`);
    try {
      const csv = d.csv();
      if (fmt === "csv") downloadCsv(csv, d.filenameBase);
      else {
        const data = parseCsv(csv);
        if (fmt === "xlsx") await downloadXlsx(data, meta(d));
        else if (fmt === "pdf") await downloadPdf(data, meta(d));
        else await downloadHtml(data, meta(d));
      }
      s.auditCsvExport(d.testid, d.rows, fmt);
      setDone(key);
      setStatus(`Created ${fmt.toUpperCase()} file.`);
      setTimeout(() => setDone((cur) => (cur === key ? null : cur)), 1500);
    } catch (e) {
      const detail = e instanceof Error && e.message ? ` ${e.message.replace(/[. ]+$/, "")}.` : "";
      setError(`Could not create the ${fmt.toUpperCase()} file.${detail} Try again.`);
      setStatus("");
    } finally {
      setBusy((cur) => (cur === key ? null : cur));
    }
  }

  async function handleImport(file: File) {
    setImportMsg("");
    setImportError("");
    setStatus("Importing products CSV.");
    try {
      const text = await file.text();
      const r = s.importProductsCsv(text);
      const conflictNote = r.conflicts.length ? `, ${r.conflicts.length} conflict(s) skipped` : "";
      const dupNote = r.duplicates ? `, ${r.duplicates} duplicate(s)` : "";
      // QA Task 7 (owner decision): existing-barcode rows refresh descriptive fields only - never a
      // quantity implication in this copy.
      const refreshedNote = r.refreshed ? `, ${r.refreshed} matched existing product(s) (fields refreshed)` : "";
      setImportMsg(`Imported ${r.productsCreated} products and ${r.aliasesCreated} barcodes from ${r.rowsParsed} rows${dupNote}${refreshedNote}${conflictNote}.`);
      setStatus("Imported products CSV.");
    } catch {
      setImportError("Could not import products CSV. Choose a CSV file and try again.");
      setStatus("");
    }
  }

  const FORMATS: { fmt: Fmt; label: string }[] = [
    { fmt: "csv", label: "CSV" },
    { fmt: "xlsx", label: "XLSX" },
    { fmt: "pdf", label: "PDF" },
    { fmt: "html", label: "HTML" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3" ref={rootRef}>
      <details className="relative" ref={disclosureRef}>
        <summary
          ref={triggerRef}
          data-testid="export-menu-trigger"
          className="inline-flex min-h-[44px] list-none items-center gap-1.5 rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-800 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden"
        >
          Export <span aria-hidden className="text-zinc-500">▾</span>
        </summary>

        <div
          data-testid="export-menu"
          className="absolute left-0 z-20 mt-1 w-80 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg"
        >
            {groups.map((g) => (
              <fieldset key={g.group} className="mb-1 min-w-0 border-0 p-0 last:mb-0">
                <legend className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{g.group}</legend>
                {g.datasets.map((d) => (
                  <div key={d.testid} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                    <span className="min-w-0 truncate text-base text-zinc-800" title={`${d.title} (${d.rows})`}>
                      {d.title} <span className="text-sm text-zinc-500">({d.rows})</span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {FORMATS.map(({ fmt, label }) => {
                        const key = `${d.testid}:${fmt}`;
                        const isBusy = busy === key;
                        const isDone = done === key;
                        return (
                          <button
                            key={fmt}
                            type="button"
                            // CSV keeps the legacy dataset testid; other formats add a suffix.
                            data-testid={fmt === "csv" ? d.testid : `${d.testid}-${fmt}`}
                            disabled={d.rows === 0 || isBusy}
                            onClick={() => void run(d, fmt)}
                            className="min-h-[44px] min-w-[44px] rounded-lg border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-40"
                            title={`${label} - ${d.title}`}
                          >
                            {isBusy ? "..." : isDone ? "✓" : label}
                          </button>
                        );
                      })}
                    </span>
                  </div>
                ))}
              </fieldset>
            ))}
            {error && <p role="alert" className="px-2 py-1 text-sm text-red-600" data-testid="export-error">{error}</p>}
          </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium text-zinc-700">Import:</span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          data-testid="import-products"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
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
            e.target.value = "";
          }}
        />
        {importMsg && <span className="text-sm text-zinc-700" data-testid="import-result">{importMsg}</span>}
        {importError && <span role="alert" className="text-sm text-red-600" data-testid="import-error">{importError}</span>}
      </div>
      <span role="status" aria-live="polite" className="sr-only">{status}</span>
    </div>
  );
}
