"use client";

import { useScanStore } from "@/stores/scanStore";
import {
  exportAliases,
  exportFinalCounts,
  exportPendingQueue,
  exportProducts,
  exportRawScanLog,
  exportUnknowns,
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

// CSV export. Works entirely from local session state, so it still works while sync is pending.
export function ExportButtons() {
  const s = useScanStore();

  const buttons: Array<{ label: string; testid: string; run: () => void }> = [
    {
      label: "Final counts CSV",
      testid: "export-final-counts",
      run: () => download("final-counts.csv", exportFinalCounts(s.finalCounts, s.products, s.sessionId)),
    },
    {
      label: "Raw scan log",
      testid: "export-raw-log",
      run: () => download("raw-scan-log.csv", exportRawScanLog(s.scanFeed)),
    },
    {
      label: "Unknowns",
      testid: "export-unknowns",
      run: () => download("unknown-codes.csv", exportUnknowns(s.needsReviewQueue)),
    },
    {
      label: "Products",
      testid: "export-products",
      run: () => download("products.csv", exportProducts(s.products)),
    },
    {
      label: "Aliases",
      testid: "export-aliases",
      run: () => download("aliases.csv", exportAliases(s.aliases)),
    },
    {
      label: "Pending queue",
      testid: "export-pending",
      run: () => download("pending-sync.csv", exportPendingQueue(s.pendingSyncQueue)),
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-zinc-700">Export:</span>
      {buttons.map((b) => (
        <button
          key={b.testid}
          type="button"
          onClick={b.run}
          data-testid={b.testid}
          className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
