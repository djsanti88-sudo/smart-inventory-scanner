// Session history: a read-only, automatically saved record of past scan sessions, so a shop owner can
// look back at what was scanned in a session that has ended without doing anything themselves. Pure and
// framework-free so it is unit-testable in isolation (no store, no localStorage).
//
// Caps (documented, generous but bounded so the persisted blob never grows without limit):
//   - SESSION_HISTORY_CAP: most recent 50 sessions kept (oldest dropped beyond that).
//   - SESSION_HISTORY_ROWS_CAP: most recent 5000 scan rows kept per session (oldest dropped beyond
//     that; a session this large is already an extreme outlier, and the live scanFeed itself is
//     unbounded in memory, so this only bounds what is archived to history).
import type { InventorySession, ScanEvent } from "@/types";

export const SESSION_HISTORY_CAP = 50;
export const SESSION_HISTORY_ROWS_CAP = 5000;

export interface SessionHistoryRow {
  time: string;
  code: string;
  productName: string;
  quantityDelta: number;
}

export interface SessionHistoryEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  scanRows: SessionHistoryRow[];
  totalScans: number;
  totalUnits: number;
}

/**
 * Build a SessionHistoryEntry from a session and its live scan feed at the moment it ends/rotates.
 * Returns null for a session with zero scans (an empty session is not recorded, per the owner's design).
 * `getProductName` resolves a matchedProductId to a display name; pass a lookup closure so this stays
 * pure and store-agnostic. `endedAt` defaults to now via the caller-supplied ISO string.
 */
export function buildSessionHistoryEntry(
  session: Pick<InventorySession, "id" | "startedAt">,
  scanFeed: ScanEvent[],
  getProductName: (matchedProductId: string | null) => string,
  endedAt: string,
): SessionHistoryEntry | null {
  if (scanFeed.length === 0) return null;
  // scanFeed is newest-first (store convention); history rows read oldest-first, like a spreadsheet log.
  const chronological = [...scanFeed].reverse();
  const capped = chronological.length > SESSION_HISTORY_ROWS_CAP
    ? chronological.slice(chronological.length - SESSION_HISTORY_ROWS_CAP)
    : chronological;
  const scanRows: SessionHistoryRow[] = capped.map((e) => ({
    time: e.createdAt,
    code: e.cleanCode || e.rawCode,
    productName: getProductName(e.matchedProductId),
    quantityDelta: e.quantityDelta ?? 0,
  }));
  const totalUnits = scanRows.reduce((sum, r) => sum + r.quantityDelta, 0);
  return {
    sessionId: session.id,
    startedAt: session.startedAt,
    endedAt,
    scanRows,
    totalScans: scanRows.length,
    totalUnits,
  };
}

/** Prepend a new entry (newest-first) and cap the list at SESSION_HISTORY_CAP, dropping the oldest. */
export function appendSessionHistory(
  existing: SessionHistoryEntry[],
  entry: SessionHistoryEntry,
): SessionHistoryEntry[] {
  const next = [entry, ...existing];
  return next.length > SESSION_HISTORY_CAP ? next.slice(0, SESSION_HISTORY_CAP) : next;
}
