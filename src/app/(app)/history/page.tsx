"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getMockDb } from "@/sync-database/mock/mockDb";
import { exportSessionCounts } from "@/reports/export/csvExport";
import { downloadCsv } from "@/reports/export/exportFormats";
import { useAccessLevel } from "@/users-businesses/roles/useAccessLevel";
import { isLiveAuth } from "@/authentication/service/authMode";
import { isCloudBackendEnabled } from "@/sync-database/backend";
import { aggregateSessionCounts, aggregateHistoryRows, type SessionCountRow, type SessionAggregate } from "@/sessions/history/history";
import type { SessionHistoryEntry } from "@/sessions/history/sessionHistory";
import { BusinessContextGate } from "@/users-businesses/BusinessContextGate";
import { useScanStore } from "@/stores/scanStore";
import type { InventoryCount, InventorySession } from "@/types";

const COUNTS_UNAVAILABLE = "n/a";
const EMPTY_HISTORY: SessionHistoryEntry[] = [];

// History page: every saved session (active, completed, locked), newest first, with unit/product
// totals and a per-session counts CSV download. The active session's numbers come straight from the
// live store (finalCounts is reactive for the current session on both backends). Past sessions read
// their counts the same way the session detail page reads its timeline: mock hits getMockDb()
// directly (the real backing store there); cloud has no equivalent read capability on SyncTarget, so
// past-session counts on cloud are honestly "n/a" rather than a fake 0 (mirrors that page's
// TIMELINE_UNAVAILABLE pattern for a capability that data source does not support).
//
// Owner feature (2026-07-22): sessions also AUTO-SAVE. The store archives every session with at
// least one scan into `sessionHistory` the moment it ends or rotates away (scanStore
// archiveCurrentSessionIfAny), persisted across reloads on both backends. That archive is the
// PREFERRED source for a past session's numbers here (it survives a mock-DB reset and needs no
// cloud read), with the data-source reads above kept as the fallback; archived sessions the data
// source no longer knows about still get a row, so a past session always leaves a trace.
export default function HistoryPage() {
  const router = useRouter();
  const currentSession = useScanStore((s) => s.currentSession);
  const listSessions = useScanStore((s) => s.listSessions);
  const finalCounts = useScanStore((s) => s.finalCounts);
  const products = useScanStore((s) => s.products);
  // Guard: mocked/legacy states may lack the field; the real store always defines it.
  const sessionHistory = useScanStore((s) => s.sessionHistory) ?? EMPTY_HISTORY;
  const accessLevel = useAccessLevel();
  const cloudBackend = isCloudBackendEnabled();

  const refreshFromCloud = useScanStore((s) => s.refreshFromCloud);

  const sessions = listSessions();
  const historyBySessionId = new Map(sessionHistory.map((e) => [e.sessionId, e]));

  // Cloud backend: a past session's rows land in finalCounts (and its full session list lands in
  // `sessions`) only after a refreshFromCloud merge (additive cross-session - see
  // refreshFromCloud.store.test.ts). Fire that merge once per ready mount, UNCONDITIONALLY -
  // regardless of what this device already appears to know locally.
  //
  // LIVE-REPRODUCED DEFECT (2026-08-06): the previous version only fired when a past session it
  // ALREADY knew about (via listSessions()/sessionHistory) looked like it was missing local rows. On
  // a genuinely fresh device (local state cleared, or a brand-new device signing in for the first
  // time) both of those are empty - or contain only the just-auto-created current session - BEFORE
  // the very refresh that would populate them. That made the "missing past session" candidate set
  // always empty, so refreshFromCloud never ran, and a business with six completed cloud sessions
  // showed only its most recent (or just the freshly created) one. Firing unconditionally instead
  // (still only after businessContextReady, since refreshFromCloud no-ops before the context
  // resolves) closes that gap. refreshFromCloud is idempotent and generation-guarded, so a redundant
  // call when the device already had everything locally is harmless.
  const cloudRefreshFired = useRef(false);
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  useEffect(() => {
    if (!cloudBackend || cloudRefreshFired.current) return;
    if (isLiveAuth() && !businessContextReady) return; // wait for the gate; effect re-fires when ready
    cloudRefreshFired.current = true;
    void refreshFromCloud?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudBackend, businessContextReady]);

  // Past-session mock counts, fetched once per session id (not reactive - matches the detail page's
  // non-reactive timeline fetch). Keyed by sessionId -> rows, or null while unavailable/unfetched.
  const [pastCounts, setPastCounts] = useState<Record<string, InventoryCount[]>>({});

  useEffect(() => {
    if (cloudBackend) return; // cloud has no getSessionCounts; nothing to fetch here
    // Sessions with an auto-saved archive never need the mock read - the archive is authoritative.
    const missing = sessions.filter(
      (s) => s.id !== currentSession?.id && !historyBySessionId.has(s.id) && !(s.id in pastCounts),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const db = getMockDb();
      setPastCounts((prev) => {
        const next = { ...prev };
        for (const s of missing) {
          next[s.id] = db.getSessionCounts(s.id).map((c) => ({
            id: `count-${c.sessionId}-${c.productId}`,
            businessId: c.businessId,
            sessionId: c.sessionId,
            productId: c.productId,
            quantity: c.quantity,
            lastScannedAt: "",
            aliasesSeen: [],
            scanEventIds: c.scanEventIds,
            createdAt: "",
            updatedAt: "",
            syncStatus: "synced",
            syncError: null,
            appliedIdempotencyKeys: c.appliedIdempotencyKeys,
          }));
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudBackend, sessions.map((s) => s.id).join(","), currentSession?.id]);

  function countsFor(session: InventorySession): InventoryCount[] | null {
    if (session.id === currentSession?.id) return finalCounts.filter((c) => c.sessionId === session.id);
    if (cloudBackend) {
      // refreshFromCloud merges counts for every session it has seen into finalCounts, so a session
      // that has been refreshed at least once still resolves here; one truly never refreshed shows
      // as an honest "no rows found" (0 units / 0 products), which is what refreshFromCloud would
      // also produce once it runs - not a fabricated number.
      return finalCounts.filter((c) => c.sessionId === session.id);
    }
    return pastCounts[session.id] ?? null; // null = not fetched yet (still loading)
  }

  // Preferred numbers for a PAST session: its auto-saved archive (survives reloads and mock-DB
  // resets on every backend). Falls back to the data-source counts read when no archive exists
  // (pre-feature sessions), and to the honest "n/a" while that fallback is still loading.
  function aggregateFor(session: InventorySession, counts: InventoryCount[] | null): SessionAggregate | null {
    if (session.id !== currentSession?.id) {
      const archived = historyBySessionId.get(session.id);
      if (archived) return aggregateHistoryRows(archived.scanRows);
    }
    if (counts === null) return null;
    return aggregateSessionCounts(counts as SessionCountRow[]);
  }

  function exportSession(session: InventorySession, counts: InventoryCount[]) {
    const csv = exportSessionCounts(counts, products, accessLevel === "platform");
    downloadCsv(csv, `session-${session.id}-counts`);
  }

  // Auto-saved sessions the data source no longer returns (e.g. the mock DB reset by a reload) still
  // deserve a row - synthesize a completed session from the archive so its trace stays visible.
  const knownIds = new Set(sessions.map((s) => s.id));
  const archivedOnly: InventorySession[] = sessionHistory
    .filter((e) => !knownIds.has(e.sessionId))
    .map((e) => ({
      id: e.sessionId,
      businessId: "",
      name: "Saved session",
      location: "",
      status: "completed",
      startedAt: e.startedAt,
      completedAt: e.endedAt,
      createdBy: "",
      notes: "",
      syncStatus: "synced",
    } as InventorySession));

  const rows = [...sessions, ...archivedOnly].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  return (
    <BusinessContextGate>
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold text-zinc-900">History</h1>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[42rem] border-collapse text-left text-sm" data-testid="history-table">
          <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Hour</th>
              <th className="px-4 py-2">Units</th>
              <th className="px-4 py-2">Products</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody data-testid="history-body">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500" data-testid="history-empty">
                  No sessions yet. Start scanning to create your first session.
                </td>
              </tr>
            ) : (
              rows.map((session) => {
                const counts = countsFor(session);
                const aggregate = aggregateFor(session, counts);
                const started = new Date(session.startedAt);
                const dateLabel = Number.isNaN(started.getTime()) ? "Unknown" : started.toLocaleDateString();
                const hourLabel = Number.isNaN(started.getTime()) ? "" : started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const isActive = session.status === "active" && !session.locked;
                const isLocked = !!session.locked;
                const badge = isLocked
                  ? { label: "Locked", className: "bg-amber-100 text-amber-800" }
                  : isActive
                    ? { label: "Active", className: "bg-green-100 text-green-800" }
                    : { label: "Completed", className: "bg-zinc-100 text-zinc-700" };

                return (
                  <tr
                    key={session.id}
                    data-testid={`history-row-${session.id}`}
                    className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50"
                    onClick={() => router.push(`/sessions/${session.id}`)}
                  >
                    <td className="px-4 py-2">{dateLabel}</td>
                    <td className="whitespace-nowrap px-4 py-2">{hourLabel}</td>
                    <td className="px-4 py-2" data-testid={`history-units-${session.id}`}>
                      {aggregate === null ? COUNTS_UNAVAILABLE : aggregate.units}
                    </td>
                    <td className="px-4 py-2" data-testid={`history-products-${session.id}`}>
                      {aggregate === null ? COUNTS_UNAVAILABLE : aggregate.distinctProducts}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        data-testid={`history-download-${session.id}`}
                        aria-label={`Download counts for ${session.name || session.id}`}
                        disabled={!counts || counts.length === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (counts) exportSession(session, counts);
                        }}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                          <path d="M10 3a.75.75 0 01.75.75v7.19l2.22-2.22a.75.75 0 111.06 1.06l-3.5 3.5a.75.75 0 01-1.06 0l-3.5-3.5a.75.75 0 111.06-1.06l2.22 2.22V3.75A.75.75 0 0110 3z" />
                          <path d="M3.5 12.75a.75.75 0 01.75.75v2a1 1 0 001 1h9.5a1 1 0 001-1v-2a.75.75 0 011.5 0v2a2.5 2.5 0 01-2.5 2.5h-9.5A2.5 2.5 0 012.75 15.5v-2a.75.75 0 01.75-.75z" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Link href="/scan" className="text-sm text-blue-700 hover:underline">
        &larr; Back to scan
      </Link>
    </div>
    </BusinessContextGate>
  );
}
