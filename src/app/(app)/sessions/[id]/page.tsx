"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import type { SyncTarget } from "@/services/db/syncTarget";
import { downloadCsv } from "@/services/exportFormats";
import { getMockDb } from "@/services/mockDb";
import {
  exportSessionScanLog,
  exportSessionScanLogCustomer,
} from "@/services/csvExport";
import { useAccessLevel } from "@/services/security/useAccessLevel";
import { getDb } from "@/lib/firebaseClient";
import { useScanStore } from "@/stores/scanStore";
import { ArchivedSessionScans } from "@/components/ArchivedSessionScans";
import { SessionCountsTable, type SessionCountRow } from "@/components/SessionCountsTable";
import type { SessionHistoryEntry } from "@/services/sessions/sessionHistory";
import type { Product, ScanEvent } from "@/types";

const TIMELINE_UNAVAILABLE = "Session timeline is not available for this data source.";
const COUNTS_UNAVAILABLE = "Product counts are not available for this data source.";

// Derives the session's product-counts spreadsheet from its scan timeline: each product/code's
// session total is its chronologically LAST "known" event's quantityAfterScan (the ledger's running
// count at that point - see services/inventory.ts / scanStore processScan), not a sum of deltas.
// When an event's matchedProductId resolves through the store's getProduct (same selector the
// current-session path uses), the row carries the full product for the spreadsheet columns; it
// falls back to the event's cleanCode alone when the product is not in the store. No aliasesSeen:
// the timeline carries no alias data, so the table omits that column for past sessions.
// Exported for its unit test (SessionCountsTable.test.tsx).
export function countsFromTimeline(
  events: ScanEvent[],
  getProduct: (id: string | null) => Product | undefined,
): SessionCountRow[] {
  const byKey = new Map<string, ScanEvent>();
  for (const event of events) {
    if (event.status !== "known") continue;
    const key = event.matchedProductId ?? event.cleanCode;
    const prior = byKey.get(key);
    if (!prior || new Date(event.createdAt).getTime() >= new Date(prior.createdAt).getTime()) {
      byKey.set(key, event);
    }
  }
  return [...byKey.entries()].map(([key, event]) => ({
    id: key,
    code: event.cleanCode,
    quantity: event.quantityAfterScan,
    product: getProduct(event.matchedProductId),
    location: event.location,
    lastScannedAt: event.createdAt,
  }));
}

function normalizeEventCreatedAt(event: ScanEvent): ScanEvent {
  const value = event.createdAt as unknown;
  if (typeof value === "string") return event;
  if (value && typeof value === "object" && "toDate" in value) {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === "function") {
      const date = toDate.call(value);
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return { ...event, createdAt: date.toISOString() };
      }
    }
  }
  return event;
}

function getTimelineTarget(): SyncTarget {
  if (process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1") {
    return new FirebaseSyncTarget(getDb(), {
      emulator: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1",
    });
  }
  return getMockDb();
}

