"use client";

import { useState } from "react";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";

// Owner feature (2026-07-22): a shop owner's automatically saved log of past scan sessions. Every
// session is saved on its own, so there is nothing to set up or turn on. Top: a list of sessions
// (Date, Started, Ended, Scans, Units). The live session is shown first, labeled clearly, and links
// to the scan page. Clicking a past session expands its scan rows (Time, Barcode, Product, Qty) -
// read-only, like the live feed but for a session that has already ended.

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
}

export function HistoryView() {
  const sessionHistory = useScanStore((s) => s.sessionHistory);
  const currentSession = useScanStore((s) => s.currentSession);
  const scanFeed = useScanStore((s) => s.scanFeed);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const hasCurrentActivity = !!currentSession;
  const noHistoryAtAll = sessionHistory.length === 0 && !hasCurrentActivity;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold text-zinc-900">Scan history</h1>
      <p className="text-sm text-zinc-600">
        Every count is saved on its own. Click a session below to see exactly what was scanned.
      </p>

      {noHistoryAtAll ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-600">
          No past sessions yet. Start scanning to build your history.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div
            className="overflow-auto"
            tabIndex={0}
            role="region"
            aria-label="Scan history table, scroll horizontally for more columns"
          >
            <table className="w-full border-collapse text-left text-base">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
                <tr>
                  <th scope="col" className="px-4 py-3">Date</th>
                  <th scope="col" className="px-4 py-3">Started</th>
                  <th scope="col" className="px-4 py-3">Ended</th>
                  <th scope="col" className="px-4 py-3">Scans</th>
                  <th scope="col" className="px-4 py-3">Units</th>
                </tr>
              </thead>
              <tbody>
                {hasCurrentActivity && (
                  <tr className="border-t border-zinc-100 bg-blue-50/40" data-testid="history-current-session">
                    <td className="px-4 py-3">{formatDate(currentSession!.startedAt)}</td>
                    <td className="px-4 py-3">{formatTime(currentSession!.startedAt)}</td>
                    <td className="px-4 py-3">
                      <Link href="/scan" className="font-medium text-blue-700 hover:underline">
                        Current session, still going
                      </Link>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{scanFeed.length}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {scanFeed.reduce((sum, e) => sum + (e.quantityDelta ?? 0), 0)}
                    </td>
                  </tr>
                )}
                {sessionHistory.map((entry) => {
                  const isOpen = openSessionId === entry.sessionId;
                  return (
                    <>
                      <tr
                        key={entry.sessionId}
                        className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50"
                        data-testid={`history-session-${entry.sessionId}`}
                        onClick={() => setOpenSessionId(isOpen ? null : entry.sessionId)}
                      >
                        <td className="px-4 py-3">{formatDate(entry.startedAt)}</td>
                        <td className="px-4 py-3">{formatTime(entry.startedAt)}</td>
                        <td className="px-4 py-3">{formatTime(entry.endedAt)}</td>
                        <td className="px-4 py-3 tabular-nums">{entry.totalScans}</td>
                        <td className="px-4 py-3 tabular-nums">{entry.totalUnits}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-zinc-100 bg-zinc-50">
                          <td colSpan={5} className="px-4 py-3">
                            <div
                              className="max-h-72 overflow-auto rounded border border-zinc-200 bg-white"
                              data-testid={`history-detail-${entry.sessionId}`}
                            >
                              <table className="w-full border-collapse text-left text-sm">
                                <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
                                  <tr>
                                    <th scope="col" className="px-3 py-2">Time</th>
                                    <th scope="col" className="px-3 py-2">Barcode</th>
                                    <th scope="col" className="px-3 py-2">Product</th>
                                    <th scope="col" className="px-3 py-2">Qty</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entry.scanRows.length === 0 ? (
                                    <tr>
                                      <td colSpan={4} className="px-3 py-4 text-center text-zinc-500">
                                        No scans recorded for this session.
                                      </td>
                                    </tr>
                                  ) : (
                                    entry.scanRows.map((row, i) => (
                                      <tr key={`${entry.sessionId}-${i}`} className="border-t border-zinc-100">
                                        <td className="px-3 py-2">{formatTime(row.time)}</td>
                                        <td className="px-3 py-2 font-mono">{row.code}</td>
                                        <td className="px-3 py-2">{row.productName}</td>
                                        <td className="px-3 py-2 tabular-nums">{row.quantityDelta}</td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
