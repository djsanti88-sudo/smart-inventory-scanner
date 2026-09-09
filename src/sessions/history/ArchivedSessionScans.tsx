"use client";

import type { SessionHistoryEntry } from "@/sessions/history/sessionHistory";

// Owner feature (2026-07-22): the read-only scan spreadsheet for a session that has already ended,
// rendered from its automatically saved sessionHistory entry (services/sessions/sessionHistory.ts).
// Used by the session detail page as the fallback when the live data source has no timeline for a
// past session (mock DB reset by a reload; cloud source without the timeline capability) - the
// archived trace is the shop's own record of exactly what was scanned, row by row.

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
}

export function ArchivedSessionScans({ entry }: { entry: SessionHistoryEntry }) {
  const displayedScanCount = entry.displayedScanCount ?? entry.scanRows.length;
  const scanRowsCapped = entry.scanRowsCapped ?? displayedScanCount < entry.totalScans;

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white" data-testid="session-archived-scans">
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-600">
        Saved scan log for this session ({entry.totalScans} scans, {entry.totalUnits} units)
      </div>
      {scanRowsCapped && (
        <div
          className="border-b border-zinc-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
          data-testid="archived-scan-cap-notice"
        >
          Showing the most recent {displayedScanCount} of {entry.totalScans} scans.
        </div>
      )}
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
          <tr>
            <th scope="col" className="px-4 py-2">Time</th>
            <th scope="col" className="px-4 py-2">Barcode</th>
            <th scope="col" className="px-4 py-2">Product</th>
            <th scope="col" className="px-4 py-2">Qty</th>
          </tr>
        </thead>
        <tbody>
          {entry.scanRows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                No scans recorded for this session.
              </td>
            </tr>
          ) : (
            entry.scanRows.map((row, i) => (
              <tr key={`${entry.sessionId}-${i}`} className="border-t border-zinc-100" data-testid={`archived-scan-row-${i}`}>
                <td className="whitespace-nowrap px-4 py-2">{formatTime(row.time)}</td>
                <td className="px-4 py-2 font-mono">{row.code}</td>
                <td className="px-4 py-2">{row.productName}</td>
                <td className="px-4 py-2 tabular-nums">{row.quantityDelta}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
