"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { computeVariance, exportVarianceCsv } from "@/reports/variance/varianceReport";
import { downloadCsv } from "@/reports/export/exportFormats";

// SDD Task 3.5: count snapshots + variance/shrinkage report. "Save count snapshot" captures the
// current finalCounts; the compare view picks any two saved snapshots and shows what changed
// (added / removed / changed / unchanged - unchanged rows are included, see varianceReport.ts).
// Product-facing fields only (name + quantities) - no barcode/cleanCode/matchType/provider columns,
// following the same customer-data-firewall convention as FinalCountTable/csvExport (this report
// never touches raw scanned codes in the first place, since CountSnapshot lines only carry
// productId/name/qty).

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

export function VarianceReport() {
  const countSnapshots = useScanStore((s) => s.countSnapshots);
  const snapshotCount = useScanStore((s) => s.snapshotCount);
  const [label, setLabel] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");

  const onSave = () => {
    const snap = snapshotCount(label.trim() || `Count ${new Date().toLocaleString()}`);
    setLabel("");
    // Convenience: default the compare-to selection to the just-saved snapshot so the report is one
    // click away from useful once a second snapshot exists.
    setToId(snap.id);
  };

  const from = countSnapshots.find((s) => s.id === fromId);
  const to = countSnapshots.find((s) => s.id === toId);
  const rows = from && to ? computeVariance(from, to) : null;

  const onExport = () => {
    if (!rows) return;
    downloadCsv(exportVarianceCsv(rows), "variance-report");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <h2 className="text-lg font-semibold text-zinc-900">Variance report</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            aria-label="snapshot label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Snapshot label (optional)"
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
          />
          <button
            type="button"
            data-testid="save-count-snapshot"
            onClick={onSave}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 active:scale-95"
          >
            Save count snapshot
          </button>
        </div>
      </div>

      {countSnapshots.length < 2 ? (
        <p data-testid="variance-empty-state" className="px-4 py-6 text-base text-zinc-600">
          Save at least two count snapshots to compare them and see what changed.
        </p>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="variance-from" className="text-xs font-medium text-zinc-600">
                Compare from
              </label>
              <select
                id="variance-from"
                data-testid="variance-from"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
                className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
              >
                <option value="">Select a snapshot</option>
                {countSnapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({new Date(s.takenAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="variance-to" className="text-xs font-medium text-zinc-600">
                Compare to
              </label>
              <select
                id="variance-to"
                data-testid="variance-to"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
              >
                <option value="">Select a snapshot</option>
                {countSnapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({new Date(s.takenAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid="export-variance-csv"
              onClick={onExport}
              disabled={!rows}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>

          {rows && (
            <div className="overflow-auto">
              <table className="w-full border-collapse text-left text-base" data-testid="variance-table">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
                  <tr>
                    <th scope="col" className="px-4 py-3">Product</th>
                    <th scope="col" className="px-4 py-3">Previous qty</th>
                    <th scope="col" className="px-4 py-3">Current qty</th>
                    <th scope="col" className="px-4 py-3">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-base text-zinc-600">
                        No products in either snapshot.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r.productId} className="border-t border-zinc-100">
                        <td className="px-4 py-3 font-medium text-zinc-800">{r.name}</td>
                        <td className="px-4 py-3 tabular-nums">{r.prevQty}</td>
                        <td className="px-4 py-3 tabular-nums">{r.currQty}</td>
                        <td
                          className={`px-4 py-3 font-semibold tabular-nums ${
                            r.delta > 0 ? "text-green-700" : r.delta < 0 ? "text-red-700" : "text-zinc-600"
                          }`}
                        >
                          {formatDelta(r.delta)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