// Phase 3 session detail/timeline. The mock path reads the shared MockDb directly, while the cloud
// path uses the same FirebaseSyncTarget configuration as the scan store. The read capability remains
// optional so older or narrower SyncTarget implementations show an honest unavailable state.
export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const businessId = useScanStore((state) => state.businessId);
  const currentSession = useScanStore((state) => state.currentSession);
  const cloudSessions = useScanStore((state) => state.sessions);
  const listSessions = useScanStore((state) => state.listSessions);
  const finalCounts = useScanStore((state) => state.finalCounts);
  const getProduct = useScanStore((state) => state.getProduct);
  const sessionHistory: SessionHistoryEntry[] | undefined = useScanStore((state) => state.sessionHistory);
  const accessLevel = useAccessLevel();
  const [timeline, setTimeline] = useState<{
    sessionId: string;
    events: ScanEvent[] | null;
    error: string | null;
  }>({ sessionId, events: null, error: null });

  const events = timeline.sessionId === sessionId ? timeline.events : null;
  const error = timeline.sessionId === sessionId ? timeline.error : null;

  const session = (cloudSessions.length > 0 ? cloudSessions : listSessions())
    .find((candidate) => candidate.id === sessionId)
    ?? (currentSession?.id === sessionId ? currentSession : undefined);

  // Product counts: for the CURRENT session, finalCounts already carries the real product identity
  // (store's current-session-only ledger - see stores/scanStore.ts ~:1314), so it is the richer,
  // preferred source. For any other (past) session, finalCounts holds nothing (it is scoped to the
  // live session), so counts are derived from the same timeline read the page already performs.
  const isCurrentSession = currentSession?.id === sessionId;
  // Owner feature (2026-07-22): a PAST session's auto-saved archive (scanStore sessionHistory) is the
  // durable trace of what was scanned. When the live data source has no timeline for it (mock DB
  // reset by a reload; a source without the read capability), the archived scan spreadsheet renders
  // in the timeline's place instead of an empty/error state.
  const historyEntry = !isCurrentSession
    ? (sessionHistory ?? []).find((e) => e.sessionId === sessionId)
    : undefined;
  const showArchivedScans = !!historyEntry && (error !== null || (events !== null && events.length === 0));
  const countsUnavailable = !isCurrentSession && error === TIMELINE_UNAVAILABLE;
  const countRows: SessionCountRow[] | null = isCurrentSession
    ? finalCounts
        .filter((c) => c.sessionId === sessionId)
        .map((c) => {
          const product = getProduct(c.productId);
          return {
            id: c.id,
            code: product?.primaryBarcode ?? "",
            quantity: c.quantity,
            product,
            location: c.location,
            lastScannedAt: c.lastScannedAt,
            aliasesSeen: c.aliasesSeen,
          };
        })
    : events
      ? countsFromTimeline(events, getProduct)
      : null;

  useEffect(() => {
    let cancelled = false;

    void Promise.resolve()
      .then(() => {
        const target = getTimelineTarget();
        if (typeof target.getScanEventsBySession !== "function") {
          throw new Error(TIMELINE_UNAVAILABLE);
        }
        return target.getScanEventsBySession(businessId, sessionId);
      })
      .then((result) => {
        if (!cancelled) {
          setTimeline({ sessionId, events: result.map(normalizeEventCreatedAt), error: null });
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = cause instanceof Error && cause.message === TIMELINE_UNAVAILABLE
          ? TIMELINE_UNAVAILABLE
          : "Could not load this session's timeline.";
        setTimeline({ sessionId, events: [], error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [businessId, sessionId]);

  function exportTimeline() {
    if (!events?.length) return;
    const csv = accessLevel === "platform"
      ? exportSessionScanLog(events)
      : exportSessionScanLogCustomer(events);
    downloadCsv(csv, `session-${sessionId}-timeline`);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <Link href="/scan" className="text-sm text-blue-700 hover:underline">
        &larr; Back to scan
      </Link>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h1 className="text-xl font-semibold text-zinc-900" data-testid="session-detail-name">
          {session?.name ?? sessionId}
        </h1>
        {session && (
          <p className="text-sm text-zinc-600">
            {session.location} | {session.status} | {new Date(session.startedAt).toLocaleString()}
          </p>
        )}
        {events && events.length > 0 && (
          <button
            type="button"
            data-testid="export-session-timeline"
            onClick={exportTimeline}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Export timeline CSV
          </button>
        )}
      </div>

      {countsUnavailable ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-center text-zinc-600" data-testid="session-counts-unavailable">
          {COUNTS_UNAVAILABLE}
        </div>
      ) : (
        <SessionCountsTable rows={countRows ?? []} />
      )}

      {showArchivedScans && historyEntry ? (
        <ArchivedSessionScans entry={historyEntry} />
      ) : (
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm" data-testid="session-timeline-table">
          <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Qty</th>
              <th className="px-4 py-2">Location</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-red-600">
                  {error}
                </td>
              </tr>
            ) : events === null ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  Loading...
                </td>
              </tr>
            ) : events.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No scans in this session yet.
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.id} className="border-t border-zinc-100" data-testid={`timeline-row-${event.id}`}>
                  <td className="whitespace-nowrap px-4 py-2">{new Date(event.createdAt).toLocaleTimeString()}</td>
                  <td className="px-4 py-2 font-mono">{event.cleanCode}</td>
                  <td className="px-4 py-2">{event.status}</td>
                  <td className="px-4 py-2">{event.quantityAfterScan}</td>
                  <td className="px-4 py-2">{event.location ?? "Not recorded"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
